// Wiring the broker to the real vault and the real prompt.
//
// The only place the three concrete implementations meet. Kept separate from
// broker.ts so that every test can build a broker out of fakes without this
// file — and therefore without a Bitwarden CLI, a dialog, or a human — being
// anywhere in the picture.

import { LoginBroker } from './broker.js';
import { defaultApproval, WindowsDialogApproval } from './approval.js';
import { BitwardenVault } from './vault.js';

export { LoginBroker, GRANT_TTL_MS, type FieldHint } from './broker.js';
export { BitwardenVault } from './vault.js';
export { defaultApproval, DenyingApproval, WindowsDialogApproval } from './approval.js';
export * from './types.js';

/**
 * The broker the server runs with.
 *
 * One instance per server process, because the approval grants (§10) are its
 * memory of what the user has already agreed to, and a per-request instance
 * would ask again on every page of the same login.
 */
export function createLoginBroker(): LoginBroker {
  const vault = new BitwardenVault();
  const approval = defaultApproval();

  return new LoginBroker({
    vault,
    approval,
    vaultUnlocked: () => vault.unlocked,
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
  });
}
