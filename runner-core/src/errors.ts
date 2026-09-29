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

export type ErrorCode =
  | 'STX001'
  | 'STX002'
  | 'STX003'
  | 'STX004'
  | 'STX005'
  | 'STX006'
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
  | 'STX032';

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
  STX002: { envPath: string };
  STX003: { envPath: string; machineEnvPath: string };
  STX004: { envPath: string; value: string };
  STX005: { envPath: string; lineNumber: number; line: string };
  STX006: { envName: string; expectedPath: string; baseEnvPath: string };
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
  /** A foreign service answered SERVER_URL. `service` is what it called
   *  itself, verbatim — naming it is what turns "the run failed" into "you
   *  pointed at Grafana". */
  STX027: { serverUrl: string; service: string };
  /** Auto-start failed. `reason` distinguishes the two ways it can (spawn
   *  refused up front vs never became healthy); `logPath` is where to look
   *  and `logTail` the last few lines when cheaply available. */
  STX028: { serverUrl: string; reason: string; logPath?: string; logTail?: string };
  STX030: Record<string, never>;
  STX031: Record<string, never>;
  /** A chain member the chain cannot reach: an `Else if` / `Otherwise` that
   *  follows no decision — most often because an `[input:]` step sits between
   *  it and the `If` it belongs to — or one written BELOW the `Otherwise` that
   *  ended the chain. `detail` is `danglingChainMemberError`'s message, which
   *  is the CLI parser's own wording, naming the line and what is wrong with
   *  where it sits (stories/control-flow.md). */
  STX032: { detail: string };
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
    fix: 'Create a .env next to this test (or any ancestor folder up to workspace root) with SERVER_URL, or set "steptix.defaultEnvFile" in Settings. STEPTIX_SERVER_API_KEY is optional — it falls back to the machine key.',
    actions: [
      { label: 'Open Settings', command: 'workbench.action.openSettings', args: ['steptix.defaultEnvFile'] },
    ],
  }),
  STX002: (ctx) => ({
    diagnosis: `SERVER_URL is missing from ${ctx.envPath}`,
    fix: 'Add a line like SERVER_URL=http://localhost:3100 (full URL including scheme and port).',
    actions: [{ label: 'Reveal .env', command: 'steptix.revealEnvFile' }],
  }),
  STX003: (ctx) => ({
    diagnosis: `STEPTIX_SERVER_API_KEY is nowhere: not in ${ctx.envPath}, not in the VS Code process environment, and no machine key at ${ctx.machineEnvPath}`,
    fix: 'Start the server once (`steptix serve` generates the machine key and writes it there), or add STEPTIX_SERVER_API_KEY=<key> to the machine key file or this project\'s .env.',
    actions: [{ label: 'Reveal .env', command: 'steptix.revealEnvFile' }],
  }),
  STX004: (ctx) => ({
    diagnosis: `SERVER_URL in ${ctx.envPath} is not a valid URL: "${ctx.value}"`,
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
  STX010: (ctx) => ({
    diagnosis: `Cannot reach the Steptix server at ${ctx.serverUrl} (${ctx.reason})`,
    fix:
      "Start it with 'npx steptix serve' in your test project (or 'steptix serve' if the package is installed globally), then confirm SERVER_URL names the host and port it is listening on. " +
      'If it runs on another machine, check the firewall. ' +
      'To have Steptix start it for you, configure "steptix.serverAutoStart.command" and ".cwd" in your user settings.',
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
  STX020: (ctx) => ({
    diagnosis: `${ctx.filePath} has no "## Steps" heading, so there's nothing to run`,
    fix: 'Add a "## Steps" heading followed by a numbered list, or open as plain Markdown.',
    actions: [{ label: 'Reopen as Text', command: 'steptix.reopenAsText' }],
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
    fix: 'Point SERVER_URL at the Steptix server, or stop the other process holding that port. Steptix will not start a server on top of one it does not recognise.',
  }),
  STX028: (ctx) => ({
    diagnosis:
      `Could not auto-start the Steptix server for ${ctx.serverUrl} — ${ctx.reason}` +
      (ctx.logTail ? `. Last log lines: ${ctx.logTail}` : ''),
    fix: ctx.logPath
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
