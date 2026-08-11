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

// Type-only, so the value-level dependency stays one-directional
// (`types.ts` → `errors.ts`) and no runtime cycle exists.
import type { RootScope } from './types.js';

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

/** `run_test_file` / `list_test_files` resolved to the user root. Test files
 *  are project-shaped and the user root deliberately holds none
 *  (stories/mcp-no-project.md) — so this is a refusal, not a fallback. */
export function testsNeedProject(userRoot: string): McpToolError {
  return preflightError(
    `Test files belong to a project, and ${userRoot} is the machine-wide user ` +
      'root, not a project — it holds your browsers and machine defaults, ' +
      'never tests.\n' +
      'Run against a directory whose aiui.config.json defines the tests, or ' +
      'pass project_root pointing at one.',
  );
}

/**
 * `run_steps` in project-less mode with `[skill:]` / `[tool:]` steps.
 *
 * Refused up front rather than sent: without a `skillsDir`/`toolsDir` on the
 * wire the server ships these lines to the AI as prose — a silent, expensive
 * wrong answer three layers down. And they cannot be given a directory,
 * deliberately: a machine-global skills or tools directory would mean any
 * conversation, in any directory, executes code from a path no repo owns and
 * no review covers (stories/mcp-no-project.md, locked).
 */
export function projectlessCodeSteps(
  offending: readonly string[],
  searched: readonly string[],
): McpToolError {
  const where =
    searched.length > 0
      ? `No aiui.config.json was found (searched: ${searched.join(', ')}).`
      : 'This call resolved to the machine-wide user root, which never holds skills or tools.';
  return preflightError(
    `${offending.length} step(s) invoke a skill or tool, but no project resolved — ` +
      'and skills and tools are code, code belongs to a project, so ' +
      'project-less runs refuse them rather than sending them to the AI as prose.\n' +
      `${where}\n` +
      `Steps: ${offending.map((step) => JSON.stringify(step)).join(', ')}\n` +
      'Run from inside the project (or pass project_root) to use its skills ' +
      'and tools. Plain-English steps work fine without a project.',
  );
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

/**
 * A Sessions API server is up, and we have no key to talk to it with.
 *
 * The one missing-key case that stays a refusal (stories/machine-key.md): a
 * running server holds whatever key *it* was started with, so generating a
 * fresh one here would only manufacture a 401. Against a *down* server the
 * key is generated instead, which is why this error names a live server.
 */
export function noKeyForRunningServer(
  baseUrl: string,
  userRootEnvPath: string,
): McpToolError {
  return preflightError(
    `A Sessions API server is running at ${baseUrl}, but no AIUI_SERVER_API_KEY is ` +
      'available to authenticate with it — none in the project `.env`, the ' +
      `environment, or ${userRootEnvPath}.\n` +
      'A key cannot be generated for a server that already holds one. Write ' +
      `the key that server was started with to ${userRootEnvPath}, or stop the ` +
      'server and let the next call start one on the machine key.',
  );
}

export function badServerUrl(serverUrl: string, reason: string): McpToolError {
  return preflightError(`SERVER_URL "${serverUrl}" is unusable: ${reason}`);
}

export function unrecognizedService(baseUrl: string, detail: string): McpToolError {
  return preflightError(
    `${baseUrl} answered, but is not an ai-ui-automation server (${quoteForeign(detail)}).\n` +
      'Refusing to continue: the next request would send AIUI_SERVER_API_KEY and the ' +
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
    `${baseUrl} rejected our AIUI_SERVER_API_KEY.\n` +
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

/**
 * Names the setting AND shows the JSON. The dotted name is what a human
 * searches for and what the agent should say out loud when asking for it; the
 * JSON is what they actually have to type.
 *
 * Takes the resolved config path rather than hardcoding "aiui.config.json"
 * because the answer differs by scope: for a project it is the project's own
 * file, and for a project-less call it is `<user root>/aiui.config.json` — a
 * file that may not exist yet, since nothing machine-writes it. This message
 * is the only discovery path there is for that file
 * (stories/mcp-no-project.md, open question resolved), so it must name the
 * exact path.
 */
function allowUnownedHint(configPath: string): string {
  return (
    'To let this agent drive browsers it did not start, a human must set ' +
    `mcp.cdp.allowUnowned in ${configPath} (creating the file if it does not ` +
    'exist yet):\n' +
    '  { "mcp": { "cdp": { "allowUnowned": true } } }\n' +
    'That file is deliberately outside an agent\'s reach — ask the user for it.'
  );
}

/** `config.cdp` names a port that is not one of the running browsers of
 *  either root this call can see. The middle clause — where it *was* found —
 *  is what turns this from a wall into a decision. */
export function cdpPortNotOwned(
  port: number,
  foundIn: 'foreign' | 'available' | 'nowhere',
  configPath: string,
  detail?: { profile?: string; engine?: string },
): McpToolError {
  const where =
    foundIn === 'foreign'
      ? `Port ${port} belongs to a browser this framework did not start here (it is listed ` +
        'under `foreign`) — it traces back to neither this call\'s project nor the user ' +
        'root. It could be anyone\'s browser — a developer\'s personal Chrome, another ' +
        'machine account\'s.'
      : foundIn === 'available'
        ? `Port ${port} is not open. The ${detail?.engine ?? ''} profile ` +
          `"${detail?.profile ?? 'unknown'}" exists but its browser has since been closed, ` +
          'and a browser\'s port dies with the process.'
        : `Port ${port} does not match any browser this call can see.`;

  const next =
    foundIn === 'available'
      ? `Call start_cdp_browser with profile "${detail?.profile ?? ''}". It will return a ` +
        '**different** port and the profile will **still be signed in** — the login lives ' +
        'in the profile directory, not in the browser process. A closed browser is not a ' +
        'lost login.'
      : 'Call list_cdp_browsers and use a port from `running`; or launch one of the ' +
        '`available` profiles with start_cdp_browser.\n' +
        allowUnownedHint(configPath);

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

/** The facts of a `profile`/`port` pair that does not name one browser: every
 *  running browser bearing the name (with the port each is actually on), and
 *  the port the caller sent instead. */
export interface CdpAddressMismatch {
  profile: string;
  matches: { engine: string; scope?: RootScope; port: number }[];
  given: number;
}

/** `edge "default" is on port 51000, but the call says port 9999` — the
 *  mismatch facts, shared by the three per-tool messages so the same pair
 *  reads the same way from every tool. */
function describeMismatch(m: CdpAddressMismatch): string {
  const where = m.matches
    .map((b) => `${describeBrowser({ ...b, profile: m.profile })} is on port ${b.port}`)
    .join(', ');
  return `${where}, but the call says port ${m.given}`;
}

/** The remedy for a disagreeing pair, identical everywhere it can happen. */
const MISMATCH_REMEDY =
  'A port is reassigned every launch, so the port is the likelier stale half: ' +
  'drop it and keep `profile`, or call list_cdp_browsers for the current pairing.';

/** `config.cdp` gave no address at all, or a `profile`/`port` pair that does
 *  not name one browser — the port belongs to a different browser, or to none.
 *
 *  A pair that AGREES never lands here — it is accepted upstream, because an
 *  agent that just read a listing row holds both halves of one address and
 *  echoing them back is precision, not ambiguity. What still has no correct
 *  winner is a pair that disagrees, and picking one in silence is precisely
 *  the failure this story exists to remove — so the message states both facts
 *  and makes the agent choose. */
export function cdpTargetAmbiguous(mismatch: CdpAddressMismatch | null): McpToolError {
  return preflightError(
    mismatch !== null
      ? 'config.cdp\'s `profile` and `port` disagree: ' +
        `${describeMismatch(mismatch)}. Nothing is picked for you — the wrong ` +
        'pick is a browser signed in as somebody else.\n' +
        MISMATCH_REMEDY
      : 'config.cdp needs an address: give `profile` (preferred) or `port`.\n' +
        'Call list_cdp_browsers to see what this project has running.',
  );
}

/** `chrome "default" (user root)` — one spelling for every message that lists
 *  browsers, so a reader can compare across refusals. The scope tag appears
 *  only for the user root: a bare name has always meant the project's own
 *  browser, and re-labelling those would make every old message read as new. */
export function describeBrowser(b: {
  engine: string;
  profile: string;
  scope?: RootScope | undefined;
}): string {
  return `${b.engine} "${b.profile}"${b.scope === 'user' ? ' (user root)' : ''}`;
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
  known: { engine: string; profile: string; scope?: RootScope }[],
): McpToolError {
  const name = engine === null ? `"${profile}"` : `${engine} "${profile}"`;
  return preflightError(
    `No CDP browser is running for profile ${name}, so there is nothing to attach to.\n\n` +
      `Call start_cdp_browser with profile "${profile}"${engine === null ? '' : ` and engine "${engine}"`}. ` +
      'The profile directory still holds its logins — a closed browser is not a lost login.' +
      (known.length > 0
        ? `\n\nRunning now: ${known.map((b) => describeBrowser(b)).join(', ')}.`
        : ''),
  );
}

/**
 * One profile name, more than one running browser — Chrome and Edge sharing a
 * name, the project and the user root sharing one, or both at once.
 *
 * Refused rather than resolved by precedence (stories/mcp-no-project.md,
 * locked): the same words must mean the same browser from every directory,
 * and the wrong pick is a browser signed in as somebody else.
 */
export function cdpProfileAmbiguous(
  profile: string,
  matches: { engine: string; scope?: RootScope }[],
): McpToolError {
  const named = matches
    .map((m) => `${m.engine} "${profile}"${m.scope === 'user' ? ' (user root)' : ' (project)'}`)
    .join(', ');
  const enginesDiffer = new Set(matches.map((m) => m.engine)).size > 1;
  const scopesDiffer = new Set(matches.map((m) => m.scope ?? 'project')).size > 1;
  // The example carries ONLY the field(s) that actually disambiguate this
  // case: adding `scope` to an engine-only clash (both project) would match
  // nothing, and copying the example verbatim would then fail. `matches[0]`
  // is a real running browser, so the example resolves to it.
  const first = matches[0]!;
  const fields = [
    ...(enginesDiffer ? [`engine: "${first.engine}"`] : []),
    ...(scopesDiffer ? [`scope: "${first.scope ?? 'project'}"`] : []),
  ];
  const which = [
    ...(enginesDiffer ? ['engine'] : []),
    ...(scopesDiffer ? ['scope'] : []),
  ].join(' and/or ');
  return preflightError(
    `Profile "${profile}" is running more than once (${named}), so the name does ` +
      'not identify a browser on its own — and nothing is picked for you, because ' +
      'the wrong pick is a browser signed in as somebody else.\n' +
      `Say which you mean by adding ${which || 'engine and/or scope'}: e.g. ` +
      `{ profile: "${profile}"${fields.length > 0 ? ', ' + fields.join(', ') : ''} }.`,
  );
}

/**
 * `close_cdp_tab` gave no address, or a `profile`/`port` pair that disagrees.
 *
 * Separate from `cdpTargetAmbiguous` only in the field names it quotes: this
 * tool takes `profile`/`port` at the top level, and a message telling an agent
 * to fix `config.cdp` when there is no `config` in the call is a message that
 * cannot be acted on.
 */
export function cdpTabTargetAmbiguous(mismatch: CdpAddressMismatch | null): McpToolError {
  return preflightError(
    mismatch !== null
      ? '`profile` and `port` disagree: ' +
        `${describeMismatch(mismatch)} — and this call closes a real tab, so ` +
        'nothing is picked for you.\n' +
        MISMATCH_REMEDY
      : 'close_cdp_tab needs to know which browser: give `profile` (preferred) ' +
        'or `port`.\n' +
        'Call list_cdp_browsers to see what this project has running, and to get ' +
        'the `targetId` of the tab you mean.',
  );
}

/**
 * `focus_cdp_tab` gave no address, or a `profile`/`port` pair that disagrees.
 *
 * Separate from `cdpTabTargetAmbiguous` in more than field names: closing the
 * wrong tab cannot be undone, so that message leans on the stakes. Focusing the
 * wrong one is a nuisance, and saying otherwise would teach an agent to weigh
 * the two calls the same way. The rule is identical because two identical
 * interfaces over one listing beat two rules a model has to remember which is
 * which.
 */
export function cdpFocusTargetAmbiguous(mismatch: CdpAddressMismatch | null): McpToolError {
  return preflightError(
    mismatch !== null
      ? '`profile` and `port` disagree: ' +
        `${describeMismatch(mismatch)} — and picking one for you could put ` +
        'the wrong window in front of the user.\n' +
        MISMATCH_REMEDY
      : 'focus_cdp_tab needs to know which browser: give `profile` (preferred) ' +
        'or `port`.\n' +
        'Call list_cdp_browsers to see what this project has running, and to get ' +
        'the `targetId` of the tab you mean.',
  );
}

/** The server answered 404 with its own message: no tab by that id. The prose
 *  is the registry's, because it is the layer that knows which browser was
 *  looked in — it names the id, both readings (already closed, or an id from a
 *  different browser) and the call that refreshes the list. Passed through
 *  rather than wrapped in "the server rejected the request (HTTP 404)", which
 *  would bury an actionable message under a transport one. */
export function cdpFocusTabNotFound(serverMessage: string): McpToolError {
  return preflightError(serverMessage);
}

/**
 * A 404 with no message of ours in it — so the *route* is missing, not the tab.
 *
 * Reachable without doing anything wrong: pull this branch, restart the MCP
 * server, and the Sessions API server from the previous build is still holding
 * the port. There is no version check, only an identity one. Without this row
 * the agent is told the user's tab has been closed, which is both false and
 * unfixable by anything it can do next.
 */
export function cdpFocusRouteMissing(baseUrl: string): McpToolError {
  return preflightError(
    `${baseUrl} has no tab-focus route, so it is running a build that predates ` +
      'this tool. **The tab is fine** — nothing was looked up.\n\n' +
      'Rebuild and restart the Sessions API server: `npm run build`, then stop ' +
      'the running server and start it again. Ask the user to do it if you ' +
      'cannot.',
  );
}

export function listSessionsTimedOut(timeoutMs: number): McpToolError {
  return preflightError(
    `Listing sessions took longer than ${timeoutMs}ms. The server reads each ` +
      "session's page title, so one busy or hung page can block the whole list.",
  );
}
