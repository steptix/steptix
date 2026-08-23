/**
 * Error catalogue — single source of truth for all user-facing failure modes.
 *
 * Every error reaches the user via two channels: an inline run-log banner in
 * the webview and the "TestBench" output channel. Both carry the same payload
 * built by reportError().
 *
 * Format rule: `TBxxx: <what's wrong>. <verb-led fix>.` Never end on the
 * diagnosis alone. Always include the absolute path of any file involved and
 * the literal name of any setting key involved so the user can grep.
 */

export type ErrorCode =
  | 'TB001'
  | 'TB002'
  | 'TB003'
  | 'TB004'
  | 'TB005'
  | 'TB006'
  | 'TB010'
  | 'TB011'
  | 'TB012'
  | 'TB013'
  | 'TB014'
  | 'TB020'
  | 'TB021'
  | 'TB024'
  | 'TB025'
  | 'TB026'
  | 'TB027'
  | 'TB028'
  | 'TB030'
  | 'TB031';

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
  TB001: { searchedDirs: string[]; fallbackSetting: string };
  TB002: { envPath: string };
  TB003: { envPath: string; machineEnvPath: string };
  TB004: { envPath: string; value: string };
  TB005: { envPath: string; lineNumber: number; line: string };
  TB006: { envName: string; expectedPath: string; baseEnvPath: string };
  TB010: { serverUrl: string; reason: string };
  TB011: { envPath: string; serverUrl: string };
  TB012: { serverUrl: string };
  TB013: { serverUrl: string; status: number; bodyExcerpt?: string };
  TB014: { serverUrl: string; reason: string };
  TB020: { filePath: string };
  TB021: Record<string, never>;
  TB024: { detail: string };
  TB025: Record<string, never>;
  TB026: Record<string, never>;
  /** A foreign service answered SERVER_URL. `service` is what it called
   *  itself, verbatim — naming it is what turns "the run failed" into "you
   *  pointed at Grafana". */
  TB027: { serverUrl: string; service: string };
  /** Auto-start failed. `reason` distinguishes the two ways it can (spawn
   *  refused up front vs never became healthy); `logPath` is where to look
   *  and `logTail` the last few lines when cheaply available. */
  TB028: { serverUrl: string; reason: string; logPath?: string; logTail?: string };
  TB030: Record<string, never>;
  TB031: Record<string, never>;
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
  TB001: (ctx) => ({
    diagnosis: `No .env file found for this test. Searched: ${ctx.searchedDirs.join(', ')}, then fallback setting "testbench.defaultEnvFile" (=${ctx.fallbackSetting || 'unset'})`,
    fix: 'Create a .env next to this test (or any ancestor folder up to workspace root) with SERVER_URL, or set "testbench.defaultEnvFile" in Settings. AIUI_SERVER_API_KEY is optional — it falls back to the machine key.',
    actions: [
      { label: 'Open Settings', command: 'workbench.action.openSettings', args: ['testbench.defaultEnvFile'] },
    ],
  }),
  TB002: (ctx) => ({
    diagnosis: `SERVER_URL is missing from ${ctx.envPath}`,
    fix: 'Add a line like SERVER_URL=http://localhost:3100 (full URL including scheme and port).',
    actions: [{ label: 'Reveal .env', command: 'testbench.revealEnvFile' }],
  }),
  TB003: (ctx) => ({
    diagnosis: `AIUI_SERVER_API_KEY is nowhere: not in ${ctx.envPath}, not in the VS Code process environment, and no machine key at ${ctx.machineEnvPath}`,
    fix: 'Start the server once (`aiui serve` generates the machine key and writes it there), or add AIUI_SERVER_API_KEY=<key> to the machine key file or this project\'s .env.',
    actions: [{ label: 'Reveal .env', command: 'testbench.revealEnvFile' }],
  }),
  TB004: (ctx) => ({
    diagnosis: `SERVER_URL in ${ctx.envPath} is not a valid URL: "${ctx.value}"`,
    fix: 'Use a full URL like http://localhost:3100 — include scheme, host, and port.',
    actions: [{ label: 'Reveal .env', command: 'testbench.revealEnvFile' }],
  }),
  TB005: (ctx) => ({
    diagnosis: `Could not parse ${ctx.envPath} at line ${ctx.lineNumber}: "${ctx.line}"`,
    fix: 'Each entry must be KEY=VALUE on its own line. Comments start with #.',
    actions: [{ label: 'Reveal .env', command: 'testbench.revealEnvFile' }],
  }),
  TB006: (ctx) => ({
    diagnosis: `Active environment "${ctx.envName}" is selected, but no .env.${ctx.envName} was found at ${ctx.expectedPath}`,
    fix: `Create .env.${ctx.envName} next to ${ctx.baseEnvPath}, or clear the env selection in the status bar (globe → env).`,
    actions: [{ label: 'Reveal .env', command: 'testbench.revealEnvFile' }],
  }),
  TB010: (ctx) => ({
    diagnosis: `Cannot reach the ai-ui-automation server at ${ctx.serverUrl} (${ctx.reason})`,
    fix:
      "Start it with 'npx aiui serve' in your test project (or 'aiui serve' if the package is installed globally), then confirm SERVER_URL names the host and port it is listening on. " +
      'If it runs on another machine, check the firewall. ' +
      'To have TestBench start it for you, configure "testbench-native.serverAutoStart.command" and ".cwd" in your user settings.',
    actions: [{ label: 'Show Run Log', command: 'testbench.showRunLog' }],
  }),
  TB011: (ctx) => ({
    diagnosis: `Server at ${ctx.serverUrl} rejected the API key (HTTP 401)`,
    fix:
      `The AIUI_SERVER_API_KEY TestBench sent (from ${ctx.envPath}, the process environment, ` +
      'or the machine key file) must match the key the server was started with.',
    actions: [{ label: 'Reveal .env', command: 'testbench.revealEnvFile' }],
  }),
  TB012: (ctx) => ({
    diagnosis: `Server at ${ctx.serverUrl} does not support streaming (?stream=1 returned 404)`,
    fix: 'Update the ai-ui-automation server — this extension requires a server build with SSE streaming.',
    actions: [],
  }),
  TB013: (ctx) => ({
    diagnosis: `Server at ${ctx.serverUrl} returned HTTP ${ctx.status} while starting the run${ctx.bodyExcerpt ? `: ${ctx.bodyExcerpt}` : ''}`,
    fix: "Check the server's terminal for a stack trace; this is a server-side bug or misconfiguration.",
    actions: [{ label: 'Show Run Log', command: 'testbench.showRunLog' }],
  }),
  TB014: (ctx) => ({
    diagnosis: `Connection to the server at ${ctx.serverUrl} was lost mid-run (${ctx.reason}). The session may still be running on the server.`,
    fix: 'Check the server is still up and re-run; use "TestBench: Stop" to abort the orphaned session.',
    actions: [{ label: 'Show Run Log', command: 'testbench.showRunLog' }],
  }),
  TB020: (ctx) => ({
    diagnosis: `${ctx.filePath} has no "## Steps" heading, so there's nothing to run`,
    fix: 'Add a "## Steps" heading followed by a numbered list, or open as plain Markdown.',
    actions: [{ label: 'Reopen as Text', command: 'testbench.reopenAsText' }],
  }),
  TB021: () => ({
    diagnosis: 'No step at or below the cursor to run',
    fix: 'Place the cursor on a numbered step under "## Steps", or use "TestBench: Run All".',
  }),
  TB024: (ctx) => ({
    diagnosis: `This test's inline sections can't be run as written — ${ctx.detail}`,
    fix: 'Fix the section heading and run again. The CLI refuses the same file, so running it here would execute something different from what `aiui run` does.',
  }),
  TB025: () => ({
    diagnosis: 'No runnable step at or below the cursor',
    fix: 'Place the cursor on a numbered step — in the main flow or inside a section body — or use "TestBench: Run All".',
  }),
  TB026: () => ({
    diagnosis: 'This test uses inline sections, which this editor cannot run',
    fix: 'Run it with the TestBench (Native) extension or the `aiui run` CLI — this variant would send the bare section-call step to the AI instead of expanding it.',
  }),
  // TB027 / TB028 carry no `actions`. Neither variant's UI renders that field
  // today, and these two codes are emitted only by the native variant — a
  // button no one draws, in the namespace of only one of the two extensions,
  // would be worse than putting the pointer in `fix`, which IS rendered.
  TB027: (ctx) => ({
    diagnosis: `${ctx.serverUrl} responds, but it is not an ai-ui-automation server (it identifies as "${ctx.service}")`,
    fix: 'Point SERVER_URL at the ai-ui-automation server, or stop the other process holding that port. TestBench will not start a server on top of one it does not recognise.',
  }),
  TB028: (ctx) => ({
    diagnosis:
      `Could not auto-start the ai-ui-automation server for ${ctx.serverUrl} — ${ctx.reason}` +
      (ctx.logTail ? `. Last log lines: ${ctx.logTail}` : ''),
    fix: ctx.logPath
      ? `Check the server log at ${ctx.logPath} (command "TestBench: Show Server Log"), then fix "testbench-native.serverAutoStart.command" / "testbench-native.serverAutoStart.cwd" in your USER settings — or start the server yourself.`
      : 'Set "testbench-native.serverAutoStart.command" and "testbench-native.serverAutoStart.cwd" in your USER settings (they are machine-scoped and cannot be set per workspace) — or start the server yourself.',
  }),
  TB030: () => ({
    diagnosis: 'TestBench needs an open folder so it can resolve .env',
    fix: 'File → Open Folder and pick the folder containing your tests.',
  }),
  TB031: () => ({
    diagnosis: 'This session is also active in another VS Code window',
    fix: 'Stopping here will stop it everywhere.',
    actions: [
      { label: 'Stop Anyway', command: 'testbench.stop' },
      { label: 'Cancel', command: 'testbench.dismissError' },
    ],
  }),
};

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
