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
  TB003: { envPath: string };
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
    fix: 'Create a .env next to this test (or any ancestor folder up to workspace root) with SERVER_URL and SERVER_API_KEY, or set "testbench.defaultEnvFile" in Settings.',
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
    diagnosis: `SERVER_API_KEY is missing from ${ctx.envPath}`,
    fix: 'Add SERVER_API_KEY=<your-key>. The key must match what the ai-ui-automation server was started with.',
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
    fix: "Start the server (run 'npx tsx src/index.ts serve' in the ai-ui-automation repo) and confirm it's listening on the host and port in SERVER_URL. If running on another machine, check the firewall.",
    actions: [{ label: 'Show Run Log', command: 'testbench.showRunLog' }],
  }),
  TB011: (ctx) => ({
    diagnosis: `Server at ${ctx.serverUrl} rejected the API key (HTTP 401)`,
    fix: `SERVER_API_KEY in ${ctx.envPath} must match the SERVER_API_KEY the server was started with.`,
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
    fix: 'Section bodies run only when a step calls them by name — place the cursor on a step in the main flow, or use "TestBench: Run All".',
  }),
  TB026: () => ({
    diagnosis: 'This test uses inline sections, which this editor cannot run',
    fix: 'Run it with the TestBench (Native) extension or the `aiui run` CLI — this variant would send the bare section-call step to the AI instead of expanding it.',
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
