import * as vscode from 'vscode';

/**
 * Warning toasts for definition providers, deduplicated over a short window.
 *
 * `provideDefinition` runs on Ctrl+hover as well as on F12/Peek, so one broken
 * reference can ask for the same warning several times in a row (the hover
 * probe, then the click). Showing each identical message at most once per
 * window keeps that from stacking toasts without hiding a genuinely new
 * message.
 */
export class DedupedWarnings {
  private last: { message: string; at: number } | null = null;

  warn(message: string): void {
    const now = Date.now();
    if (this.last && this.last.message === message && now - this.last.at < 3000) {
      return;
    }
    this.last = { message, at: now };
    void vscode.window.showWarningMessage(message);
  }
}
