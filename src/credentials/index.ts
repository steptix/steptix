// Wiring the broker to the real vault and the real prompt.
//
// The only place the three concrete implementations meet. Kept separate from
// broker.ts so that every test can build a broker out of fakes without this
// file — and therefore without a Bitwarden CLI, a dialog, or a human — being
// anywhere in the picture.

import { LoginBroker } from './broker.js';
import { defaultApproval, WindowsDialogApproval } from './approval.js';
import { BitwardenVault } from './vault.js';
import { driveLogin as realDriveLogin, type DriveLoginOptions, type DriverResult } from './bw-login.js';
import type { ApprovalProvider, SignInResult } from './types.js';

export { LoginBroker, GRANT_TTL_MS, type FieldHint } from './broker.js';
export { BitwardenVault } from './vault.js';
export { defaultApproval, DenyingApproval, WindowsDialogApproval } from './approval.js';
export * from './types.js';

/** What a test may replace. Production passes nothing. */
export interface LoginBrokerOverrides {
  vault?: BitwardenVault;
  approval?: ApprovalProvider;
  driveLogin?: (opts: DriveLoginOptions) => Promise<DriverResult>;
}

/**
 * The broker the server runs with.
 *
 * One instance per server process, because the approval grants (§10) are its
 * memory of what the user has already agreed to, and a per-request instance
 * would ask again on every page of the same login.
 */
export function createLoginBroker(overrides: LoginBrokerOverrides = {}): LoginBroker {
  const vault = overrides.vault ?? new BitwardenVault();
  const approval = overrides.approval ?? defaultApproval();
  const driveLogin = overrides.driveLogin ?? realDriveLogin;

  return new LoginBroker({
    vault,
    approval,
    vaultUnlocked: () => vault.unlocked,
    vaultStatus: () => vault.status(),
    unlockVault: async () => {
      // Only the dialog implementation can ask for a master password. On a
      // platform without one, a locked vault stays locked and the agent is
      // told so — it must never become "fill without asking".
      if (!(approval instanceof WindowsDialogApproval)) return false;
      const masterPassword = await approval.askMasterPassword();
      if (masterPassword === null) return false;
      // No copy is kept here. JS strings cannot be zeroed, so "forgetting" is
      // letting this binding go out of scope — which is the same guarantee the
      // rest of the system has, and worth stating rather than implying.
      return await vault.unlock(masterPassword);
    },
    signIn: () => signIn(vault, approval, driveLogin),
  });
}

/**
 * Sign `bw` in: the sign-in dialog, then the login driver, then whatever the
 * driver's ending needs (stories/bitwarden-sign-in.md §4.6). Never throws.
 *
 * The credentials live in this call and nowhere else. Two of the driver's
 * endings need the master password again — `bw` turned out to hold an account
 * already, or went quiet after the server accepted the login — and in both the
 * vault is merely LOCKED; the password the user just typed unlocks it, so they
 * are never shown a second master-password dialog for one sign-in.
 */
async function signIn(
  vault: BitwardenVault,
  approval: ApprovalProvider,
  driveLogin: (opts: DriveLoginOptions) => Promise<DriverResult>,
): Promise<SignInResult> {
  // The same rule as unlock: no dialog, no sign-in — and no `bw` started.
  if (!(approval instanceof WindowsDialogApproval)) return { ok: false, reason: 'no-dialog' };

  const credentials = await approval.askSignIn();
  if (credentials === null) return { ok: false, reason: 'cancelled' };

  const unlockWithPasswordInHand = async (): Promise<SignInResult> => {
    try {
      return (await vault.unlock(credentials.password)) ? { ok: true } : { ok: false, reason: 'rejected' };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  };

  const { binary, environment } = vault.launchContext;
  const result = await driveLogin({
    binary,
    environment,
    credentials,
    askCode: (kind) => approval.askLoginCode(kind),
  });

  switch (result.kind) {
    case 'signed-in':
      vault.adoptSession(result.sessionKey);
      return { ok: true };
    case 'already-signed-in':
      return unlockWithPasswordInHand();
    case 'quiet': {
      // Silence after an answer is either the SSO step (never signed in) or a
      // login the server accepted and `bw` saved before it was stopped mid-sync.
      // `bw status` tells them apart.
      let status: Awaited<ReturnType<BitwardenVault['status']>>;
      try {
        status = await vault.status();
      } catch {
        return { ok: false, reason: 'failed' };
      }
      if (status === 'locked') return unlockWithPasswordInHand();
      if (status === 'unauthenticated') return { ok: false, reason: 'unsupported-step' };
      return { ok: false, reason: 'failed' };
    }
    default:
      return { ok: false, reason: result.kind };
  }
}
