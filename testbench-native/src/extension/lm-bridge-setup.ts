import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { getOutputChannel } from './output-channel.js';
import { workspaceFolderFor } from './workspace.js';
import { qualifiedModelId, mapLmError } from './lm-bridge-core.js';
import {
  LM_BRIDGE_ENABLED,
  type LmBridge,
  type LmModelHandle,
} from './lm-bridge.js';
import { isLocalServerUrl, planEnvUpdate } from './lm-bridge-env.js';

/**
 * **TestBench: Use Copilot for AI** — the one command that turns a Copilot
 * seat into this project's AI (stories/copilot-lm-bridge.md §The setup
 * command).
 *
 * It exists because of one hard constraint: `vscode.lm` raises its consent
 * dialog only for a request VS Code can attribute to a user action, and every
 * request the bridge serves arrives over HTTP from the server process — which
 * it can never attribute. So the warm-up call this command makes IS the
 * consent moment. Everything else it does (flip the setting, pick a model,
 * write the `.env`) could have been documented instead; that one call could
 * not.
 */
export const USE_COPILOT_COMMAND = 'testbench-native.useCopilotForAi';

export function registerLmBridgeCommands(bridge: LmBridge): vscode.Disposable[] {
  return [vscode.commands.registerCommand(USE_COPILOT_COMMAND, () => runSetup(bridge))];
}

const log = (line: string): void =>
  getOutputChannel().appendLine(
    `[${new Date().toISOString().slice(11, 23)}] copilot-setup: ${line}`,
  );

async function runSetup(bridge: LmBridge): Promise<void> {
  const facade = bridge.lmFacade();
  if (!facade.available()) {
    void vscode.window.showErrorMessage(
      'This VS Code build has no language-model API (vscode.lm), which TestBench ' +
        'needs to reach Copilot. It was finalized in VS Code 1.90 — update VS Code ' +
        'and run this command again.',
    );
    return;
  }

  // 1. The setting. User-scoped and default-off, so this is the moment the user
  //    agrees to a listener and to spending a subscription; it is asked, not
  //    assumed.
  if (!(await ensureEnabled(bridge))) return;

  // 2. The model, and with it the consent dialog.
  const model = await pickModel(facade);
  if (!model) return;
  if (!(await warmUp(model))) return;

  // 3. The `.env`.
  const target = resolveEnvTarget();
  if (!target) {
    void vscode.window.showErrorMessage(
      'TestBench: open the test project as a workspace folder first — the Copilot ' +
        "bridge settings are written into that folder's .env.",
    );
    return;
  }

  const status = bridge.status();
  if (status.state !== 'listening') {
    // Not fatal: the `.env` is still correct and the bridge retries. But a user
    // whose next compile fails with connection-refused deserves to have been
    // told, rather than discovering it through an error four minutes later.
    void vscode.window.showWarningMessage(
      `TestBench: the Copilot bridge is not listening (${status.detail ?? status.state}). ` +
        'The .env below is still correct; the bridge claims the port as soon as it ' +
        'is free.',
    );
  }

  const existing = await readIfPresent(target.envPath);
  const plan = planEnvUpdate({
    text: existing,
    model: `gateway/${qualifiedModelId(model)}`,
    gatewayUrl: bridge.gatewayUrl(),
    token: await bridge.ensureToken(),
  });

  if (plan.unchanged) {
    void vscode.window.showInformationMessage(
      `TestBench: ${shortPath(target)} already points at this bridge and model — nothing to write.`,
    );
    return;
  }

  if (!(await confirmWrite(target, plan.preview, plan.flipsKeylessToKeyed, existing === ''))) return;

  // Tmp-and-rename rather than an in-place write: this file holds the user's
  // OTHER secrets, and a crash partway through `writeFile` leaves it truncated
  // with no copy of what was in it. The temp sits in the same directory so the
  // rename stays within one volume, where it is atomic — every reader sees the
  // whole old file or the whole new one. `.env.tmp-<pid>` rather than a name in
  // the OS temp dir, so the usual `.env*` ignore rule still covers it if a crash
  // lands in the one instant it exists, and so two windows cannot collide.
  const tmpPath = `${target.envPath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmpPath, plan.text, 'utf8');
    await fs.rename(tmpPath, target.envPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    void vscode.window.showErrorMessage(
      `TestBench: could not write ${target.envPath} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  log(`wrote ${plan.changes.map((c) => c.key).join(', ')} to ${target.envPath}`);

  if (plan.serverUrl && !isLocalServerUrl(plan.serverUrl)) {
    void vscode.window.showWarningMessage(
      `TestBench: SERVER_URL in this .env is ${plan.serverUrl}, which is not this ` +
        'machine. The bridge binds 127.0.0.1, so a remote Sessions API server will ' +
        'resolve AI_GATEWAY_URL to itself and get a connection refused. Copilot ' +
        'through the bridge only works with a local server.',
    );
  }

  void vscode.window.showInformationMessage(summary(model, bridge, plan.flipsKeylessToKeyed));
}

// ---------------------------------------------------------------------------

async function ensureEnabled(bridge: LmBridge): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('testbench-native');
  if (config.get<boolean>(LM_BRIDGE_ENABLED, false)) {
    await bridge.sync();
    return true;
  }
  const choice = await vscode.window.showInformationMessage(
    'Let TestBench use your GitHub Copilot seat for AI?',
    {
      modal: true,
      detail:
        'This opens a small HTTP listener on 127.0.0.1 in this VS Code window and ' +
        "publishes Copilot's models to TestBench through it. Nothing new leaves the " +
        "machine: prompts go out through Copilot's own channel.\n\n" +
        'Compiling and repairing steps spend Copilot premium requests. Running a ' +
        'compiled test spends none.\n\n' +
        'The setting is User-scoped, so no workspace can turn this on for you.',
    },
    'Enable',
  );
  if (choice !== 'Enable') return false;
  await config.update(LM_BRIDGE_ENABLED, true, vscode.ConfigurationTarget.Global);
  await bridge.sync();
  return true;
}

async function pickModel(
  facade: ReturnType<LmBridge['lmFacade']>,
): Promise<LmModelHandle | undefined> {
  let models: LmModelHandle[];
  try {
    models = await facade.selectChatModels();
  } catch (err) {
    void vscode.window.showErrorMessage(
      `TestBench: could not list Copilot models — ${mapLmError(toShape(err)).body.error.message}`,
    );
    return undefined;
  }

  if (models.length === 0) {
    // Never an empty QuickPick: it reads as "TestBench is broken" when the
    // actual state is "this VS Code is not signed in to Copilot", which the
    // user fixes somewhere else entirely.
    void vscode.window.showWarningMessage(
      'TestBench: no language models are available in this window. Sign in to ' +
        'GitHub Copilot (the Accounts button in the Activity Bar) and check the seat ' +
        'is active, then run "TestBench: Use Copilot for AI" again.',
    );
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    models.map((m) => ({
      label: qualifiedModelId(m),
      description: m.name,
      detail: `family ${m.family} · vendor ${m.vendor}`,
      model: m,
    })),
    {
      title: 'Use Copilot for AI',
      placeHolder: 'Which model should TestBench compile and repair with?',
      ignoreFocusOut: true,
    },
  );
  return pick?.model;
}

/**
 * The consent moment. A one-line request under the user's own command
 * invocation, which is the only kind of call VS Code will raise the dialog
 * for; once granted, consent persists for the extension and the bridge's
 * HTTP-triggered calls succeed.
 */
async function warmUp(model: LmModelHandle): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking access to ${model.name}…` },
      async () => {
        const fragments = await model.sendRequest(
          [{ role: 'user', text: 'Reply with the single word: ready' }],
          {},
        );
        // Drained, not just started: consent is settled when the response
        // actually produces something, and an un-drained iterator would leave
        // the request in flight past the progress notification.
        for await (const _ of fragments) break;
      },
    );
    return true;
  } catch (err) {
    const mapped = mapLmError(toShape(err), { model: qualifiedModelId(model) });
    log(`warm-up failed: ${mapped.body.error.code}`);
    void vscode.window.showErrorMessage(`TestBench: ${mapped.body.error.message}`);
    return false;
  }
}

interface EnvTarget {
  folder: vscode.WorkspaceFolder;
  envPath: string;
}

/** The workspace folder of the active editor, else the first one open. */
function resolveEnvTarget(): EnvTarget | null {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder =
    (active ? workspaceFolderFor(active) : null) ?? vscode.workspace.workspaceFolders?.[0] ?? null;
  if (!folder) return null;
  return { folder, envPath: path.join(folder.uri.fsPath, '.env') };
}

const shortPath = (target: EnvTarget): string => `${target.folder.name}${path.sep}.env`;

async function readIfPresent(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The confirm. Shown before every write because this file holds the user's
 * other secrets — and shown as the literal lines that will land in it, minus
 * the token value.
 */
async function confirmWrite(
  target: EnvTarget,
  preview: string,
  flipsKeylessToKeyed: boolean,
  creating: boolean,
): Promise<boolean> {
  const keylessNote = flipsKeylessToKeyed
    ? '\n\nNote: this file currently has a BLANK AI_API_KEY, which pins the project ' +
      'keyless — runs make no AI calls at all. Writing the bridge token makes it a ' +
      'keyed project again: a failed run will call the model to diagnose it, and a ' +
      'stale compiled step will try to heal. Use runSettings ai: "off" for a run ' +
      'that must spend nothing.'
    : '';
  const choice = await vscode.window.showInformationMessage(
    `${creating ? 'Create' : 'Update'} ${shortPath(target)}?`,
    {
      modal: true,
      detail:
        `${preview}\n\nEvery other line in the file is left exactly as it is. The ` +
        `token is written in full; the placeholders stand in for it here. That makes ` +
        `this file a credential — keep it out of version control.` +
        keylessNote,
    },
    creating ? 'Create .env' : 'Update .env',
  );
  return choice !== undefined;
}

function summary(model: LmModelHandle, bridge: LmBridge, flipped: boolean): string {
  const base =
    `TestBench now compiles and repairs with ${qualifiedModelId(model)} over the ` +
    `Copilot bridge on ${bridge.gatewayUrl()}. Compiling and repairing spend Copilot ` +
    'premium requests; running a compiled test spends none, and runSettings ai: "off" ' +
    'makes any run keyless by policy. ' +
    // The one failure this command cannot detect: `gateway/` is resolved by
    // @pkent/aigateway inside the server process, which this extension neither
    // imports nor can interrogate. A server predating the gateway provider
    // refuses the model it was just handed, and the error names neither Copilot
    // nor the bridge — so the remedy is said here, once. Now that the framework
    // depends on a version shipping the provider, updating the SERVER is the
    // fix; before that dependency moved, it was not.
    'If the server answers Unsupported model "gateway/…" and lists the providers ' +
    'it knows, that server predates the gateway/ prefix: rebuild and restart it ' +
    'from a checkout that has it.';
  return flipped
    ? `${base} This project was pinned keyless by a blank AI_API_KEY and is now keyed.`
    : base;
}

function toShape(err: unknown): { code?: string; name?: string; message?: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return { ...(typeof code === 'string' && { code }), name: err.name, message: err.message };
  }
  return { message: String(err) };
}
