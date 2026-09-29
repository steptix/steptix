import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let channel: vscode.OutputChannel | undefined;
let wrappedChannel: vscode.OutputChannel | undefined;
const TEST_LOG_FILE =
  process.env['STEPTIX_LIVE_LOG'] ||
  path.join(os.tmpdir(), 'steptix-live.log');
const TEE_TO_FILE = process.env['STEPTIX_LIVE_LOG'] !== undefined;

/**
 * The single shared "Steptix" output channel. Every error and run-log line
 * the extension emits must go here so users always have one place to look.
 *
 * In live-test mode (`STEPTIX_LIVE_LOG` env var set), also tee every
 * appendLine() to the named file so the test can read what the controller
 * logged. VS Code does not expose an OutputChannel read API.
 */
export function getOutputChannel(): vscode.OutputChannel {
  if (wrappedChannel) return wrappedChannel;
  if (!channel) channel = vscode.window.createOutputChannel('Steptix');
  if (!TEE_TO_FILE) return channel;
  // Wrap once. The wrapper just adds file tee around appendLine/append.
  const real = channel;
  try {
    fs.writeFileSync(TEST_LOG_FILE, '');
  } catch { /* ignore */ }
  wrappedChannel = {
    name: real.name,
    append: (value: string) => {
      try { fs.appendFileSync(TEST_LOG_FILE, value); } catch { /* ignore */ }
      real.append(value);
    },
    appendLine: (value: string) => {
      try { fs.appendFileSync(TEST_LOG_FILE, value + '\n'); } catch { /* ignore */ }
      real.appendLine(value);
    },
    replace: (value: string) => real.replace(value),
    clear: () => real.clear(),
    show: ((preserveFocusOrColumn?: boolean | vscode.ViewColumn, preserveFocus?: boolean): void => {
      if (typeof preserveFocusOrColumn === 'boolean') {
        real.show(preserveFocusOrColumn);
      } else if (preserveFocusOrColumn !== undefined) {
        real.show(preserveFocusOrColumn, preserveFocus);
      } else {
        real.show();
      }
    }) as vscode.OutputChannel['show'],
    hide: () => real.hide(),
    dispose: () => real.dispose(),
  };
  return wrappedChannel;
}

export function disposeOutputChannel(): void {
  channel?.dispose();
  channel = undefined;
  wrappedChannel = undefined;
}
