/**
 * Error catalogue — single source of truth for all user-facing failure modes.
 *
 * Every error reaches the user via two channels: an inline run-log banner in
 * the webview and the "Steptix" output channel. Both carry the same payload
 * built by reportError().
 *
 * Format rule: `STXxxx: <what's wrong>. <verb-led fix>.` Never end on the
 * diagnosis alone. Always include the absolute path of any file involved and
 * the literal name of any setting key involved so the user can grep.
 */

import { serverUrlPort } from './url-port.js';

// STX002 (a project .env without STEPTIX_SERVER_URL) is retired: the URL
// falls back to the environment, the machine .env, then the default
// (stories/machine-server-url.md). Its number stays unused.
export type ErrorCode =
  | 'STX001'
  | 'STX003'
  | 'STX004'
  | 'STX005'
  | 'STX006'
  | 'STX007'
  | 'STX010'
  | 'STX011'
  | 'STX012'
  | 'STX013'
  | 'STX014'
  | 'STX020'
  | 'STX021'
  | 'STX024'
  | 'STX025'
  | 'STX026'
  | 'STX027'
  | 'STX028'
  | 'STX030'
  | 'STX031'
  | 'STX032'
  | 'STX033'
  | 'STX034'
  | 'STX035';

/** A button shown beneath the inline banner — `command` is a VS Code command id. */
export interface ErrorAction {
  label: string;
  command: string;
  args?: unknown[];
}

export interface ErrorPayload {
  code: ErrorCode;
  /** Full single-string message in the canonical format. Safe to log or render verbatim. */
  message: string;
  /** Just the fix sentence, useful when you want to render diagnosis and fix as separate paragraphs. */
  fix: string;
  /** Just the diagnosis sentence. */
  diagnosis: string;
  /** Buttons to render under the banner. May be empty. */
  actions: ErrorAction[];
}

// ---------------------------------------------------------------------------
// Per-code context types — each ErrorCode declares exactly what it needs.
// ---------------------------------------------------------------------------

export interface ErrorContextMap {
  STX001: { searchedDirs: string[]; fallbackSetting: string };
  STX003: { envPath: string; machineEnvPath: string };
  STX004: { envPath: string; value: string };
  STX005: { envPath: string; lineNumber: number; line: string };
  STX006: { envName: string; expectedPath: string; baseEnvPath: string };
  /** The machine key file exists but could not be read. Distinct from STX003
   *  ("nowhere"): the key may well be in there. `reason` is the read error's
   *  message, which names the errno (EACCES, EISDIR, EBUSY…). */
  STX007: { machineEnvPath: string; reason: string };
  STX010: { serverUrl: string; reason: string };
  STX011: { envPath: string; serverUrl: string };
  STX012: { serverUrl: string };
  STX013: { serverUrl: string; status: number; bodyExcerpt?: string };
  STX014: { serverUrl: string; reason: string };
  STX020: { filePath: string };
  STX021: Record<string, never>;
  STX024: { detail: string };
  STX025: Record<string, never>;
  STX026: Record<string, never>;
  /** A foreign service answered STEPTIX_SERVER_URL. `service` is what it called
   *  itself, verbatim — naming it is what turns "the run failed" into "you
   *  pointed at Grafana". */
  STX027: { serverUrl: string; service: string };
  /** Auto-start failed. `reason` distinguishes the two ways it can (spawn
   *  refused up front vs never became healthy); `logPath` is where to look
   *  and `logTail` the last few lines when cheaply available. `runtimeDir` is
   *  set when what failed to start was the installed runtime rather than the
   *  command setting — the fix is then a different one. */
  STX028: {
    serverUrl: string;
    reason: string;
    logPath?: string;
    logTail?: string;
    runtimeDir?: string;
  };
  STX030: Record<string, never>;
  STX031: Record<string, never>;
  /** A chain member the chain cannot reach: an `Else if` / `Otherwise` that
   *  follows no decision — most often because an `[input:]` step sits between
   *  it and the `If` it belongs to — or one written BELOW the `Otherwise` that
   *  ended the chain. `detail` is `danglingChainMemberError`'s message, which
   *  is the CLI parser's own wording, naming the line and what is wrong with
   *  where it sits (stories/control-flow.md). */
  STX032: { detail: string };
  /** Auto-start would start a server somewhere other than `serverUrl`, so it
   *  did not start one. `servePort` is where the configured command listens
   *  and `servePortSource` why (its own `-p`, the machine STEPTIX_SERVER_URL,
   *  or the default); `urlSource` is where `serverUrl` came from. */
  STX033: { serverUrl: string; urlSource: string; servePort: number; servePortSource: string };
  /** No Steptix server could be had for the run (docs/specs/SPEC-install.md
   *  §5.2, §8): the user declined the install, the install failed (`detail`
   *  is why, in the user's terms), or this platform has no server yet
   *  (`detail` is §8.4's sentence). */
  STX034: { situation: 'declined' | 'cancelled' | 'failed' | 'no-node' | 'unsupported'; detail?: string };
  /** The running or chosen server does not match this extension's
   *  major.minor, and the extension may not replace it (§6.4, §6.5): a
   *  person started it, the user chose it, or it did not stop when asked. */
  STX035: {
    serverUrl: string;
    serverVersion: string;
    extensionVersion: string;
    reason: 'person' | 'chosen' | 'not-stopped';
  };
}

// ---------------------------------------------------------------------------
// Catalogue — the only place error text lives.
// ---------------------------------------------------------------------------

type Builder<C extends ErrorCode> = (ctx: ErrorContextMap[C]) => {
  diagnosis: string;
  fix: string;
  actions?: ErrorAction[];
};

const CATALOGUE: { [C in ErrorCode]: Builder<C> } = {
  STX001: (ctx) => ({
    diagnosis: `No .env file found for this test. Searched: ${ctx.searchedDirs.join(', ')}, then fallback setting "steptix.defaultEnvFile" (=${ctx.fallbackSetting || 'unset'})`,
    fix: 'Create the file "steptix.defaultEnvFile" names (or a .env next to this test), or clear the setting. A project needs no .env of its own: STEPTIX_SERVER_URL and STEPTIX_SERVER_API_KEY both fall back to the machine .env.',
    actions: [
      { label: 'Open Settings', command: 'workbench.action.openSettings', args: ['steptix.defaultEnvFile'] },
    ],
  }),
  STX003: (ctx) => ({
    diagnosis: `STEPTIX_SERVER_API_KEY is nowhere: not in ${ctx.envPath}, not in the VS Code process environment, and no machine key at ${ctx.machineEnvPath}`,
    fix: 'Start the server once and it writes the machine key there — Run does that for you when the Steptix runtime is installed or "steptix.serverAutoStart.command" is set, or run `steptix serve`. If a server is already running, it was started with a key this machine does not have: add STEPTIX_SERVER_API_KEY=<that key> to the machine key file or this project\'s .env.',
    actions: [{ label: 'Reveal .env', command: 'steptix.revealEnvFile' }],
  }),
  STX004: (ctx) => ({
    diagnosis: `STEPTIX_SERVER_URL in ${ctx.envPath} is not a valid URL: "${ctx.value}"`,
    fix: 'Use a full URL like http://localhost:3100 — include scheme, host, and port.',
    actions: [{ label: 'Reveal .env', command: 'steptix.revealEnvFile' }],
  }),
  STX005: (ctx) => ({
    diagnosis: `Could not parse ${ctx.envPath} at line ${ctx.lineNumber}: "${ctx.line}"`,
    fix: 'Each entry must be KEY=VALUE on its own line. Comments start with #.',
    actions: [{ label: 'Reveal .env', command: 'steptix.revealEnvFile' }],
  }),
  STX006: (ctx) => ({
    diagnosis: `Active environment "${ctx.envName}" is selected, but no .env.${ctx.envName} was found at ${ctx.expectedPath}`,
    fix: `Create .env.${ctx.envName} next to ${ctx.baseEnvPath}, or clear the env selection in the status bar (globe → env).`,
    actions: [{ label: 'Reveal .env', command: 'steptix.revealEnvFile' }],
  }),
  STX007: (ctx) => ({
    diagnosis: `Could not read the machine key file ${ctx.machineEnvPath}: ${ctx.reason}`,
    fix: 'Make sure it is a file your account can read and that no other program holds it locked, then run again.',
  }),
  STX010: (ctx) => ({
    diagnosis: `Cannot reach the Steptix server at ${ctx.serverUrl} (${ctx.reason})`,
    fix:
      "Start it with 'npx steptix serve' in your test project (or 'steptix serve' if the package is installed globally), then confirm STEPTIX_SERVER_URL names the host and port it is listening on. " +
      'If it runs on another machine, check the firewall. ' +
      'To have Steptix start it for you, install the Steptix runtime, or set "steptix.serverAutoStart.command" and ".cwd" in your user settings.',
    actions: [{ label: 'Show Run Log', command: 'steptix.showRunLog' }],
  }),
  STX011: (ctx) => ({
    diagnosis: `Server at ${ctx.serverUrl} rejected the API key (HTTP 401)`,
    fix:
      `The STEPTIX_SERVER_API_KEY Steptix sent (from ${ctx.envPath}, the process environment, ` +
      'or the machine key file) must match the key the server was started with.',
    actions: [{ label: 'Reveal .env', command: 'steptix.revealEnvFile' }],
  }),
  STX012: (ctx) => ({
    diagnosis: `Server at ${ctx.serverUrl} does not support streaming (?stream=1 returned 404)`,
    fix: 'Update the Steptix server — this extension requires a server build with SSE streaming.',
    actions: [],
  }),
  STX013: (ctx) => ({
    diagnosis: `Server at ${ctx.serverUrl} returned HTTP ${ctx.status} while starting the run${ctx.bodyExcerpt ? `: ${ctx.bodyExcerpt}` : ''}`,
    fix: "Check the server's terminal for a stack trace; this is a server-side bug or misconfiguration.",
    actions: [{ label: 'Show Run Log', command: 'steptix.showRunLog' }],
  }),
  STX014: (ctx) => ({
    diagnosis: `Connection to the server at ${ctx.serverUrl} was lost mid-run (${ctx.reason}). The session may still be running on the server.`,
    fix: 'Check the server is still up and re-run; use "Steptix: Stop" to abort the orphaned session.',
    actions: [{ label: 'Show Run Log', command: 'steptix.showRunLog' }],
  }),
  // No action: its "Reopen as Text" button named `steptix.reopenAsText`, a
  // command the extension neither contributes nor registers — a button that
  // could only fail. errors.test.js checks every action against package.json.
  STX020: (ctx) => ({
    diagnosis: `${ctx.filePath} has no "## Steps" heading, so there's nothing to run`,
    fix: 'Add a "## Steps" heading followed by a numbered list, or open as plain Markdown.',
  }),
  STX021: () => ({
    diagnosis: 'No step at or below the cursor to run',
    fix: 'Place the cursor on a numbered step under "## Steps", or use "Steptix: Run All".',
  }),
  STX024: (ctx) => ({
    diagnosis: `This test's inline sections can't be run as written — ${ctx.detail}`,
    fix: 'Fix the section heading and run again. The CLI refuses the same file, so running it here would execute something different from what `steptix run` does.',
  }),
  STX025: () => ({
    diagnosis: 'No runnable step at or below the cursor',
    fix: 'Place the cursor on a numbered step — in the main flow or inside a section body — or use "Steptix: Run All".',
  }),
  STX026: () => ({
    diagnosis: 'This test uses inline sections, which this editor cannot run',
    fix: 'Run it with the Steptix extension or the `steptix run` CLI — this variant would send the bare section-call step to the AI instead of expanding it.',
  }),
  // STX027 / STX028 carry no `actions`. Neither variant's UI renders that field
  // today, and these two codes are emitted only by the native variant — a
  // button no one draws, in the namespace of only one of the two extensions,
  // would be worse than putting the pointer in `fix`, which IS rendered.
  STX027: (ctx) => ({
    diagnosis: `${ctx.serverUrl} responds, but it is not a Steptix server (it identifies as "${ctx.service}")`,
    fix: 'Point STEPTIX_SERVER_URL at the Steptix server, or stop the other process holding that port. Steptix will not start a server on top of one it does not recognise.',
  }),
  STX028: (ctx) => ({
    diagnosis:
      `Could not auto-start the Steptix server for ${ctx.serverUrl} — ${ctx.reason}` +
      (ctx.logTail ? `. Last log lines: ${ctx.logTail}` : ''),
    fix: ctx.runtimeDir
      ? `Check the server log at ${ctx.logPath ?? 'the server log'} (command "Steptix: Show Server Log"). Steptix started the server installed in ${ctx.runtimeDir}: if its files are damaged, run "Steptix: Uninstall Server" and press Run to install it again, or set "steptix.serverAutoStart.command" and "steptix.serverAutoStart.cwd" in your USER settings to start something else — or start the server yourself.`
      : ctx.logPath
        ? `Check the server log at ${ctx.logPath} (command "Steptix: Show Server Log"), then fix "steptix.serverAutoStart.command" / "steptix.serverAutoStart.cwd" in your USER settings — or start the server yourself.`
        : 'Set "steptix.serverAutoStart.command" and "steptix.serverAutoStart.cwd" in your USER settings (they are machine-scoped and cannot be set per workspace) — or start the server yourself.',
  }),
  STX030: () => ({
    diagnosis: 'Steptix needs an open folder so it can resolve .env',
    fix: 'File → Open Folder and pick the folder containing your tests.',
  }),
  STX031: () => ({
    diagnosis: 'This session is also active in another VS Code window',
    fix: 'Stopping here will stop it everywhere.',
    actions: [
      { label: 'Stop Anyway', command: 'steptix.stop' },
      { label: 'Cancel', command: 'steptix.dismissError' },
    ],
  }),
  // Its own code rather than STX024's: that one's wording is section-specific
  // ("This test's inline sections can't be run as written"), and this refusal
  // has nothing to do with sections — it is about a chain the run cannot make
  // sense of. The `detail` is `danglingChainMemberError`'s message
  // (runner-core/src/step-lines.ts), which is the CLI parser's own wording and
  // already names the line and what it must follow — so the fix here says only
  // why the refusal comes before the run rather than during it, and does not
  // repeat advice the diagnosis has given.
  STX032: (ctx) => ({
    diagnosis: `This test can't be run as written — ${ctx.detail}`,
    fix: 'Edit the line and run again. Steptix refuses up front because a decision cannot be split across two requests: a member with nothing to be the alternative of would perform its branch unconditionally, and one written below the `Otherwise` that ended the chain is never the branch the decision picks.',
  }),
  STX033: (ctx) => ({
    diagnosis:
      `No Steptix server is running at ${ctx.serverUrl} (from ${ctx.urlSource}), and auto-start would start one on port ${ctx.servePort} (from ${ctx.servePortSource}) instead — so it did not start one`,
    fix: `Start the server for ${ctx.serverUrl} yourself with \`steptix serve -p ${portOf(ctx.serverUrl)}\`, add -p ${portOf(ctx.serverUrl)} after serve in "steptix.serverAutoStart.command", or point STEPTIX_SERVER_URL at port ${ctx.servePort}.`,
  }),
  STX034: (ctx) =>
    ctx.situation === 'declined'
      ? {
          diagnosis: 'The Steptix server is not installed, so this test could not run',
          fix: 'Press Run again and choose Install, or run "Steptix: Install Server". From a terminal, npm i -g steptix installs it too.',
        }
      : ctx.situation === 'cancelled'
        ? {
            // Cancel on an install's progress; an update that comes without
            // asking is cancelled the same way, so "choose Install" would
            // name a question the next Run may not ask.
            diagnosis: 'The Steptix server install was cancelled, so this test could not run',
            fix: 'Press Run again to install it, or run "Steptix: Install Server".',
          }
        : ctx.situation === 'no-node'
          ? {
              // The server is installed; what it runs on is missing (§4.6).
              diagnosis: `Steptix has no Node.js 22.21 or later to run its server on${ctx.detail ? `: ${ctx.detail}` : ''}`,
              fix: 'Install Node.js 22.21 or later from nodejs.org, then quit every VS Code window and open VS Code again, so it sees the new Node.js.',
            }
          : ctx.situation === 'unsupported'
            ? {
                diagnosis: ctx.detail ?? 'Steptix does not run on this platform yet',
                fix: 'Nothing was downloaded. Run your tests on a supported platform for now.',
              }
            : {
                diagnosis: `Could not install the Steptix server${ctx.detail ? `: ${ctx.detail}` : ''}`,
                fix: 'Press Run to try again. Without network access, install from the offline files on the Steptix release page instead.',
              },
  STX035: (ctx) =>
    ctx.reason === 'not-stopped'
      ? {
          diagnosis: `The Steptix server at ${ctx.serverUrl} (${ctx.serverVersion}) does not match this extension (${ctx.extensionVersion}), and it did not stop when asked`,
          fix: 'If a test is still running in it, let it finish. Then stop it with "Steptix: Stop Server" (or `steptix stop`) and press Run again.',
        }
      : ctx.reason === 'person'
      ? {
          diagnosis: `A Steptix server you started (${ctx.serverVersion}, at ${ctx.serverUrl}) does not match this extension (${ctx.extensionVersion})`,
          fix: 'Stop it and press Run again, or start a matching one yourself with `steptix serve`.',
        }
      : {
          diagnosis: `You chose Steptix server ${ctx.serverVersion}, but this extension is ${ctx.extensionVersion}`,
          fix: `Install extension ${minorOf(ctx.serverVersion)} to match (Extensions view → Steptix → Install Another Version), or go back to the newest server with \`steptix server use newest\`.`,
        },
};

/** `1.3` for `1.3.0`, for a sentence naming the extension to install. */
function minorOf(version: string): string {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  return m ? `${m[1]}.${m[2]}` : version;
}

/** `url`'s port as written, or its scheme's default — for a fix sentence, so
 *  never throws. */
function portOf(url: string): string {
  try {
    return String(serverUrlPort(url));
  } catch {
    return '<port>';
  }
}

/**
 * Build a structured error payload for a given code + context.
 *
 * This is the **only** approved way to produce error messages. Never
 * hand-format strings at call sites — the catalogue above is the single
 * source of truth for both wording and structure.
 */
export function reportError<C extends ErrorCode>(
  code: C,
  ctx: ErrorContextMap[C],
): ErrorPayload {
  const builder = CATALOGUE[code];
  const built = builder(ctx);
  return {
    code,
    diagnosis: built.diagnosis,
    fix: built.fix,
    message: `${code}: ${built.diagnosis}. ${built.fix}`,
    actions: built.actions ?? [],
  };
}

/** All registered codes — useful for tests and audits. */
export const ALL_ERROR_CODES: ErrorCode[] = Object.keys(CATALOGUE) as ErrorCode[];
