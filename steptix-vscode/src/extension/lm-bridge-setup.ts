import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { getOutputChannel } from './output-channel.js';
import { workspaceFolderFor } from './workspace.js';
import { qualifiedModelId, mapLmError, textMessage } from './lm-bridge-core.js';
import {
  LM_BRIDGE_ENABLED,
  type LmBridge,
  type LmModelHandle,
} from './lm-bridge.js';
import {
  effectiveServerUrl,
  envNameStaysInFolder,
  isLocalServerUrl,
  overlayBridgeKeys,
  planEnvUpdate,
} from './lm-bridge-env.js';
import { EnvSelector } from './env-selector.js';
import { resolveServerUrl } from './server-url.js';

/**
 * **Steptix: Use Copilot for AI** — the one command that turns a Copilot
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
export const USE_COPILOT_COMMAND = 'steptix.useCopilotForAi';

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
      'This VS Code build has no language-model API (vscode.lm), which Steptix ' +
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
  const baseTarget = resolveEnvTarget();
  if (!baseTarget) {
    void vscode.window.showErrorMessage(
      'Steptix: open the test project as a workspace folder first — the Copilot ' +
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
      `Steptix: the Copilot bridge is not listening (${status.detail ?? status.state}). ` +
        'The env file below is still correct; the bridge claims the port as soon as it ' +
        'is free.',
    );
  }

  // 4. Which file. Before the plan, not after: an overlay shadowing a `.env`
  //    that is ALREADY correct is exactly the case the plan short-circuits as
  //    "nothing to write" — the shape of the incident this check exists for.
  //    Read once here because the overlay decides two separate things, and only
  //    one of them is the write target: it also carries the SERVER_URL a run
  //    would use, whichever file gets written.
  const overlay = await activeOverlay(baseTarget);
  const target = await chooseTarget(baseTarget, overlay);
  if (!target) return;

  const existing = await readIfPresent(target.envPath);
  const plan = planEnvUpdate({
    text: existing,
    model: `gateway/${qualifiedModelId(model)}`,
    gatewayUrl: bridge.gatewayUrl(),
    token: await bridge.ensureToken(),
    envName: target.envName,
  });

  if (plan.unchanged) {
    void vscode.window.showInformationMessage(
      `Steptix: ${shortPath(target)} already points at this bridge and model — nothing to write.`,
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
      `Steptix: could not write ${target.envPath} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  log(`wrote ${plan.changes.map((c) => c.key).join(', ')} to ${target.envPath}`);

  // Which SERVER_URL a run would actually use — which is neither "the one in
  // the file just written" nor "the one in `.env`". It is `composeEnv`'s
  // answer: the active overlay's when that file sets one, the base's
  // otherwise, and that holds whether or not the overlay was the write target.
  // Consulting the overlay only when it IS the target made the warning a coin
  // toss: *Continue anyway* over a `.env.uat` that redirects SERVER_URL to
  // localhost warned "not this machine" about a run that dials localhost, and
  // the reverse said nothing before a connection refused.
  const baseText =
    target.envName === null
      ? existing
      : await readIfPresent(path.join(target.folder.uri.fsPath, '.env'));
  // And when the project names none, the rest of a run's chain does: the
  // environment, then the machine .env — which may well name a remote server.
  let serverUrl: string | null = null;
  try {
    serverUrl = resolveServerUrl({
      value: effectiveServerUrl(baseText, overlay?.text ?? null) ?? undefined,
      path: target.envPath,
    }).serverUrl;
  } catch {
    // An unreadable machine .env: the run reports that (STX007); a warning
    // here could only guess.
  }
  if (serverUrl && !isLocalServerUrl(serverUrl)) {
    void vscode.window.showWarningMessage(
      `Steptix: SERVER_URL for this project is ${serverUrl}, which is not ` +
        'this machine. The bridge binds 127.0.0.1, so a remote Sessions API server ' +
        'will resolve AI_GATEWAY_URL to itself and get a connection refused. Copilot ' +
        'through the bridge only works with a local server.',
    );
  }

  void vscode.window.showInformationMessage(summary(model, bridge, target, plan.flipsKeylessToKeyed));
}

// ---------------------------------------------------------------------------

async function ensureEnabled(bridge: LmBridge): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('steptix');
  if (config.get<boolean>(LM_BRIDGE_ENABLED, false)) {
    await bridge.sync();
    return true;
  }
  const choice = await vscode.window.showInformationMessage(
    'Let Steptix use your GitHub Copilot seat for AI?',
    {
      modal: true,
      detail:
        'This opens a small HTTP listener on 127.0.0.1 in this VS Code window and ' +
        "publishes Copilot's models to Steptix through it. Nothing new leaves the " +
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
      `Steptix: could not list Copilot models — ${mapLmError(toShape(err)).body.error.message}`,
    );
    return undefined;
  }

  if (models.length === 0) {
    // Never an empty QuickPick: it reads as "Steptix is broken" when the
    // actual state is "this VS Code is not signed in to Copilot", which the
    // user fixes somewhere else entirely.
    void vscode.window.showWarningMessage(
      'Steptix: no language models are available in this window. Sign in to ' +
        'GitHub Copilot (the Accounts button in the Activity Bar) and check the seat ' +
        'is active, then run "Steptix: Use Copilot for AI" again.',
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
      placeHolder: 'Which model should Steptix compile and repair with?',
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
          [textMessage('user', 'Reply with the single word: ready')],
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
    void vscode.window.showErrorMessage(`Steptix: ${mapped.body.error.message}`);
    return false;
  }
}

interface EnvTarget {
  folder: vscode.WorkspaceFolder;
  envPath: string;
  /** null for the base `.env`; the env name when this is its `.env.<name>`. */
  envName: string | null;
}

/** The workspace folder of the active editor, else the first one open. */
function resolveEnvTarget(): EnvTarget | null {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder =
    (active ? workspaceFolderFor(active) : null) ?? vscode.workspace.workspaceFolders?.[0] ?? null;
  if (!folder) return null;
  return { folder, envPath: path.join(folder.uri.fsPath, '.env'), envName: null };
}

const shortPath = (target: EnvTarget): string =>
  `${target.folder.name}${path.sep}${path.basename(target.envPath)}`;

interface ActiveOverlay {
  envName: string;
  envPath: string;
  /** Its contents; `''` for a selected env with no file beside the `.env`. */
  text: string;
}

/**
 * The active environment's overlay file, read once.
 *
 * This is the whole reason the story exists: `.env.<name>` beats `.env` on
 * every run, so a `.env` this command writes perfectly can be shadowed by a
 * line the user has not thought about in weeks — and the 401 that follows
 * blames the token, the machine, and the command, none of which are at fault.
 */
async function activeOverlay(target: EnvTarget): Promise<ActiveOverlay | null> {
  const envName = EnvSelector.activeEnv();
  if (!envName) return null;
  // The name is a plain workspace setting, and it is about to name a file this
  // command WRITES — so reject what would escape the folder, and only that. An
  // earlier "picker-shaped names only" rule turned out to cut the wrong way in
  // both directions: it threw away `uat.local`, a name whose `.env.uat.local`
  // the run path reads and applies quite happily, leaving setup to write `.env`
  // while the run kept using the overlay — the incident, for that name. And the
  // rejected names it was protecting against are not reported by the run path
  // either: `../..` composes a path that resolves to the folder itself, so
  // `readEnvOverlayFile` finds it, tries to read a directory, and throws EISDIR
  // — which the run controller rethrows unmapped, not as STX006.
  if (!envNameStaysInFolder(envName)) {
    // Said out loud, because a silent `return null` here looks identical to
    // "no environment is active" and leads the user to the same 401.
    log(`active env "${envName}" cannot name a file beside .env — overlay not checked`);
    return null;
  }

  // The TARGET's folder, not "the workspace": `resolveEnvTarget` already picked
  // the active editor's folder in a multi-root window, and the overlay that
  // shadows that folder's `.env` is the one beside it.
  const envPath = path.join(target.folder.uri.fsPath, `.env.${envName}`);
  return { envName, envPath, text: await readIfPresent(envPath) };
}

/**
 * Which of the trio the active overlay shadows, if any.
 *
 * All three keys count, not just `AI_API_KEY`. The server applies them
 * independently, so an overlay `AI_MODEL=openai/…` over a bridge token posts
 * that token to OpenAI: a second misleading 401, from a different direction.
 */
function overlayConflict(overlay: ActiveOverlay | null): (ActiveOverlay & { keys: string[] }) | null {
  if (!overlay) return null;
  const keys = overlayBridgeKeys(overlay.text);
  return keys.length > 0 ? { ...overlay, keys } : null;
}

/**
 * Which file the trio goes in — asked, never guessed.
 *
 * There is deliberately no default: the modal is already interrupting the
 * user, so making them choose costs nothing, while choosing for them can
 * silently break an environment's model pairing (writing `AI_MODEL` into a
 * `.env.uat` that pairs a different model with a different endpoint) or leave
 * the setup they just ran shadowed. Dismissing the modal cancels the command
 * rather than picking one.
 */
async function chooseTarget(
  target: EnvTarget,
  overlay: ActiveOverlay | null,
): Promise<EnvTarget | null> {
  const conflict = overlayConflict(overlay);
  if (!conflict) return target;

  const overlayFile = `.env.${conflict.envName}`;
  log(`active env ${conflict.envName}: ${overlayFile} sets ${conflict.keys.join(', ')}`);
  const writeOverlay = `Write ${overlayFile}`;
  const choice = await vscode.window.showWarningMessage(
    `The active environment "${conflict.envName}" sets ${conflict.keys.join(', ')} in ` +
      `${overlayFile}, which overrides .env on every run. Write the bridge settings to ` +
      `${overlayFile} instead?`,
    {
      modal: true,
      detail:
        `Write ${overlayFile} — all three lines (AI_MODEL, AI_GATEWAY_URL, AI_API_KEY) go ` +
        `into the file that wins, and .env is left exactly as it is. They apply while ` +
        `"${conflict.envName}" is the active environment; the CLI needs ` +
        `"steptix run --env ${conflict.envName}" to see them.\n\n` +
        'Continue anyway — write .env, as before. It stays shadowed by ' +
        `${overlayFile} until you clear the environment or edit that file.`,
    },
    writeOverlay,
    'Continue anyway',
  );

  if (choice === undefined) {
    log('overlay choice dismissed — nothing written');
    return null;
  }
  if (choice !== writeOverlay) {
    log(`continuing with .env despite ${overlayFile}`);
    return target;
  }
  return { folder: target.folder, envPath: conflict.envPath, envName: conflict.envName };
}

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
  const file = path.basename(target.envPath);
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
    `${creating ? 'Create' : 'Update'} ${file}`,
  );
  return choice !== undefined;
}

function summary(
  model: LmModelHandle,
  bridge: LmBridge,
  target: EnvTarget,
  flipped: boolean,
): string {
  // Which FILE, because that is now a real choice: the same three lines mean
  // "always" in `.env` and "while this env is active" in `.env.<name>`, and a
  // message that names only the model and the URL leaves the user unable to
  // tell which of those they just got.
  const where =
    target.envName === null
      ? `, from ${shortPath(target)}`
      : `, from ${shortPath(target)} — which applies while "${target.envName}" is the ` +
        `active environment, and to "steptix run --env ${target.envName}"`;
  const base =
    `Steptix now compiles and repairs with ${qualifiedModelId(model)} over the ` +
    `Copilot bridge on ${bridge.gatewayUrl()}${where}. Compiling and repairing spend ` +
    'Copilot premium requests; running a compiled test spends none, and runSettings ' +
    'ai: "off" makes any run keyless by policy. ' +
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
