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
import type { CdpTab, RootScope } from './types.js';

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

// ---------------------------------------------------------------------------
// Errands (stories/errands.md)
//
// The first two are the story's "wrong doors redirect" layer: a misrouted
// call is answered with one self-correcting sentence naming the other tool,
// which turns a wrong pick into one extra round-trip instead of a wrong run.
// ---------------------------------------------------------------------------

/**
 * `run_errand` was called with a NON-EMPTY `session_id`.
 *
 * The argument is declared ONLY so this refusal can exist. A bare Zod schema
 * would strip an undeclared key in silence — the wrong-door silence errands
 * exist to kill — and an SDK schema throw carries only generic text no model
 * learns from.
 *
 * An empty/whitespace `session_id` never reaches this builder: some provider
 * layers serialize every declared optional as `""`, so a model told to "call
 * again without session_id" physically cannot — the handler treats `""` as
 * absent instead (measured live, OpenCode + gpt-5.6-luna, 2026-08-13).
 */
export function errandsHaveNoSessions(sessionId: string): McpToolError {
  return preflightError(
    `Errands have no sessions, so session_id "${sessionId}" cannot be honoured — ` +
      'and it is refused rather than ignored, because the two tools do different ' +
      'jobs.\n' +
      'An errand borrows a tab the user already has open, drives it for ONE ' +
      'request, and keeps nothing: no session, no browser of its own, no ' +
      'variables held over.\n' +
      'If you want state to persist across calls — a session to come back to — ' +
      'use run_steps with that session_id. If you want this tab driven now, call ' +
      'run_errand again without session_id.',
  );
}

/**
 * `[skill:]` / `[tool:]` in an errand's steps.
 *
 * The same token rule `run_steps` refuses in user scope, and for the same
 * reason: an errand deliberately carries no `skillsDir`/`toolsDir`, and the
 * server's behaviour for such a line with no directory on the wire is to hand
 * it to the AI as prose — a silent, expensive wrong answer three layers down.
 */
export function errandCodeSteps(offending: readonly string[]): McpToolError {
  return preflightError(
    `${offending.length} step(s) invoke a skill or tool, but an errand carries ` +
      'neither: it borrows a tab and runs plain steps in it, with no project ' +
      'skills or tools directory on the wire — so these would reach the AI as ' +
      'prose rather than executing.\n' +
      `Steps: ${offending.map((step) => JSON.stringify(step)).join(', ')}\n` +
      'Rewrite them as plain-English steps, or use run_steps in the project, ' +
      'which does send those directories.',
  );
}

/** `"OpenRouter — Docs" — https://openrouter.ai/docs (targetId: A1B2C3)`, the
 *  one spelling both tab refusals use, so a caller can compare a candidate list
 *  against a "what is open" list without re-reading two formats. */
function describeTab(tab: CdpTab): string {
  return `"${tab.title}" — ${tab.url} (targetId: ${tab.targetId})`;
}

/**
 * `run_errand`'s `tab` matched nothing.
 *
 * Answered with the browser's whole tab list, so the caller can re-name one
 * from what is actually open rather than guessing again. This is the refusal
 * that makes a name-shaped `tab` argument safe at all: the alternative to
 * "several candidates, say which" is the first-match-wins rule
 * stories/cdp-tabs.md refuses.
 */
export function errandTabNotFound(
  spec: string,
  browser: string,
  tabs: readonly CdpTab[],
): McpToolError {
  return preflightError(
    `No tab in ${browser} matches "${spec}", so there is nothing to borrow.\n\n` +
      (tabs.length > 0
        ? `Open tabs:\n${tabs.map((t) => `  ${describeTab(t)}`).join('\n')}\n\n` +
          'Name one of these — a distinctive part of its title or url, or ' +
          '`targetId:<id>` for the exact tab.'
        : 'That browser reports no tabs at all. Call list_cdp_browsers to see ' +
          'what is running, and check the profile is the one you meant.'),
  );
}

/**
 * `run_errand`'s `tab` matched more than one.
 *
 * Every candidate is named with all three of its identifiers, because the
 * caller has to pick between them and a title alone is routinely duplicated
 * (two "Inbox" tabs, two docs pages). Nothing is picked for you: driving the
 * wrong tab types into somebody's real, signed-in page.
 */
export function errandTabAmbiguous(spec: string, matches: readonly CdpTab[]): McpToolError {
  return preflightError(
    `"${spec}" matches ${matches.length} open tabs, so it does not name one — ` +
      'and nothing is picked for you, because an errand DRIVES the tab it ' +
      'borrows.\n\n' +
      `${matches.map((t) => `  ${describeTab(t)}`).join('\n')}\n\n` +
      'Say which by passing `targetId:<id>`, or a substring that appears in ' +
      'only one of them.',
  );
}

/**
 * The stream came back with no errand block, and with no step event either.
 *
 * The runner builds the accounting in a `finally` and emits the `done` frame
 * after it, and the step loop is wrapped so a throw becomes that frame's
 * `status: 'error'` rather than escaping — so the block rides every `done` an
 * errand itself emits, including a failing one.
 *
 * Its absence is therefore not enough on its own: a stream can also die
 * mid-errand, after steps have driven the tab, with no `done` frame at all (a
 * force shutdown, a crashed server, a proxy that gave up). **The caller decides
 * between the two on the step events**, and this refusal is for the half with
 * none — the request died before the tab was ever borrowed (the attach refused,
 * or the route's own catch answered), so there is no receipt to return and
 * nothing ran. The other half keeps its folded steps and captures and says the
 * tab was driven (`unfinishedErrandResult` in src/mcp/tools.ts).
 *
 * `isError` is therefore right here and wrong for a failed step — and wrong for
 * a truncated stream: this is the "no run happened" case the contract reserves
 * it for.
 */
export function errandDidNotAttach(tab: string, detail: string | null): McpToolError {
  return preflightError(
    `The errand never got tab "${tab}", so nothing ran in it` +
      (detail !== null && detail !== '' ? `: ${detail}` : '.') +
      '\n' +
      'The tab may have been closed between the listing and the attach, or the ' +
      'browser may have gone. Call list_cdp_browsers to see what is open now, ' +
      'then name a tab from that.',
  );
}

// ---------------------------------------------------------------------------
// The turn lock (stories/errands.md §The wheel)
//
// Three refusals for one rule: a tab has one steering wheel. All three are
// reached from a 409's `holder` shape rather than from its prose, because the
// generic HTTP arm would answer a lock collision with "the tab may have been
// closed" — advice that sends a model to re-list when the thing to do is wait.
//
// None of them offers a way to end the holder: there is no `close_errand`, and
// an errand is one request. "Wait and retry" is the whole remedy, and it is a
// real one — the wait is a single request long.
// ---------------------------------------------------------------------------

/** A second `run_errand` on a tab an errand already drives. */
export function errandTabHeldByErrand(
  errandId: string,
  tabRole: 'borrowed' | 'opened',
  tab: string,
): McpToolError {
  const opened = tabRole === 'opened';
  return preflightError(
    `Tab "${tab}" is already being driven by errand ${errandId}` +
      (opened ? ', which opened it during its own run' : '') +
      ', and two errands cannot drive one tab — they would fight over clicks, ' +
      'dialogs and page-level settings.\n' +
      'Nothing ran. Wait for that errand to finish and call run_errand again: an ' +
      'errand is ONE request and releases every tab it holds when it returns, so ' +
      'there is nothing to close and nothing to cancel.' +
      (opened
        ? '\nExpect that tab to be gone by then — an errand closes the tabs it ' +
          'opened. Call list_cdp_browsers before retrying and name a tab from ' +
          'what is actually open.'
        : ''),
  );
}

/**
 * A `run_errand` on a tab a session has a batch in flight on.
 *
 * The only refusal of the three whose remedy has two branches, because the
 * holder outlives its batch: waiting works, and so does ending the session —
 * and which is right depends on whether the session is still wanted, which the
 * caller knows and this layer does not.
 */
export function errandTabHeldBySession(sessionId: string, tab: string): McpToolError {
  return preflightError(
    `Session "${sessionId}" is running steps in tab "${tab}" right now, so an ` +
      'errand cannot borrow it — that would be two drivers on one tab.\n' +
      'Nothing ran. Wait for that batch to finish and call run_errand again; an ' +
      'IDLE session on the tab would not have blocked this, only a running one ' +
      'does. If the session is no longer wanted, close_session with session_id ' +
      `"${sessionId}" first.`,
  );
}

/**
 * `close_cdp_tab` aimed at a tab an errand is driving or opened.
 *
 * The cdp-tabs §5 row this story adds. Distinct from the session refusal beside
 * it because the remedy is different in both halves: no holder to close, and —
 * for a tab the errand opened — a retry that will usually find nothing left to
 * close at all.
 */
export function cdpTabHeldByErrand(
  errandId: string,
  tabRole: 'borrowed' | 'opened',
  targetId: string,
): McpToolError {
  const opened = tabRole === 'opened';
  return preflightError(
    `Errand ${errandId} is driving tab ${targetId}` +
      (opened ? ', which it opened during its own run' : ', a tab it borrowed') +
      '. Closing it would break the errand mid-run, so nothing was closed.\n' +
      'Wait for the errand to finish, then retry — an errand is one request and ' +
      'lets go of every tab it holds when it returns. There is no close_errand ' +
      'and none is needed.' +
      (opened
        ? '\nBy then the tab will normally be gone anyway, because an errand closes ' +
          'what it opened — so the close becomes moot. Call list_cdp_browsers ' +
          'before retrying.'
        : ''),
  );
}

export function listSessionsTimedOut(timeoutMs: number): McpToolError {
  return preflightError(
    `Listing sessions took longer than ${timeoutMs}ms. The server reads each ` +
      "session's page title, so one busy or hung page can block the whole list.",
  );
}
