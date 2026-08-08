/**
 * Every pre-flight refusal the MCP server can emit, in one place.
 *
 * Two rules the rest of the code depends on:
 *
 * 1. **Pre-flight failures are returned, not thrown.** The SDK converts a
 *    thrown error into the same `{content, isError:true}` shape, so the two
 *    are indistinguishable to a host — but picking one keeps the tests honest
 *    and stops handlers from mixing styles.
 *
 * 2. **`isError` means "no run happened".** Once a request has reached the
 *    Sessions API, the result comes back as a normal payload whose `status`
 *    says what went wrong, because `isError` results carry no
 *    `structuredContent` — an agent would lose `sessionId`, `steps` and
 *    `reportPath` at exactly the moment it needs them.
 *
 * Centralised because these messages are the whole diagnostic surface for a
 * caller who cannot see the server's logs, and they are asserted verbatim in
 * tests. Spread across project/assemble/server-start they drift.
 */

export interface McpToolError {
  content: { type: 'text'; text: string }[];
  isError: true;
}

/** The one place `isError: true` is constructed. */
export function preflightError(text: string): McpToolError {
  return { content: [{ type: 'text', text }], isError: true };
}

const ROOTS_HINT =
  'Set AIUI_MCP_ROOTS to the directories this server may touch ' +
  `(${'separated by ' + (process.platform === 'win32' ? '";"' : '":"')}).`;

// ---------------------------------------------------------------------------
// Roots and project resolution
// ---------------------------------------------------------------------------

export function pathOutsideRoots(target: string, roots: readonly string[]): McpToolError {
  return preflightError(
    `Refusing to touch "${target}": it is outside every allowed root.\n` +
      `Allowed roots: ${roots.join(', ') || '(none)'}\n${ROOTS_HINT}`,
  );
}

/** A `project_root` was supplied alongside a `path` that does not live under
 *  it. Distinct from `pathOutsideRoots` so the message names the root the
 *  caller chose, not the allow-list they did not. */
export function pathOutsideProjectRoot(target: string, projectRoot: string): McpToolError {
  return preflightError(
    `"${target}" is not inside project_root "${projectRoot}".\n` +
      'Pass a project_root that contains the test file, or omit it and let the ' +
      'project be found by walking up from the file.',
  );
}

/** An `AIUI_MCP_ROOTS` entry that cannot be resolved. Refused rather than
 *  skipped: dropping it would quietly change the boundary. */
export function badRootEntry(entry: string, detail: string): McpToolError {
  return preflightError(
    `AIUI_MCP_ROOTS names a directory that cannot be resolved: "${entry}" (${detail}).\n` +
      `${ROOTS_HINT}`,
  );
}

export function projectRootUnresolvable(candidates: readonly string[]): McpToolError {
  return preflightError(
    'Could not decide which project to use.\n' +
      `Candidate roots: ${candidates.join(', ') || '(none)'}\n` +
      'Pass project_root explicitly, or set AIUI_MCP_ROOTS to a single directory.',
  );
}

export function noProjectConfig(searched: readonly string[]): McpToolError {
  return preflightError(
    'No aiui.config.json found, so there is no project to run against.\n' +
      `${ROOTS_HINT}\n` +
      `Searched: ${searched.join(', ')}`,
  );
}

/** The project's own config file is unreadable or is not JSON. Loud rather
 *  than skipped: silently walking past it would run against a *different*
 *  project than the one the caller is looking at. */
export function badProjectConfig(configPath: string, detail: string): McpToolError {
  return preflightError(`${configPath} could not be read as JSON: ${detail}`);
}

// ---------------------------------------------------------------------------
// Environment and server discovery
// ---------------------------------------------------------------------------

export function noServerUrl(envFiles: readonly string[]): McpToolError {
  return preflightError(
    'No SERVER_URL: cannot tell which Sessions API server to use.\n' +
      `Looked in: ${envFiles.join(', ')}, then the SERVER_URL environment variable.`,
  );
}

export function noServerApiKey(envFiles: readonly string[]): McpToolError {
  return preflightError(
    'No SERVER_API_KEY: the Sessions API rejects unauthenticated requests, ' +
      'and `aiui serve` exits rather than start without one.\n' +
      `Looked in: ${envFiles.join(', ')}, then the SERVER_API_KEY environment variable.`,
  );
}

export function badServerUrl(serverUrl: string, reason: string): McpToolError {
  return preflightError(`SERVER_URL "${serverUrl}" is unusable: ${reason}`);
}

export function unrecognizedService(baseUrl: string, detail: string): McpToolError {
  return preflightError(
    `${baseUrl} answered, but is not an ai-ui-automation server (${quoteForeign(detail)}).\n` +
      'Refusing to continue: the next request would send SERVER_API_KEY and the ' +
      "project's whole .env to whatever is listening there.",
  );
}

/**
 * Clamp text that came from an unidentified listener before it reaches the
 * agent.
 *
 * `probeHealth` builds this detail from the `service` field of whatever
 * answered — so an arbitrary local process chooses the string. Left unbounded
 * it is a free channel for injecting attacker-chosen instructions, of any
 * length, straight into the agent's context.
 */
function quoteForeign(detail: string): string {
  const flattened = detail
    // Control characters first - newlines especially, which would otherwise
    // let quoted text break out of its parenthetical and read as our prose.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flattened.length > 120 ? flattened.slice(0, 120) + "…" : flattened;
}

export function remoteServerDown(baseUrl: string): McpToolError {
  return preflightError(
    `${baseUrl} is not responding, and it is not a loopback address, so it will ` +
      'not be started automatically. Start the server yourself, or point ' +
      'SERVER_URL at localhost.',
  );
}

// ---------------------------------------------------------------------------
// Auto-start
// ---------------------------------------------------------------------------

export function distEntryMissing(distEntry: string): McpToolError {
  return preflightError(
    `Cannot start a server: ${distEntry} does not exist.\nRun \`npm run build\` first.`,
  );
}

export function autoStartFailed(command: string, logPath: string, logTail: string): McpToolError {
  return preflightError(
    `The server did not become healthy after being started.\n` +
      `Command: ${command}\nLog: ${logPath}\n\n${logTail || '(the server wrote nothing to the log before it gave up)'}`,
  );
}

export function autoStartSuppressed(
  command: string,
  logPath: string,
  logTail: string,
  retryInMs: number,
): McpToolError {
  return preflightError(
    `A start attempt failed recently; not retrying for another ${Math.ceil(retryInMs / 1000)}s.\n` +
      `Command: ${command}\nLog: ${logPath}\n\n${logTail || '(the server wrote nothing to the log before it gave up)'}`,
  );
}

export function unauthorized(projectEnvFiles: readonly string[], baseUrl: string): McpToolError {
  return preflightError(
    `${baseUrl} rejected our SERVER_API_KEY.\n` +
      `Ours came from: ${projectEnvFiles.join(', ')} (or the environment).\n` +
      "The server's came from whatever env file it was started with — if it was " +
      'started by hand, that is likely a different file.',
  );
}

// ---------------------------------------------------------------------------
// Test files and inputs
// ---------------------------------------------------------------------------

export function pathMustBeAbsolute(target: string): McpToolError {
  return preflightError(`"${target}" must be an absolute path.`);
}

export function testFileMissing(target: string): McpToolError {
  return preflightError(`No such file: ${target}`);
}

export function notATestFile(target: string, reason: string): McpToolError {
  return preflightError(`${target} cannot be run: ${reason}`);
}

export function parseFailed(absPath: string, message: string): McpToolError {
  return preflightError(`Cannot parse ${absPath}: ${message}`);
}

/** `run_steps` with nothing to run. The server 400s on this too, but only
 *  after a session has been created and a browser launched. */
export function emptySteps(): McpToolError {
  return preflightError('No steps to run: "steps" must contain at least one instruction.');
}

export function badEnvName(envName: string): McpToolError {
  return preflightError(
    `env_name "${envName}" is not a valid environment name. ` +
      'Use letters, digits, dot, underscore or hyphen only — it names a ' +
      '.env.<name> file beside aiui.config.json, not a path.',
  );
}

export function envFileMissing(message: string): McpToolError {
  return preflightError(message);
}

export function interpolationFailed(message: string): McpToolError {
  return preflightError(message);
}

export function badCdpPort(value: string): McpToolError {
  return preflightError(
    `## Config cdp: "${value}" is not a usable port. ` +
      'Expected an integer between 1 and 65535.',
  );
}

// ---------------------------------------------------------------------------
// CDP browsers (stories/mcp-cdp-browser.md §7)
//
// Every message here states three things: what was refused, why, and the
// specific next action. The third is part of the contract, not decoration. An
// agent given "permission denied" retries the same call or invents a
// workaround; an agent told "port 9222 is foreign — use one from `running`, or
// set mcp.cdp.allowUnowned" either fixes it or tells the user exactly what it
// needs from them. A message here without a next action is an incomplete
// implementation.
// ---------------------------------------------------------------------------

// Names the setting AND shows the JSON. The dotted name is what a human
// searches for and what the agent should say out loud when asking for it; the
// JSON is what they actually have to type.
const ALLOW_UNOWNED_HINT =
  'To let this agent drive browsers it did not start, a human must set ' +
  'mcp.cdp.allowUnowned in aiui.config.json:\n' +
  '  { "mcp": { "cdp": { "allowUnowned": true } } }\n' +
  'That file is deliberately outside an agent\'s reach — ask the user for it.';

/** `config.cdp` names a port that is not one of this project's running
 *  browsers. The middle clause — where it *was* found — is what turns this
 *  from a wall into a decision. */
export function cdpPortNotOwned(
  port: number,
  foundIn: 'foreign' | 'available' | 'nowhere',
  detail?: { profile?: string; engine?: string },
): McpToolError {
  const where =
    foundIn === 'foreign'
      ? `Port ${port} belongs to a browser this project did not start (it is listed under ` +
        '`foreign`). It could be anyone\'s browser — a developer\'s personal Chrome, ' +
        'another project\'s.'
      : foundIn === 'available'
        ? `Port ${port} is not open. The ${detail?.engine ?? ''} profile ` +
          `"${detail?.profile ?? 'unknown'}" exists but its browser has since been closed, ` +
          'and a browser\'s port dies with the process.'
        : `Port ${port} does not match any browser this project has launched.`;

  const next =
    foundIn === 'available'
      ? `Call start_cdp_browser with profile "${detail?.profile ?? ''}". It will return a ` +
        '**different** port and the profile will **still be signed in** — the login lives ' +
        'in the profile directory, not in the browser process. A closed browser is not a ' +
        'lost login.'
      : 'Call list_cdp_browsers and use a port from `running`; or launch one of the ' +
        '`available` profiles with start_cdp_browser.\n' +
        ALLOW_UNOWNED_HINT;

  return preflightError(`${where}\n\n${next}`);
}

/** A profile name that is not a single safe path component. */
export function badCdpProfileName(profile: string): McpToolError {
  return preflightError(
    `Profile name "${profile}" is not usable. It names a directory under ` +
      '.aiui/cdp-profiles/, so it may contain only letters, digits, dot, underscore and ' +
      'hyphen — no slashes and no "..".\n' +
      'Use a plain name: admin, uat, signup-test.',
  );
}

export function badCdpEngine(engine: string): McpToolError {
  return preflightError(
    `"${engine}" is not an engine this framework can launch. Use "chrome" or "edge".`,
  );
}

/** `config.cdp` gave neither address, or both.
 *
 *  Both is refused rather than resolved-and-compared: a port and a profile that
 *  disagree have no correct winner, and picking one in silence is precisely the
 *  failure this story exists to remove. */
export function cdpTargetAmbiguous(both: boolean): McpToolError {
  return preflightError(
    both
      ? 'config.cdp has both `profile` and `port`. They can name different ' +
        'browsers, so there is no safe way to choose between them.\n' +
        'Send one. Prefer `profile` — a port is reassigned every launch.'
      : 'config.cdp needs an address: give `profile` (preferred) or `port`.\n' +
        'Call list_cdp_browsers to see what this project has running.',
  );
}

/** `config.cdp.profile` names a profile with no browser running.
 *
 *  Deliberately NOT a launch. Starting a browser is a visible act that belongs
 *  to `start_cdp_browser`, so this hands the agent the exact call instead —
 *  including the reassurance about the login, since "not running" reads as
 *  "signed out" to a model and it is not. */
export function cdpProfileNotRunning(
  profile: string,
  engine: string | null,
  known: { engine: string; profile: string }[],
): McpToolError {
  const name = engine === null ? `"${profile}"` : `${engine} "${profile}"`;
  return preflightError(
    `No CDP browser is running for profile ${name}, so there is nothing to attach to.\n\n` +
      `Call start_cdp_browser with profile "${profile}"${engine === null ? '' : ` and engine "${engine}"`}. ` +
      'The profile directory still holds its logins — a closed browser is not a lost login.' +
      (known.length > 0
        ? `\n\nRunning now: ${known.map((b) => `${b.engine} "${b.profile}"`).join(', ')}.`
        : ''),
  );
}

/** Chrome and Edge are both running the same profile name. */
export function cdpProfileAmbiguous(profile: string, engines: string[]): McpToolError {
  return preflightError(
    `Profile "${profile}" is running under more than one engine ` +
      `(${engines.join(' and ')}), so it does not identify a browser on its own.\n` +
      `Add an engine: config.cdp: { profile: "${profile}", engine: "${engines[0]}" }.`,
  );
}

/**
 * `close_cdp_tab` gave neither address, or both.
 *
 * Separate from `cdpTargetAmbiguous` only in the field names it quotes: this
 * tool takes `profile`/`port` at the top level, and a message telling an agent
 * to fix `config.cdp` when there is no `config` in the call is a message that
 * cannot be acted on.
 */
export function cdpTabTargetAmbiguous(both: boolean): McpToolError {
  return preflightError(
    both
      ? 'Give `profile` or `port`, not both. They can name different browsers, ' +
        'so there is no safe way to choose between them — and this call closes ' +
        'a real tab.\n' +
        'Prefer `profile`: a port is reassigned every launch.'
      : 'close_cdp_tab needs to know which browser: give `profile` (preferred) ' +
        'or `port`.\n' +
        'Call list_cdp_browsers to see what this project has running, and to get ' +
        'the `targetId` of the tab you mean.',
  );
}

export function listSessionsTimedOut(timeoutMs: number): McpToolError {
  return preflightError(
    `Listing sessions took longer than ${timeoutMs}ms. The server reads each ` +
      "session's page title, so one busy or hung page can block the whole list.",
  );
}
