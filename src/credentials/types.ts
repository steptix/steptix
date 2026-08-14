// Shared vocabulary for the credential broker (SPEC 29, agent-fleet-poc
// docs/spec-29-credential-broker.md).
//
// Deliberately free of Playwright and of `node:child_process`: the MCP server
// runs in a different process from the browser and must not pull either into
// its module graph, and the Express layer wants these types without the
// browser-facing code. Everything here is data.
//
// The rule that shapes this file, and the whole feature: **the model never
// sees a password.** Nothing in these types carries a secret value. A username
// is a secret too — it is half a credential — so it does not appear either.
// What crosses back to the agent is a STATUS, a domain, and an item NAME.

/**
 * What one `log_into_site` call did, from the agent's point of view.
 *
 * These are the only words the agent ever gets. Each is chosen so the agent
 * knows what to do next without knowing anything it should not.
 */
export type LoginOutcome =
  /** Username and password entered and submitted; the site accepted the form. */
  | 'logged-in'
  /** A first-page-of-two form: the username went in, the page advanced. Call again. */
  | 'username-entered-continue'
  /** A one-time code from the vault item went in. Call again if more steps follow. */
  | 'otp-entered-continue'
  /** The scan found no sign-in form here. Nothing else ran. */
  | 'not-a-login-page'
  /** A form is here, but no vault item matches this page's domain. */
  | 'no-credential-for-this-site'
  /** Several vault items match and the user has not chosen one yet. */
  | 'multiple-matches'
  /** The user denied the approval prompt, or it timed out. */
  | 'denied'
  /** The vault is locked; the user is being asked to unlock it. */
  | 'vault-locked'
  /** No vault is reachable at all (the `bw` CLI is absent or not logged in). */
  | 'vault-unavailable'
  /** A page the broker will not touch: sign-up, change-password, captcha, PIN pad. */
  | 'stuck';

/** The result of one brokered login attempt. Carries no secret. */
export interface LoginResult {
  outcome: LoginOutcome;
  /** The host the broker actually matched against — read from the browser, never from the model. */
  domain: string;
  /**
   * The top-level page's host, when the form lives in an iframe from somewhere
   * else. Present only when it differs from `domain`, because that difference
   * is the one the user needs to see before approving.
   */
  framedBy?: string;
  /** The vault item's NAME (e.g. "Facebook"), never its contents. */
  item?: string;
  /** Item names when several matched, so the user can be asked which. */
  candidates?: string[];
  /** What the scanner saw, in plain words. Safe to show a model. */
  detail: string;
  /** True when the caller should call `log_into_site` again after the page settles. */
  continues: boolean;
}

/** One vault entry, as the broker uses it. */
export interface VaultItem {
  /** Bitwarden's item id. Opaque; used only to fetch the TOTP. */
  id: string;
  /** The item's display name — the only part of an item ever shown or logged. */
  name: string;
  /** URIs recorded on the item, used by the domain rule. */
  uris: string[];
  /** True when the item has a TOTP secret, so the broker knows 2FA is possible. */
  hasTotp: boolean;
}

/** An item plus the two values that must never leave the server process. */
export interface VaultSecret {
  username: string;
  password: string;
}

/** Why a vault lookup could not answer. */
export type VaultFailure =
  /** `bw` is not installed or not on PATH. */
  | 'cli-missing'
  /** `bw` is installed but no account is logged in. */
  | 'not-logged-in'
  /** Logged in, but the vault is locked and no session key is held. */
  | 'locked'
  /** `bw` answered, but not in a way we could read. */
  | 'unreadable';

export class VaultError extends Error {
  constructor(
    readonly kind: VaultFailure,
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

/**
 * The vault, narrowed to the three questions the broker asks.
 *
 * An interface rather than the concrete Bitwarden client for the reason
 * `SecretsService` takes its cipher injected in the fleet console: the tests
 * that matter most here — a page on the wrong domain, a vault that will not
 * unlock, an item with no TOTP — are the ones that must run without a real
 * vault and without a real master password anywhere near them.
 */
export interface VaultProvider {
  /** Items whose recorded URIs match `url`. May throw `VaultError`. */
  itemsForUrl(url: string): Promise<VaultItem[]>;
  /** The two values, fetched as late as possible and never retained. */
  secretFor(itemId: string): Promise<VaultSecret>;
  /** The current 6-digit code, or null when the item has no TOTP secret. */
  totpFor(itemId: string): Promise<string | null>;
}

/** What the user was asked, and what they said. */
export interface ApprovalRequest {
  /** The host being logged into. */
  domain: string;
  /** The framing host, when the form is in a third-party iframe. */
  framedBy?: string | undefined;
  /** Item names to choose between; a single-element list is a plain confirm. */
  items: string[];
}

export interface ApprovalDecision {
  allowed: boolean;
  /** Index into `ApprovalRequest.items`; meaningful only when `allowed`. */
  chosen: number;
  /** Set when the prompt could not be shown at all, as opposed to being refused. */
  unavailable?: string;
}

/**
 * Whoever asks the user. Injected for the same reason the vault is: a test
 * must be able to deny, allow, or be absent without a human at the machine.
 */
export interface ApprovalProvider {
  ask(request: ApprovalRequest): Promise<ApprovalDecision>;
}
