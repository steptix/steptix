// Stand-in for vscode.Webview. Captures everything the controller posts and
// lets a test push WebviewToHost messages back through the registered handler,
// exactly as the real webview bridge would.

import type { HostToWebview, WebviewToHost } from '../../src/shared/protocol';

interface UriLike {
  path?: string;
  fsPath?: string;
}

export class FakeWebview {
  /** Every message the controller has posted, in order. */
  readonly messages: HostToWebview[] = [];

  private handler: ((msg: WebviewToHost) => void) | undefined;

  postMessage(msg: HostToWebview): Promise<boolean> {
    this.messages.push(msg);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(handler: (msg: WebviewToHost) => void): { dispose(): void } {
    this.handler = handler;
    return {
      dispose: () => {
        this.handler = undefined;
      },
    };
  }

  asWebviewUri(uri: UriLike): { toString(): string } {
    const p = uri.path ?? uri.fsPath ?? '';
    return { toString: () => `vscode-webview://flick${p.startsWith('/') ? '' : '/'}${p}` };
  }

  // --- test helpers --------------------------------------------------------

  /** Simulate the webview sending a message to the host. */
  send(msg: WebviewToHost): void {
    if (!this.handler) throw new Error('FakeWebview: no onDidReceiveMessage handler registered');
    this.handler(msg);
  }

  /**
   * Resolve once a posted message matches `predicate` (polls, then times out).
   *
   * The timeout is a ceiling, not a wait: a message that comes resolves at
   * once. It is generous because the host's work between two messages
   * includes real file writes, and on a loaded machine 3 s was not always
   * enough. `explain`, when given, adds what the host knows about why the
   * message never came (its failed background work) to the timeout error.
   */
  async waitFor<T extends HostToWebview>(
    predicate: (msg: HostToWebview) => boolean,
    timeoutMs = 15_000,
    explain?: () => string,
  ): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.messages.find(predicate);
      if (found) return found as T;
      await delay(10);
    }
    const why = explain?.();
    throw new Error(
      `FakeWebview.waitFor timed out after ${timeoutMs}ms; saw: ${this.messages
        .map((m) => m.type)
        .join(', ')}${why ? `; ${why}` : ''}`,
    );
  }

  /** Most recent posted message of the given type, if any. */
  last<T extends HostToWebview>(type: T['type']): T | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].type === type) return this.messages[i] as T;
    }
    return undefined;
  }

  /** All posted messages of the given type. */
  allOf<T extends HostToWebview>(type: T['type']): T[] {
    return this.messages.filter((m) => m.type === type) as T[];
  }

  /** Forget all captured messages (useful to isolate a phase of a test). */
  drain(): void {
    this.messages.length = 0;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
