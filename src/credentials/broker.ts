// The broker: the only code in this system that both holds a credential and
// touches a page (SPEC 29 §2, §9).
//
// Read the gate order in `attemptLogin` before anything else — it is the
// design. Each step is cheap-and-harmless before it is expensive-and-sensitive:
//
//   1. scan the page            — milliseconds, reads the DOM, touches no secret
//   2. no form?                 → stop. Nothing else ran.
//   3. page not https?          → stop. No vault call.
//   4. match the vault by URL   — the URL comes from the BROWSER, never the model
//   5. no match?                → stop. The user is not told which items exist.
//   6. ask the user             → the approval prompt fires HERE, and not before
//   7. approved                 → fetch, type, forget
//
// That order is what makes a mistaken call free: an agent that calls this on a
// news article gets "not a login page" and nothing has happened — no unlock
// prompt, no vault read, no dialog. It is also what keeps an INJECTED call
// harmless: the page a malicious instruction is written on is the page whose
// URL step 4 matches, so the only credential reachable is the one already
// stored for that page.

import type { Frame, Page } from 'playwright';
import {
  isRealPasswordField,
  scanForLogin,
  submitLogin,
  typeInto,
  type LoginScan,
} from './login-fields.js';
import { hostOf, itemsCoveringHost, pageIsFillable } from './domain-match.js';
import type {
  ApprovalProvider,
  LoginResult,
  VaultItem,
  VaultProvider,
} from './types.js';
import { VaultError } from './types.js';

/**
 * How long one approval covers (§10).
 *
 * A login is several pages — email, password, one-time code — and asking three
 * times for one sign-in would train the user to click Allow without reading.
 * One grant, scoped to the domain the user actually saw and to the item they
 * actually chose, covers the journey; a later login on the same site asks
 * again once it lapses.
 */
export const GRANT_TTL_MS = 120_000;

/** An approval the user has already given, still in force. */
interface Grant {
  host: string;
  itemId: string;
  itemName: string;
  expiresAt: number;
}

/** An agent's optional pointer at a field our heuristics could not read (§7). */
export interface FieldHint {
  username?: string | undefined;
  password?: string | undefined;
  otp?: string | undefined;
}

export interface BrokerDeps {
  vault: VaultProvider;
  approval: ApprovalProvider;
  /** Raise the unlock prompt and unlock the vault. Absent = never prompt. */
  unlockVault?: (() => Promise<boolean>) | undefined;
  /** True when a session key is held. Consulted before every vault call. */
  vaultUnlocked?: (() => boolean) | undefined;
  /** Injected so grant expiry is testable without waiting two minutes. */
  now?: (() => number) | undefined;
}

function result(
  outcome: LoginResult['outcome'],
  domain: string,
  detail: string,
  extra: Partial<LoginResult> = {},
): LoginResult {
  return { outcome, domain, detail, continues: false, ...extra };
}

export class LoginBroker {
  private readonly deps: BrokerDeps;
  private readonly grants = new Map<string, Grant>();

  constructor(deps: BrokerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private liveGrant(host: string): Grant | null {
    const grant = this.grants.get(host);
    if (!grant) return null;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(host);
      return null;
    }
    return grant;
  }

  /**
   * One `log_into_site` call: fill what this page asks for, and say what
   * happened. Never fills more than one page — the agent drives between them
   * (§8), and every call re-runs the domain rule from scratch.
   */
  async attemptLogin(page: Page, hint?: FieldHint): Promise<LoginResult> {
    // ---- Gate 1: read the page. No secret is involved and nothing is opened.
    const scan = await scanForLogin(page);
    const host = hostOf(scan.url) ?? '';

    if (scan.status === 'scan-failed') {
      return result('stuck', host, `The page could not be read: ${scan.note}`);
    }
    if (scan.status === 'registration-form') {
      // Refused by rule, not by guesswork. Filling the CURRENT password into a
      // change-password form and submitting is the worst thing this code could
      // do, and it is one heuristic slip away at all times.
      return result('stuck', host, scan.note);
    }
    if (scan.status === 'no-form' && !hint?.username && !hint?.password) {
      return result(
        'not-a-login-page',
        host,
        `No sign-in form here (${scan.visibleInputs} visible input${scan.visibleInputs === 1 ? '' : 's'}). ` +
          `Nothing was unlocked or read.`,
      );
    }

    // ---- Gate 2: is this page fillable at all, whatever the vault holds?
    const unfillable = pageIsFillable(scan.url);
    if (unfillable === 'not-http') {
      return result('stuck', host, `This is not a web page a credential can belong to (${scan.url.slice(0, 60)}).`);
    }
    if (unfillable === 'insecure') {
      return result(
        'stuck',
        host,
        `${host} was served over plain http, so a password typed here would cross the network in the clear. Refused.`,
      );
    }
    if (!host) {
      return result('stuck', '', 'The page has no host to match a credential against.');
    }

    // ---- Gate 3: the vault. Locked vaults prompt; absent vaults say so.
    const unlocked = this.deps.vaultUnlocked?.() ?? true;
    if (!unlocked) {
      if (!this.deps.unlockVault) {
        return result('vault-locked', host, 'The vault is locked and no unlock prompt is configured.');
      }
      const opened = await this.deps.unlockVault();
      if (!opened) {
        return result('vault-locked', host, 'The vault is locked. Ask the user to unlock Bitwarden, then try again.');
      }
    }

    // ---- Gate 4: match by the URL the BROWSER reported. Never the model's.
    let candidates: VaultItem[];
    try {
      candidates = await this.deps.vault.itemsForUrl(scan.url);
    } catch (err) {
      return this.vaultFailure(err, host);
    }
    // Re-checked here rather than trusted from the vault's own matching, for
    // the reason `itemsCoveringHost` documents: per-item match modes make the
    // vault's answer configurable, and this rule must not be.
    const matches = itemsCoveringHost(candidates, host);
    if (matches.length === 0) {
      return result(
        'no-credential-for-this-site',
        host,
        `A sign-in form is here, but no saved login covers ${host}. ` +
          `Tell the user to add one to Bitwarden — do not ask them for the password.`,
      );
    }

    // ---- Gate 5: the user. A live grant from this same login journey stands in.
    const framedBy = this.framedBy(scan);
    let grant = this.liveGrant(host);
    if (!grant || !matches.some((m) => m.id === grant?.itemId)) {
      const decision = await this.deps.approval.ask({
        domain: host,
        framedBy,
        items: matches.map((m) => m.name),
      });
      if (decision.unavailable) {
        return result('denied', host, decision.unavailable, { candidates: matches.map((m) => m.name) });
      }
      if (!decision.allowed) {
        return result('denied', host, `The user denied the sign-in to ${host}.`, {
          candidates: matches.map((m) => m.name),
        });
      }
      const chosen = matches[decision.chosen] ?? matches[0];
      if (!chosen) return result('stuck', host, 'The approved item vanished between asking and using it.');
      grant = {
        host,
        itemId: chosen.id,
        itemName: chosen.name,
        expiresAt: this.now() + GRANT_TTL_MS,
      };
      this.grants.set(host, grant);
    }

    const item = matches.find((m) => m.id === grant.itemId) ?? matches[0];
    if (!item) return result('stuck', host, 'The approved item is no longer in the vault.');

    // ---- Gate 6: fill. Only now does a secret exist in this process.
    try {
      return await this.fill(scan, item, host, framedBy, hint);
    } catch (err) {
      // A throw from here is a page that would not be typed into — a field that
      // never became actionable, a navigation mid-fill, a detached frame.
      //
      // It has to be an OUTCOME rather than a rejection, because by this point
      // a credential may be partly entered, and the difference between "nothing
      // happened" and "half your password is in a box on screen" is the whole
      // of what the user needs to know. A 500 would tell them the former.
      const detail = err instanceof Error ? err.message : String(err);
      return result(
        'stuck',
        host,
        `The form on ${host} could not be filled: ${detail.split('\n')[0]}. ` +
          `Some of the sign-in may already be entered — check the page before retrying.`,
        { item: item.name },
      );
    }
  }

  /** Which host is framing the form, when that is not the form's own host. */
  private framedBy(scan: LoginScan): string | undefined {
    const top = hostOf(scan.topUrl);
    const own = hostOf(scan.url);
    if (!top || !own || top === own) return undefined;
    return top;
  }

  private vaultFailure(err: unknown, host: string): LoginResult {
    if (err instanceof VaultError) {
      switch (err.kind) {
        case 'cli-missing':
          return result(
            'vault-unavailable',
            host,
            'The Bitwarden CLI is not installed on this machine, so there is no vault to read. ' +
              'Tell the user to install it and sign in.',
          );
        case 'not-logged-in':
          return result('vault-unavailable', host, 'Bitwarden is installed but no account is signed in.');
        case 'locked':
          return result('vault-locked', host, 'The vault locked again before the lookup ran.');
        default:
          return result('vault-unavailable', host, `The vault could not be read: ${err.message}`);
      }
    }
    return result('vault-unavailable', host, `The vault could not be read: ${String(err)}`);
  }

  /**
   * Type what this page asks for.
   *
   * The three shapes it handles are the three pages a modern login is spread
   * across (§8): username-then-next, password, one-time code. Each returns a
   * distinct outcome so the agent knows whether to advance and call again.
   */
  private async fill(
    scan: LoginScan,
    item: VaultItem,
    host: string,
    framedBy: string | undefined,
    hint: FieldHint | undefined,
  ): Promise<LoginResult> {
    const frame = scan.frame;
    const base = { item: item.name, ...(framedBy ? { framedBy } : {}) };

    // A one-time-code page. Handled before the password arms, because a TOTP
    // page has no password box and would otherwise fall through to "stuck".
    const otpSelector = hint?.otp ?? scan.otp?.selector ?? null;
    if (scan.status === 'otp-only' && otpSelector) {
      if (!item.hasTotp) {
        return result('stuck', host, `${host} is asking for a one-time code, and "${item.name}" has no TOTP secret saved. The user needs to enter this one.`, base);
      }
      const code = await this.deps.vault.totpFor(item.id);
      if (!code) {
        return result('stuck', host, `Bitwarden could not produce a one-time code for "${item.name}".`, base);
      }
      await typeInto(frame, otpSelector, code);
      await this.submit(frame, scan, otpSelector);
      return result('otp-entered-continue', host, `Entered the one-time code from "${item.name}".`, {
        ...base,
        continues: true,
      });
    }

    const usernameSelector = hint?.username ?? scan.username?.selector ?? null;
    const passwordSelector = hint?.password ?? scan.password?.selector ?? null;

    // Page one of a two-page login: a username field and nowhere to put a
    // password yet.
    if (!passwordSelector && usernameSelector) {
      const secret = await this.deps.vault.secretFor(item.id);
      if (secret.username === '') {
        return result('stuck', host, `"${item.name}" has no username saved.`, base);
      }
      await typeInto(frame, usernameSelector, secret.username);
      await this.submit(frame, scan, usernameSelector);
      return result(
        'username-entered-continue',
        host,
        `Entered the username from "${item.name}" and advanced. Wait for the next page, then call log_into_site again.`,
        { ...base, continues: true },
      );
    }

    if (!passwordSelector) {
      return result('stuck', host, `Nothing on ${host} looks like a field this can fill.`, base);
    }

    // THE rule (§7): a password goes into a real password box or nowhere. This
    // is re-checked in the page at the moment of typing, so neither a stale
    // selector nor an agent-supplied hint can widen where it lands.
    if (!(await isRealPasswordField(frame, passwordSelector))) {
      return result(
        'stuck',
        host,
        'The field this would have typed the password into is not a password box, so nothing was entered.',
        base,
      );
    }

    const secret = await this.deps.vault.secretFor(item.id);
    if (secret.password === '') {
      return result('stuck', host, `"${item.name}" has no password saved.`, base);
    }

    if (usernameSelector && secret.username !== '') {
      await typeInto(frame, usernameSelector, secret.username);
    }
    await typeInto(frame, passwordSelector, secret.password);
    await this.submit(frame, scan, passwordSelector);

    // "Submitted", not "signed in" — whether the site accepted the credential
    // is the next page's news, and claiming success here would have the agent
    // report a login that may have bounced. The agent reads the page next.
    return result(
      'logged-in',
      host,
      `Entered the saved login "${item.name}" for ${host} and submitted the form. ` +
        `Read the page to confirm it was accepted${item.hasTotp ? ' — this item has a one-time code available if asked' : ''}.`,
      base,
    );
  }

  private async submit(frame: Frame, scan: LoginScan, fallbackSelector: string): Promise<void> {
    try {
      await submitLogin(frame, scan.submit?.selector ?? null, fallbackSelector);
    } catch {
      // A form that would not submit is not a filled-nothing failure: the
      // values ARE in the fields, and the agent can press the button itself.
      // Swallowing keeps the outcome honest about what was typed.
    }
  }
}
