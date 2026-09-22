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
  SignInFailure,
  SignInResult,
  VaultItem,
  VaultProvider,
  VaultStatus,
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
  /**
   * `bw status`, for telling a signed-out CLI from a locked one
   * (stories/bitwarden-sign-in.md §2). May throw. Absent = assume locked,
   * which is how the broker behaved before sign-in existed.
   */
  vaultStatus?: (() => Promise<VaultStatus>) | undefined;
  /** Raise the sign-in dialog and drive `bw login`. Never throws. Absent = no sign-in. */
  signIn?: (() => Promise<SignInResult>) | undefined;
  /** Injected so grant expiry is testable without waiting two minutes. */
  now?: (() => number) | undefined;
}

/**
 * What the agent is told when the vault could not be opened
 * (stories/bitwarden-sign-in.md §5). Fixed text, chosen from a category — never
 * from anything `bw` printed, which carries the email and any code in clear.
 * Each one tells the agent what to do next, and none lets it ask for a password.
 */
const OPEN_VAULT_WORDS: Record<SignInFailure | 'status-failed' | 'not-logged-in', string> = {
  cancelled:
    'The user was asked to sign in to Bitwarden and did not. Do not ask them for any password. ' +
    'Ask whether they want to try again.',
  rejected:
    'Bitwarden rejected the sign-in: the email or master password was wrong, or the account is on a ' +
    'different Bitwarden server (for example the EU cloud). Ask the user to try again — never ask them ' +
    'to type a password to you.',
  'code-rejected': 'Bitwarden rejected the verification code. Ask the user to try again with a fresh code.',
  'unsupported-step':
    'This Bitwarden account needs a sign-in step the dialog cannot handle (several two-step methods, ' +
    'single sign-on, Key Connector, or a self-hosted server). Ask the user to run `bw login` once in a ' +
    'terminal, then try again.',
  'timed-out': 'Signing in to Bitwarden did not complete. Ask the user to run `bw login` once in a terminal, then try again.',
  failed: 'Signing in to Bitwarden did not complete. Ask the user to run `bw login` once in a terminal, then try again.',
  'no-dialog':
    'The Bitwarden command-line tool (not the browser extension) is signed out, and this machine cannot ' +
    'show a sign-in prompt. Ask the user to run `bw login` in a terminal, then try again.',
  'status-failed':
    'The Bitwarden command-line tool did not answer, so the vault could not be opened. Ask the user to ' +
    'check that `bw status` works in a terminal.',
  // This replaces "Bitwarden is installed but no account is signed in.", which
  // named neither the command-line tool nor a remedy — and an agent filled the
  // gap by sending the user to the browser extension, which changes nothing.
  'not-logged-in':
    'The Bitwarden command-line tool (not the browser extension) is signed out. Ask the user to run ' +
    '`bw login` in a terminal, then try again.',
};

/** `bw` is not installed at all. Unchanged by the sign-in story. */
const CLI_MISSING_WORDS =
  'The Bitwarden CLI is not installed on this machine, so there is no vault to read. ' +
  'Tell the user to install it and sign in.';

/** Why the vault is not open, as the agent will be told it. Null = open. */
type OpenVaultResult = { outcome: 'vault-locked' | 'vault-unavailable'; detail: string } | null;

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
  /** The one vault-opening attempt in progress, if any (story §6). */
  private opening: Promise<OpenVaultResult> | null = null;

  constructor(deps: BrokerDeps) {
    this.deps = deps;
  }

  /**
   * Open the vault — sign in or unlock, whichever `bw` needs — at most once at
   * a time (stories/bitwarden-sign-in.md §6).
   *
   * Two `log_into_site` calls on a closed vault must not raise two dialogs:
   * two live prompts for one decision is how a user ends up approving
   * something they did not mean to. So a call that finds an attempt in
   * progress JOINS it and takes its result — and the status check is inside
   * the attempt, so a joiner never reads a status from before the first
   * caller's sign-in and opens a second dialog on the strength of it.
   *
   * The attempt is RELEASED when it settles, resolved or rejected: a call that
   * arrives afterwards starts a fresh one. Without that, one cancelled sign-in
   * would read as "did not sign in" for the life of the server.
   */
  private openVault(): Promise<OpenVaultResult> {
    if (!this.opening) {
      const attempt = this.openVaultOnce()
        // `signIn` and `unlockVault` never throw by contract. One that does
        // anyway is reported as a sign-in that did not complete — to every
        // caller that joined — rather than as a 500.
        .catch((): OpenVaultResult => ({ outcome: 'vault-unavailable', detail: OPEN_VAULT_WORDS.failed }))
        .finally(() => {
          if (this.opening === attempt) this.opening = null;
        });
      this.opening = attempt;
    }
    return this.opening;
  }

  private async openVaultOnce(): Promise<OpenVaultResult> {
    // A flight that finished between this caller's check and now has already
    // done the work.
    if (this.deps.vaultUnlocked?.() ?? true) return null;

    let status: VaultStatus = 'locked';
    if (this.deps.vaultStatus) {
      try {
        status = await this.deps.vaultStatus();
      } catch {
        // A `bw` that cannot answer `status` would not answer a login either,
        // and asking for a master password it cannot use is worse than saying so.
        return { outcome: 'vault-unavailable', detail: OPEN_VAULT_WORDS['status-failed'] };
      }
    }

    if (status === 'cli-missing') {
      return { outcome: 'vault-unavailable', detail: CLI_MISSING_WORDS };
    }
    if (status === 'unauthenticated') {
      if (!this.deps.signIn) return { outcome: 'vault-unavailable', detail: OPEN_VAULT_WORDS['not-logged-in'] };
      const signedIn = await this.deps.signIn();
      return signedIn.ok ? null : { outcome: 'vault-unavailable', detail: OPEN_VAULT_WORDS[signedIn.reason] };
    }

    // `locked` — and `unlocked` with no key held, which this process cannot
    // use: `bw` reports unlocked only to a child handed a live key (story §2.2).
    if (!this.deps.unlockVault) {
      return { outcome: 'vault-locked', detail: 'The vault is locked and no unlock prompt is configured.' };
    }
    const opened = await this.deps.unlockVault();
    return opened
      ? null
      : { outcome: 'vault-locked', detail: 'The vault is locked. Ask the user to unlock Bitwarden, then try again.' };
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

    // ---- Gate 3: the vault. A closed vault is opened — signed in or unlocked,
    // whichever `bw` needs — and one that cannot be opened says why. A held key
    // skips this entirely: no `bw` spawn on the path of an open vault.
    const unlocked = this.deps.vaultUnlocked?.() ?? true;
    if (!unlocked) {
      const refused = await this.openVault();
      if (refused) return result(refused.outcome, host, refused.detail);
    }

    // ---- Gate 4: match by the URL the BROWSER reported. Never the model's.
    let candidates: VaultItem[];
    try {
      candidates = await this.deps.vault.itemsForUrl(scan.url);
    } catch (err) {
      // A key was held, but `bw` has been signed out underneath it (story
      // §2.3) — the vault has already dropped the dead key. Sign in, and look
      // again ONCE: a second "not logged in" straight after a successful
      // sign-in is a vault we do not understand, and looping on it would raise
      // dialog after dialog.
      if (!(err instanceof VaultError && err.kind === 'not-logged-in' && this.deps.signIn)) {
        return this.vaultFailure(err, host);
      }
      const refused = await this.openVault();
      if (refused) return result(refused.outcome, host, refused.detail);
      try {
        candidates = await this.deps.vault.itemsForUrl(scan.url);
      } catch (again) {
        return this.vaultFailure(again, host);
      }
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
          return result('vault-unavailable', host, CLI_MISSING_WORDS);
        case 'not-logged-in':
          return result('vault-unavailable', host, OPEN_VAULT_WORDS['not-logged-in']);
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
