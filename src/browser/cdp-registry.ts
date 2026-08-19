/**
 * The registry of CDP browsers this project owns.
 *
 * stories/mcp-cdp-browser.md §1 (profile layout), §2 (ownership), §3
 * (launch-or-reuse) and §12 (reset). Pure-ish functions over a filesystem and
 * a port probe, so nearly all of it is unit-testable without a browser.
 *
 * **Ownership is proved from disk, never from process memory.** The API server
 * has an idle timeout, an MCP host restarts whenever the editor does, and the
 * browser outlives both — so a registry held in a variable loses a signed-in
 * browser on any restart. Instead: we own the profile directory, Chromium
 * writes `DevToolsActivePort` into it, and any process can read that back with
 * no bookkeeping at all.
 *
 * The claim is a *claim*, not proof — anything that can write into
 * `.aiui/cdp-profiles/` can forge one. That is the same trust boundary as
 * `.env` and `aiui.config.json`, both already read without further proof, so
 * it adds no new exposure. It is stated here so it is a decision rather than
 * an oversight.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  launchCdpBrowser,
  readDevToolsPort,
  DEVTOOLS_PORT_FILE,
  engineLabel,
  type LauncherDeps,
  type LaunchableEngine,
} from './cdp-launcher.js';
import {
  probePort,
  activateTab,
  closeTab,
  listPageTabs,
  portAnswers,
  type CdpDiscoveryTab,
  type CdpEngine,
} from './cdp-discovery.js';

export type { LaunchableEngine };

/** Directory under the project root holding every framework-owned profile. */
export const CDP_PROFILES_DIR = path.join('.aiui', 'cdp-profiles');

/** Marker written into every profile we create.
 *
 *  This is §12's guard that does not depend on path logic being right: a
 *  directory without it is not one we made, and `reset` will not delete it
 *  whatever the confinement check concluded. */
export const PROFILE_MARKER = '.aiui-profile';

/** Prefix for the staging directory `reset` renames a profile to before
 *  removing it. Inside `cdp-profiles` so the rename stays on one filesystem
 *  and therefore stays atomic. */
export const TRASH_PREFIX = '.trash-';

/** The engines this framework launches. Order is the enumeration order. */
export const LAUNCHABLE_ENGINES: readonly LaunchableEngine[] = ['chrome', 'edge'];

/**
 * A profile name is a path component, so it is validated like one — the same
 * rule and the same reason as `env_name` in stories/mcp-server.md §4a rule 6.
 * Without it, `profile: '../../..'` puts a browser profile, and later a
 * recursive delete, somewhere else entirely.
 */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export const DEFAULT_PROFILE = 'default';

export type CdpOutcome =
  | 'reused_running_browser'
  | 'launched_into_existing_profile'
  | 'launched_into_new_profile'
  | 'launched_after_reset';

/** One profile on disk, plus whether a browser is currently live on it. */
export interface KnownProfile {
  engine: LaunchableEngine;
  profile: string;
  profileDir: string;
  live: boolean;
  /** Only set when `live`. A port from a stale file is not a port. */
  port: number | null;
  tabs: CdpDiscoveryTab[] | null;
}

/**
 * Which root a profile lives under (stories/mcp-no-project.md).
 *
 * `project` — the project root a request named. `user` — the machine-wide
 * user root, swept on every request alongside it. The literal union is
 * duplicated from `src/mcp/types.ts` rather than imported: this module also
 * serves the CLI and the Sessions API server, and must not depend on the MCP
 * package.
 */
export type ProfileScope = 'project' | 'user';

/** A root to sweep, tagged with what it is. The registry never computes the
 *  user root itself — callers (the API server's routes) resolve it and pass
 *  it in, so this module stays a pure function of the paths it is handed. */
export interface ScopedRoot {
  root: string;
  scope: ProfileScope;
}

/** A profile found by a multi-root sweep, tagged with the root that owns it. */
export type ScopedProfile = KnownProfile & { scope: ProfileScope };

export interface StartOptions {
  projectRoot: string;
  engine: LaunchableEngine;
  profile?: string;
  reset?: boolean;
}

/**
 * Why a start or reset was refused. Exists so the HTTP layer can pick a status
 * code without string-matching the message — the messages are prose aimed at
 * an agent (§7) and will be reworded; the classification will not.
 *
 *   - `invalid_input` — the request itself is wrong (400). Nothing was touched.
 *   - `not_found`     — the thing named does not exist here (404): a port that
 *                       is not one of ours, a target id this browser does not
 *                       have.
 *   - `refused`       — the request is well-formed but the state says no: a
 *                       live browser on the profile, a directory we did not
 *                       create, a tab a session is driving (409).
 *   - `launch_failed` — we tried and the machine or the browser let us down
 *                       (500). The engine is missing, the port file never
 *                       appeared, the profile dir is not writable, a close was
 *                       accepted but never took effect. Named for the first
 *                       caller; it covers any attempted operation.
 */
export type CdpFailureKind = 'invalid_input' | 'not_found' | 'refused' | 'launch_failed';

/**
 * Which specific refusal this is — the stable name for a caller to branch on.
 *
 * {@link CdpFailureKind} answers "what HTTP status", and is deliberately coarse:
 * every ownership problem and every missing tab share `not_found`. That is the
 * right granularity for a status line and the wrong one for a caller that needs
 * to tell "the port is not yours" from "that tab is gone" — so `reason` carries
 * the distinction that `kind` flattens away.
 *
 * This is the field to branch on, and the reason the prose above it is free to
 * change. A message is written for whoever reads the failure and gets reworded
 * whenever a clearer sentence turns up; a reason is a contract and only ever
 * gains members. Anything matching on the message text is relying on wording
 * nobody promised to keep — the live ownership test did exactly that, and broke
 * the day a second search scope changed which sentence came back.
 *
 * Required, not optional, so a new failure site cannot quietly ship without one:
 * omitting it is a type error, the same discipline `statusForCdpFailure` uses to
 * stay total over `kind`.
 */
export type CdpFailureReason =
  // Ports and ownership.
  | 'port_not_listening'
  | 'port_not_owned'
  // Tabs.
  | 'tab_not_found'
  | 'tab_vanished'
  | 'tab_list_unreadable'
  | 'tab_held_by_errand'
  | 'tab_held_by_session'
  | 'tab_holder_unknown'
  | 'tab_is_last_open'
  | 'tab_close_refused'
  | 'tab_close_ineffective'
  | 'tab_focus_refused'
  // Raised by the API server's peek route rather than this module, but named
  // here so the whole vocabulary stays in one place for anyone branching on it.
  | 'tab_screenshot_timeout'
  | 'tab_screenshot_failed'
  // Profiles.
  | 'profile_name_invalid'
  | 'profile_dir_is_symlink'
  | 'profile_dir_unresolvable'
  | 'profile_dir_outside_root'
  | 'profile_dir_unmarked'
  | 'profile_in_use'
  | 'profile_reset_failed';

export type StartResult =
  | {
      ok: true;
      engine: LaunchableEngine;
      profile: string;
      profileDir: string;
      port: number;
      binary: string;
      tabs: CdpDiscoveryTab[];
      outcome: CdpOutcome;
      warnings: string[];
    }
  | { ok: false; kind: CdpFailureKind; reason: CdpFailureReason; error: string };

export interface RegistryDeps extends LauncherDeps {
  /** Default: fs.readdirSync with withFileTypes. */
  readdir?: (dir: string) => { name: string; isDirectory: () => boolean }[];
  /** Default: fs.realpathSync. Throws for a missing path, as the real one does. */
  realpath?: (p: string) => string;
  /** Default: fs.lstatSync-based symlink test. */
  isSymlink?: (p: string) => boolean;
  /** Default: fs.renameSync. */
  rename?: (from: string, to: string) => void;
  /** Default: fs.rmSync recursive+force. */
  rm?: (p: string) => void;
  /** Default: fs.writeFileSync. */
  writeFile?: (p: string, data: string) => void;
  /** Default: fs.unlinkSync, swallowing ENOENT. */
  unlink?: (p: string) => void;
  /** Default: the real launcher. Stubbed in tests to assert it is NOT called
   *  on the reuse branch. */
  launch?: typeof launchCdpBrowser;
  /** Default: the real probe. */
  probe?: typeof probePort;
}

// ---------------------------------------------------------------------------
// Paths and names
// ---------------------------------------------------------------------------

export function cdpProfilesRoot(projectRoot: string): string {
  return path.join(projectRoot, CDP_PROFILES_DIR);
}

/**
 * `<project_root>/.aiui/cdp-profiles/<engine>-<name>/`, always in that shape —
 * including for the default profile, which is `<engine>-default` rather than a
 * bare `<engine>`. One rule instead of two keeps enumeration to a single
 * pattern: split the directory name on its first hyphen, and the left side is
 * the engine (no engine name contains one, so a profile called `signup-test`
 * still round-trips).
 */
export function profileDirFor(
  projectRoot: string,
  engine: LaunchableEngine,
  profile: string,
): string {
  return path.join(cdpProfilesRoot(projectRoot), `${engine}-${profile}`);
}

/** Returns an error message, or null when the name is usable. */
export function validateProfileName(profile: string): string | null {
  // `.` and `..` pass the charset — both characters are in it — and are
  // harmless *today* only because every directory is prefixed `<engine>-`, so
  // `..` becomes the literal directory `chrome-..` rather than a traversal.
  // Refused anyway: this name feeds a recursive delete, and a guard that holds
  // only while an unrelated naming decision holds is not a guard. Costs a line.
  if (profile === '.' || profile === '..') {
    return (
      `Profile name "${profile}" is not usable — it is a directory reference, not a name.\n` +
      'Use a plain name: admin, uat, signup-test.'
    );
  }
  if (!PROFILE_NAME_PATTERN.test(profile)) {
    return (
      `Profile name "${profile}" is not usable. It names a directory under ` +
      '.aiui/cdp-profiles/, so it may contain only letters, digits, dot, ' +
      'underscore and hyphen — no slashes, no "..".\n' +
      'Use a plain name: admin, uat, signup-test.'
    );
  }
  return null;
}

/** Split `chrome-signup-test` into `{engine:'chrome', profile:'signup-test'}`.
 *  Returns null for anything that is not one of our directories. */
export function parseProfileDirName(
  dirName: string,
): { engine: LaunchableEngine; profile: string } | null {
  const hyphen = dirName.indexOf('-');
  if (hyphen <= 0) return null;
  const engine = dirName.slice(0, hyphen);
  const profile = dirName.slice(hyphen + 1);
  if (!isLaunchableEngine(engine)) return null;
  if (!PROFILE_NAME_PATTERN.test(profile)) return null;
  return { engine, profile };
}

export function isLaunchableEngine(value: string): value is LaunchableEngine {
  return value === 'chrome' || value === 'edge';
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * Every profile directory this project has, and whether a browser is live on
 * each.
 *
 * `live` requires two things, and the second is not redundant: the port from
 * `DevToolsActivePort` must answer, **and** the engine it reports must match
 * the profile's own. W0 confirmed Chromium never deletes that file — not on an
 * orderly exit, not on a crash — so a dormant profile always has a stale one
 * pointing at a port that some *other* process may since have taken. Without
 * the engine check a Chrome profile could be reported live because an
 * unrelated Edge landed on its old port.
 *
 * **Dormant profiles are returned, not dropped.** "This profile exists and
 * nothing is running" is useful: an agent told *"reuse an existing profile if
 * there is one"* can then start `admin` rather than inventing `admin2`, which
 * is the main brake on profile sprawl. The caller splits `live` into §4's
 * `running` / `available` lists.
 */
export async function knownProfiles(
  projectRoot: string,
  deps?: RegistryDeps,
): Promise<KnownProfile[]> {
  const readdir = deps?.readdir ?? defaultReaddir;
  const probe = deps?.probe ?? probePort;
  const root = cdpProfilesRoot(projectRoot);

  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = readdir(root);
  } catch {
    // No profiles directory yet is the normal state of a fresh project, not an
    // error worth surfacing.
    return [];
  }

  const candidates = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ dirName: e.name, parsed: parseProfileDirName(e.name) }))
    .filter((c): c is { dirName: string; parsed: { engine: LaunchableEngine; profile: string } } =>
      c.parsed !== null,
    );

  return Promise.all(
    candidates.map(async ({ dirName, parsed }) => {
      const profileDir = path.join(root, dirName);
      const port = readDevToolsPort(profileDir, deps);
      if (port === null) {
        return { ...parsed, profileDir, live: false, port: null, tabs: null };
      }
      const probed = await probe(port);
      const live = probed.reachable && probed.engine === parsed.engine;
      return {
        ...parsed,
        profileDir,
        live,
        port: live ? port : null,
        tabs: live ? (probed.tabs ?? []) : null,
      };
    }),
  );
}

/**
 * `knownProfiles` over several roots at once, each result tagged with the
 * root's scope (stories/mcp-no-project.md: "both roots are always swept").
 *
 * A plain concatenation, deliberately: the same `(engine, profile)` name in
 * two roots is two different browsers with two different profile directories,
 * and both belong in the answer. Ambiguity is the *caller's* to refuse at
 * name-resolution time — deduplicating here would be resolving it by
 * precedence, which is the locked decision this story reverses.
 *
 * Callers pass distinct roots; a root listed twice would double every entry.
 */
export async function knownProfilesAcross(
  roots: readonly ScopedRoot[],
  deps?: RegistryDeps,
): Promise<ScopedProfile[]> {
  const perRoot = await Promise.all(
    roots.map(async ({ root, scope }) =>
      (await knownProfiles(root, deps)).map((profile) => ({ ...profile, scope })),
    ),
  );
  return perRoot.flat();
}

/** The one profile, or null when the directory does not exist. */
export async function findProfile(
  projectRoot: string,
  engine: LaunchableEngine,
  profile: string,
  deps?: RegistryDeps,
): Promise<KnownProfile | null> {
  const all = await knownProfiles(projectRoot, deps);
  return all.find((p) => p.engine === engine && p.profile === profile) ?? null;
}

// ---------------------------------------------------------------------------
// Launch or reuse
// ---------------------------------------------------------------------------

/**
 * §3. There is no port allocator: either a browser is already live on this
 * profile and we return it, or we spawn one at `--remote-debugging-port=0` and
 * read back the port Chromium chose.
 */
export async function startCdpBrowser(
  opts: StartOptions,
  deps?: RegistryDeps,
): Promise<StartResult> {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const nameError = validateProfileName(profile);
  if (nameError) return { ok: false, kind: 'invalid_input', reason: 'profile_name_invalid', error: nameError };

  const existsSync = deps?.existsSync ?? fs.existsSync;
  const launch = deps?.launch ?? launchCdpBrowser;
  const probe = deps?.probe ?? probePort;
  const profileDir = profileDirFor(opts.projectRoot, opts.engine, profile);
  const warnings: string[] = [];

  let outcome: CdpOutcome;

  if (opts.reset) {
    const reset = await resetProfile(opts.projectRoot, opts.engine, profile, deps);
    if (!reset.ok) return { ok: false, kind: reset.kind, reason: reset.reason, error: reset.error };
    warnings.push(...reset.warnings);
    outcome = 'launched_after_reset';
  } else {
    const existing = await findProfile(opts.projectRoot, opts.engine, profile, deps);

    // --- reuse branch: return the live browser, spawn nothing ---------------
    if (existing?.live && existing.port !== null) {
      return {
        ok: true,
        engine: opts.engine,
        profile,
        profileDir: existing.profileDir,
        port: existing.port,
        // Nothing was spawned, so there is no binary path to report. The field
        // exists for the launch arms; saying "the browser we did not start"
        // would be a fiction.
        binary: '',
        tabs: existing.tabs ?? [],
        outcome: 'reused_running_browser',
        warnings,
      };
    }

    // Read this BEFORE anything creates the directory — it is the entire
    // difference between `launched_into_new_profile` (empty, a human must
    // sign in) and `launched_into_existing_profile` (may already be signed in,
    // possibly as someone else). Getting it wrong is a silent lie about
    // sign-in state, which is why it is not inferred from anything later.
    outcome = existsSync(profileDir)
      ? 'launched_into_existing_profile'
      : 'launched_into_new_profile';

    // --- the stale delete, and it is branch-scoped -------------------------
    // Only reachable once the check above established nothing is alive on this
    // profile. Deleting the file while a browser IS live would destroy the
    // registry entry for a running browser — we would lose a signed-in browser
    // we still own, with no way to find it again since its port is
    // OS-assigned and unguessable.
    //
    // Skipping the delete is just as bad in the other direction: W0 measured
    // the stale file still serving the PREVIOUS port for ~300 ms after a
    // relaunch, and every relaunch takes a different port, so a reader in that
    // window gets a number that is always wrong. The W0 harness itself fell
    // into this and reported a healthy browser as unreachable.
    deleteStalePortFile(profileDir, deps);
  }

  const launched = await launch({ engine: opts.engine, profileDir }, deps);
  if (!launched.ok) return { ok: false, kind: 'launch_failed', reason: 'tab_list_unreadable', error: launched.error };

  writeProfileMarker(profileDir, opts.engine, profile, deps);

  const probed = await probe(launched.port);
  if (!probed.reachable) {
    warnings.push(
      `Could not list tabs on port ${launched.port}: ${probed.error ?? 'unreachable'}`,
    );
  } else if (probed.tabs === null) {
    warnings.push(`Could not list tabs on port ${launched.port}: ${probed.error ?? 'no tab list'}`);
  }

  return {
    ok: true,
    engine: opts.engine,
    profile,
    profileDir,
    port: launched.port,
    binary: launched.binary,
    tabs: probed.tabs ?? [],
    outcome,
    warnings,
  };
}

function deleteStalePortFile(profileDir: string, deps?: RegistryDeps): void {
  const unlink = deps?.unlink ?? defaultUnlink;
  unlink(path.join(profileDir, DEVTOOLS_PORT_FILE));
}

function writeProfileMarker(
  profileDir: string,
  engine: LaunchableEngine,
  profile: string,
  deps?: RegistryDeps,
): void {
  const writeFile = deps?.writeFile ?? ((p: string, d: string) => fs.writeFileSync(p, d, 'utf8'));
  try {
    writeFile(
      path.join(profileDir, PROFILE_MARKER),
      `${JSON.stringify({ engine, profile, createdBy: 'ai-ui-automation' }, null, 2)}\n`,
    );
  } catch {
    // A profile without a marker still works; it just cannot be `reset`
    // (§12 guard 4 refuses it), which fails loudly and safely later rather
    // than failing the launch the caller actually asked for now.
  }
}

// ---------------------------------------------------------------------------
// Close a tab (stories/cdp-tabs.md §2)
// ---------------------------------------------------------------------------

/**
 * How long to wait for a closed tab to leave `/json/list`.
 *
 * W0 measured 7 ms (Chrome) / 41 ms (Edge) on an idle browser — but that is the
 * quiet case. **Live testing blew a 2 s budget**: a tab whose session had just
 * been torn down took longer than that to go, and the caller got "state
 * unknown" for a close that was working fine. A false alarm here is worse than
 * a slow answer, because it tells an agent to re-list and retry a close that
 * already succeeded. 5 s is still bounded, and a tab held open by a
 * `beforeunload` dialog never leaves the list at all — so exhausting this
 * budget still means what it says.
 */
export const CLOSE_CONFIRM_BUDGET_MS = 5_000;

/**
 * How long to wait for a browser with no tabs left to actually exit.
 *
 * Separate from the tab budget and much shorter, because it is spent on the
 * rare platform where a process outlives its windows (W0 saw a clean exit on
 * both engines within 95–286 ms). Waiting the full close budget to confirm
 * something that normally takes a quarter of a second would make every
 * last-tab close feel broken.
 */
const EXIT_CONFIRM_BUDGET_MS = 1_500;
const CLOSE_POLL_INTERVAL_MS = 25;

export interface CloseTabOptions {
  /** Roots the browser may trace back to — the project root (when the caller
   *  has one) plus the user root, resolved by the route and passed in. The
   *  registry never computes the user root itself. */
  roots: readonly ScopedRoot[];
  port: number;
  targetId: string;
  /**
   * Permission to close a browser's **last** tab, which ends the browser.
   *
   * Not a formality. Chromium ties the process's life to its last window, so
   * there is no zero-tab browser to leave behind — "close the last tab" and
   * "stop the browser" are the same act, and the flag is where the caller says
   * they meant the second one. Same shape as `reset` on a launch: destructive
   * intent is stated in the call, never inferred.
   */
  allowBrowserExit?: boolean;
  /**
   * Permission to act on a browser NEITHER root launched.
   *
   * Ownership is proved from the sweep of `roots`, which by construction only
   * ever contains their own profiles — so without this flag a foreign browser
   * can never be closed, however the caller is permitted. That made
   * `mcp.cdp.allowUnowned` advertise something it could not deliver: the MCP
   * gate let the call through and the registry refused it one layer later,
   * with an unrelated message. The decision stays where it was (MCP-side,
   * human-held); this is the flag it needs to actually mean anything.
   */
  allowUnowned?: boolean;
  /**
   * Which live session, if any, is driving a given tab of this browser.
   *
   * Injected because the answer lives in the server's session map, which this
   * module knows nothing about — and must not, since it is also the module the
   * CLI and any future client sit on.
   *
   * Returns `UNKNOWN_HOLDER` when the answer could not be determined — a
   * session's tabs took too long to enumerate. That is **not** the same as
   * `null`, and the difference is the whole point: this is a guard, so
   * "I could not find out" must refuse, not proceed. A symbol rather than a
   * sentinel string so it cannot collide with a real session id.
   */
  sessionHolding?: (
    targetId: string,
  ) => Promise<string | null | typeof UNKNOWN_HOLDER> | string | null | typeof UNKNOWN_HOLDER;
  /**
   * Which errand, if any, is driving a given tab of this browser
   * (stories/errands.md §The wheel — a named amendment to
   * stories/cdp-tabs.md §1, §2 and §5).
   *
   * Injected for the same reason as `sessionHolding`, and with one difference
   * that matters: an errand's holds live in the server process's own memory, so
   * the answer is exact and there is no `UNKNOWN_HOLDER` arm to fail closed on.
   *
   * `tabRole` decides what the refusal may promise. A borrowed tab is still
   * there when the errand finishes, so "wait and retry" works; a tab the errand
   * itself opened is normally gone by then, and the message says so rather than
   * sending the caller into a `not_found`.
   */
  errandHolding?: (targetId: string) => ErrandTabHold | null;
}

/** See `CloseTabOptions.errandHolding`. Structurally the `ErrandHold` of
 *  `src/server/errand-locks.ts`, declared here so this module — which the CLI
 *  and any future client also sit on — keeps its zero imports from the server
 *  layer. The wiring site type-checks the two against each other. */
export interface ErrandTabHold {
  errandId: string;
  tabRole: 'borrowed' | 'opened';
}

/** See `CloseTabOptions.sessionHolding`. */
export const UNKNOWN_HOLDER = Symbol('cdp-tab-holder-unknown');

export type CloseTabResult =
  | {
      ok: true;
      targetId: string;
      title: string;
      url: string;
      /** Widened past `LaunchableEngine`: a permitted foreign browser (§8) can
       *  be a Chromium or an unrecognised build. */
      engine: CdpEngine;
      profile: string;
      port: number;
      /** Page tabs left, counted from the browser after the close — not
       *  arithmetic on the before-count. 0 when the browser exited. */
      remainingTabs: number;
      /** Observed, never assumed: the port stopped answering. */
      browserExited: boolean;
      /** Whether a swept root launched the browser. False only via
       *  `allowUnowned`, and it changes what is true about the aftermath —
       *  nothing here can reopen a browser we do not own. */
      owned: boolean;
      /** Which root owned it, or null for a permitted foreign browser. */
      scope: ProfileScope | null;
      warnings: string[];
    }
  | {
      ok: false;
      kind: CdpFailureKind;
      reason: CdpFailureReason;
      error: string;
      /** Machine-readable holder for the errand refusal, so the route can put
       *  it on the 409 body and the MCP side can recognise the shape instead of
       *  matching prose. Absent on every other failure. */
      holder?: { kind: 'errand'; errandId: string; tabRole: 'borrowed' | 'opened' };
    };

export interface CloseTabDeps extends RegistryDeps {
  close?: typeof closeTab;
  listTabs?: typeof listPageTabs;
  alive?: typeof portAnswers;
  /** Injected so tests do not spend the confirm budget in real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Who a port belongs to, once ownership has been settled. */
interface CdpOwner {
  /** Widened past `LaunchableEngine`: a permitted foreign browser (§8) can be a
   *  Chromium or an unrecognised build. */
  engine: CdpEngine;
  /** Empty for a foreign browser — no profile directory of ours stands behind
   *  it, and a stand-in phrase here would read as a profile name where this
   *  gets interpolated into messages. */
  profile: string;
  /** `engineLabel(engine) "profile"` for one of ours, and a port phrase for a
   *  foreign one. A separate field because the launchable engine names cannot
   *  express a Chromium or an unrecognised build. */
  label: string;
  owned: boolean;
  /** Which root stands behind the browser, or null for a foreign one. */
  scope: ProfileScope | null;
}

/** How a message names one browser of a sweep, scope tag included. */
function describeRunning(p: ScopedProfile): string {
  return (
    `${engineLabel(p.engine)} "${p.profile}"` +
    `${p.scope === 'user' ? ' (user root)' : ''} on port ${p.port}`
  );
}

/**
 * Settle which browser a port is, and whether this caller may act on it.
 *
 * Shared by every verb that reaches into a live browser — closing a tab and
 * focusing one — because they must agree exactly on what "ours" means and on
 * what `allowUnowned` opens up. Two copies would eventually let one verb act on
 * a browser the other refused, with no reading of the rules that explains it.
 *
 * "Ours" now spans BOTH roots (stories/mcp-no-project.md): the sweep is the
 * project root plus the user root, and a browser tracing back to either is
 * owned — carrying `scope` to say which. `foreign` keeps its true meaning: a
 * browser tracing back to *neither*. Our ports are OS-assigned, so nothing
 * about the number itself is recognisable; the sweep is the only answer.
 */
async function resolveCdpOwner(
  roots: readonly ScopedRoot[],
  port: number,
  allowUnowned: boolean,
  deps?: RegistryDeps,
): Promise<{ ok: true; owner: CdpOwner } | { ok: false; kind: CdpFailureKind; reason: CdpFailureReason; error: string }> {
  const profiles = await knownProfilesAcross(roots, deps);
  const known = profiles.find((p) => p.live && p.port === port);

  if (known) {
    return {
      ok: true,
      owner: {
        engine: known.engine,
        profile: known.profile,
        label:
          known.scope === 'user'
            ? `the user-root ${engineLabel(known.engine)} "${known.profile}"`
            : `${engineLabel(known.engine)} "${known.profile}"`,
        owned: true,
        scope: known.scope,
      },
    };
  }

  if (allowUnowned) {
    // Permitted by a human, so the only question left is whether anything is
    // actually there.
    const probe = deps?.probe ?? probePort;
    const probed = await probe(port);
    if (!probed.reachable) {
      return {
        ok: false,
        kind: 'not_found',
        reason: 'port_not_listening',
        error:
          `Nothing is listening on port ${port}.\n` +
          'Call list_cdp_browsers to see what is running.',
      };
    }
    return {
      ok: true,
      owner: {
        engine: probed.engine,
        profile: '',
        label: `the browser on port ${port}`,
        owned: false,
        scope: null,
      },
    };
  }

  const running = profiles.filter((p) => p.live);
  // Name what was actually swept: a project-less call has no project root,
  // and telling it about one would send the reader looking for a project that
  // was never in play.
  const scopes = new Set(roots.map((r) => r.scope));
  const whose =
    scopes.size > 1
      ? 'it traces back to neither the project root nor the user root'
      : scopes.has('user')
        ? 'it does not trace back to the user root'
        : 'it is not one this project has running';
  return {
    ok: false,
    kind: 'not_found',
    reason: 'port_not_owned',
    error:
      `Port ${port} is not a CDP browser this call can act on — ${whose}.\n` +
      (running.length > 0
        ? `Running now: ${running.map(describeRunning).join(', ')}.`
        : 'No CDP browser is running in the swept root(s).'),
  };
}

/**
 * Close one tab in a browser this project owns.
 *
 * Every guard below closes a different hole, and nothing irreversible happens
 * until the request has cleared all of them. Two orderings are load-bearing:
 * both holder checks run before the last-tab gate (see guard 4 for why the
 * cheaper order was wrong), and the errand check runs before the session one
 * (see guard 3).
 *
 * **Callers must serialise concurrent closes against one browser** (the route
 * does, via its per-port queue). Guard 5 reads a tab list to decide whether
 * this is the last tab, and two overlapping closes would both read the same
 * pre-close list and both conclude they are not.
 */
export async function closeCdpTab(
  opts: CloseTabOptions,
  deps?: CloseTabDeps,
): Promise<CloseTabResult> {
  const close = deps?.close ?? closeTab;
  const listTabs = deps?.listTabs ?? listPageTabs;
  const alive = deps?.alive ?? portAnswers;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps?.now ?? Date.now;

  // 1. The port must be one of ours — from either swept root — and live.
  //    Shared with the focus path, so the two verbs can never disagree about
  //    which browsers a caller may act on, including which one `allowUnowned`
  //    opens up.
  const resolved = await resolveCdpOwner(opts.roots, opts.port, opts.allowUnowned === true, deps);
  if (!resolved.ok) return resolved;
  const owner = resolved.owner;

  // 2. Read the tab list through the SHARED filter, so what may be closed and
  //    what was listed can never disagree.
  const before = await listTabs(opts.port);
  if (before === null) {
    return {
      ok: false,
      kind: 'launch_failed',
      reason: 'tab_list_unreadable',
      error:
        `Could not read the tab list from ${owner.label} ` +
        `on port ${opts.port}. The browser may be shutting down.\n` +
        'Call list_cdp_browsers to see what is still running.',
    };
  }

  const target = before.find((t) => t.targetId === opts.targetId);
  if (!target) {
    // Two readings, and the caller cannot tell them apart from here — so say
    // both rather than picking one. Treating this as an idempotent success
    // would swallow the second entirely.
    return {
      ok: false,
      kind: 'not_found',
      reason: 'tab_not_found',
      error:
        `No tab with target id ${opts.targetId} is open in ${owner.label} ` +
        `(port ${opts.port}).\n\n` +
        'Either it has already been closed, or the id belongs to a different browser.\n' +
        'Call list_cdp_browsers for the tabs open right now.',
    };
  }

  // 3. A tab an ERRAND is driving, or one it opened along the way
  //    (stories/errands.md §The wheel).
  //
  //    **First of the two holder checks, deliberately.** This one is
  //    synchronous, exact and answered from this process's own memory, while
  //    the session join is an await over every live session and can only say
  //    "somebody is on this tab", not whether they are doing anything with it.
  //    Both holders on one tab is the ordinary case — an errand borrows a tab
  //    an idle session is sitting on, which the errand lock permits — and with
  //    the session check first that close was refused with "close_session, then
  //    retry": destructive advice about the wrong holder, and advice that does
  //    not work, because the errand still holds the tab afterwards.
  const errand = opts.errandHolding?.(opts.targetId);
  if (errand) {
    const opened = errand.tabRole === 'opened';
    return {
      ok: false,
      kind: 'refused',
      reason: 'tab_held_by_errand',
      holder: { kind: 'errand', errandId: errand.errandId, tabRole: errand.tabRole },
      error:
        `Errand ${errand.errandId} is driving that tab ("${target.title || target.url}")` +
        (opened ? ', which it opened during its own run' : '') +
        '. Closing it would break the errand mid-run.\n\n' +
        'Wait for the errand to finish, then retry — an errand is one request and ' +
        'lets go of every tab it holds when it returns. There is no way to end one ' +
        'early.' +
        (opened
          ? '\nBy then that tab will normally be gone anyway: an errand closes what it ' +
            'opened, so the close becomes moot.'
          : ''),
    };
  }

  // 4. A tab a live session is driving. Yanking it turns that session's next
  //    step into a baffling page-closed failure, so the session gets closed
  //    deliberately first — via the door that exists for it.
  //
  //    **Before the last-tab check, deliberately.** The cheaper ordering was
  //    the other way round, but a one-tab browser being driven by a session is
  //    entirely reachable (`cdp.tab: 'targetId:<id>'` binds an existing tab and
  //    opens nothing), and then the last-tab refusal fires first and tells the
  //    caller to pass `allow_browser_exit: true` — advice that leads straight
  //    into a *different* refusal. A remedy that does not work is worse than a
  //    slightly more expensive check.
  const holder = await opts.sessionHolding?.(opts.targetId);
  if (holder === UNKNOWN_HOLDER) {
    // Fails closed. The alternative — treating "could not determine" as
    // "nobody" — is how a slow lookup turns into a tab closed out from under a
    // running session, which is exactly the outcome this guard exists to
    // prevent and is not worth trading for one retry.
    return {
      ok: false,
      kind: 'refused',
      reason: 'tab_holder_unknown',
      error:
        `Could not determine whether a session is driving "${target.title || target.url}" — ` +
        'one of this server\'s sessions took too long to report its tabs.\n\n' +
        'Nothing was closed. Retry in a moment — a session mid-step is the usual cause ' +
        'and it clears on its own. If it persists, call list_sessions to see which ' +
        'session is running and close_session to end it, then retry.',
    };
  }
  if (holder) {
    return {
      ok: false,
      kind: 'refused',
      reason: 'tab_held_by_session',
      error:
        `Session "${holder}" is driving that tab ("${target.title || target.url}"). ` +
        'Closing it would break that session mid-run.\n\n' +
        `Close the session first — close_session with session_id "${holder}" — then ` +
        'retry, or leave the tab alone if the session is still wanted.',
    };
  }

  // 5. The last tab. Closing it closes the browser — there is no zero-tab
  //    Chromium — so it needs saying out loud rather than discovering.
  const isLast = before.length === 1;
  if (isLast && opts.allowBrowserExit !== true) {
    return {
      ok: false,
      kind: 'refused',
      reason: 'tab_is_last_open',
      error:
        `"${target.title || target.url}" is the only tab open in ` +
        `${owner.label}, and closing a browser's last ` +
        'tab closes the browser itself.\n\n' +
        // The reassurance is true ONLY of a browser we own: its profile lives
        // in a directory of ours and relaunches signed in. For a foreign
        // browser every clause of it is false, and it is the sentence that
        // decides whether the agent asks before terminating a human's
        // signed-in Chrome — so the two cases say different things.
        (owner.owned
          ? '**Nothing is lost by doing it** — the profile keeps its signed-in state on ' +
            `disk, and start_cdp_browser with profile "${owner.profile}" brings it back still ` +
            'signed in.\n'
          : '**This browser is not one this project started**, so nothing here can reopen ' +
            'it or restore what it was signed into. Whoever is using it would have to ' +
            'start it again themselves.\n') +
        'Pass allow_browser_exit: true if closing the browser is what you want.',
    };
  }

  // 6. Close, then confirm. The browser acknowledges before the tab is gone
  //    (W0: 1-5 ms ack, 7-41 ms actual), so the ack alone is an intention.
  const requested = await close(opts.port, opts.targetId);
  if (requested.notFound) {
    // The tab was in the list we read a moment ago and is not there now, so
    // something else closed it in between. Reported rather than absorbed: the
    // caller would otherwise be told `closed: true` with a title and url for a
    // tab it did not close, and act on the belief that its close is what
    // removed it.
    return {
      ok: false,
      kind: 'not_found',
      reason: 'tab_vanished',
      error:
        `Tab ${opts.targetId} ("${target.title || target.url}") was open a moment ago but ` +
        'the browser no longer has it — something else closed it first.\n\n' +
        'Nothing was closed by this call. Call list_cdp_browsers for the tabs open now.',
    };
  }
  if (!requested.ok) {
    return {
      ok: false,
      kind: 'launch_failed',
      reason: 'tab_close_refused',
      error:
        `The browser refused to close that tab: ${requested.error ?? 'unknown error'}.\n` +
        'Call list_cdp_browsers to check the browser is still running, then retry.',
    };
  }

  const warnings: string[] = [];

  // A last-tab close inverts the success signal: the endpoint that would tell
  // us the tab is gone dies WITH the process, so "the port stopped answering"
  // is the confirmation. Read it that way rather than treating the unreachable
  // browser as a failed poll.
  if (isLast) {
    const exited = await pollUntil(
      () => notAlive(alive, opts.port),
      { sleep, now },
      EXIT_CONFIRM_BUDGET_MS,
    );
    if (!exited) {
      // Honest rather than convenient: some platforms keep a process without
      // windows (macOS app semantics, Edge startup-boost style background
      // modes). W0 saw a clean exit on both engines here, so this is the
      // surprising branch — say so instead of reporting an exit that did not
      // happen.
      const still = await listTabs(opts.port);
      warnings.push(
        `The tab was closed but ${owner.label} is still running. It may be configured ` +
          'to stay resident with no windows open.',
      );
      return {
        ok: true,
        targetId: opts.targetId,
        title: target.title,
        url: target.url,
        engine: owner.engine,
        profile: owner.profile,
        port: opts.port,
        remainingTabs: still?.length ?? 0,
        browserExited: false,
        owned: owner.owned,
        scope: owner.scope,
        warnings,
      };
    }
    return {
      ok: true,
      targetId: opts.targetId,
      title: target.title,
      url: target.url,
      engine: owner.engine,
      profile: owner.profile,
      port: opts.port,
      remainingTabs: 0,
      browserExited: true,
      owned: owner.owned,
      scope: owner.scope,
      warnings,
    };
  }

  const gone = await pollUntil(async () => {
    const tabs = await listTabs(opts.port);
    if (tabs === null) {
      // An unreadable list is not by itself an answer. A browser that exited
      // during the close settles the question — the earlier version required a
      // readable list, so it burned the whole budget and then reported the tab
      // as "still open", blaming a `beforeunload` dialog, about a browser that
      // no longer existed. But `listPageTabs` also returns null for a single
      // failed fetch, a non-200 or a 1.5 s abort, and this predicate runs ~200
      // times against a browser showing a "Leave site?" dialog — so treating
      // every null as an exit meant one flaky read reported `closed: true` for
      // a tab that is still open. Ask the port which of the two it is.
      return !(await alive(opts.port));
    }
    return !tabs.some((t) => t.targetId === opts.targetId);
  }, { sleep, now });

  if (!gone) {
    return {
      ok: false,
      kind: 'launch_failed',
      reason: 'tab_close_ineffective',
      error:
        `The browser accepted the close for tab ${opts.targetId} but it was still open ` +
        `${CLOSE_CONFIRM_BUDGET_MS}ms later, so its state is unknown — it may be showing ` +
        'a "leave site?" dialog, which blocks a close until someone answers it.\n' +
        'Call list_cdp_browsers before retrying.',
    };
  }

  const after = await listTabs(opts.port);

  // A browser with no tabs left is a browser on its way out, even though this
  // was not *its* last tab when we read the list — another client can close
  // one concurrently, and `before.length > 1` only ever described one instant.
  // Observed in live testing: a slow-closing tab finished during our close, the
  // browser dropped to zero tabs and exited, and this reported
  // `browserExited: false` to an agent that would have told the user their
  // browser was still open. So when nothing is left, ask the port directly
  // rather than inferring from the count we started with.
  if (after === null || after.length === 0) {
    const exited = await pollUntil(() => notAlive(alive, opts.port), { sleep, now }, EXIT_CONFIRM_BUDGET_MS);
    if (exited) {
      return {
        ok: true,
        targetId: opts.targetId,
        title: target.title,
        url: target.url,
        engine: owner.engine,
        profile: owner.profile,
        port: opts.port,
        remainingTabs: 0,
        browserExited: true,
        owned: owner.owned,
        scope: owner.scope,
        warnings,
      };
    }
    // Still answering with nothing open. Same resident-process case the
    // last-tab branch warns about, and it needs the same warning here — a
    // caller told `remainingTabs: 0, browserExited: false` with no explanation
    // is looking at a contradiction and has nothing to act on.
    warnings.push(
      after === null
        ? `The tab was closed, but the tab list could not be re-read on port ${opts.port}, ` +
          'so the remaining count may be stale.'
        : `The tab was closed and ${owner.label} now has no ` +
          `tabs open, but it is still running on port ${opts.port}. It may be configured to ` +
          'stay resident with no windows open.',
    );
  }

  return {
    ok: true,
    targetId: opts.targetId,
    title: target.title,
    url: target.url,
    engine: owner.engine,
    profile: owner.profile,
    port: opts.port,
    remainingTabs: after?.length ?? Math.max(0, before.length - 1),
    browserExited: false,
    owned: owner.owned,
    scope: owner.scope,
    warnings,
  };
}

async function notAlive(alive: typeof portAnswers, port: number): Promise<boolean> {
  return !(await alive(port));
}

/** Poll a predicate until true or the budget runs out. */
async function pollUntil(
  predicate: () => Promise<boolean>,
  io: { sleep: (ms: number) => Promise<void>; now: () => number },
  budgetMs: number = CLOSE_CONFIRM_BUDGET_MS,
): Promise<boolean> {
  const started = io.now();
  for (;;) {
    if (await predicate()) return true;
    if (io.now() - started >= budgetMs) return false;
    await io.sleep(CLOSE_POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Focus a tab (stories/cdp-tab-focus.md §2)
// ---------------------------------------------------------------------------

export interface FocusTabOptions {
  /** Same contract as `CloseTabOptions.roots`: the project root (when there
   *  is one) plus the user root, resolved by the route. */
  roots: readonly ScopedRoot[];
  port: number;
  targetId: string;
  /** Permission to act on a browser neither root launched. Same flag,
   *  same human-held opt-in behind it, and the same reasoning as closing:
   *  focusing a tab in someone else's browser yanks their screen and reveals
   *  which tab they are being shown. Non-destructive is not unobtrusive. */
  allowUnowned?: boolean;
}

export type FocusTabResult =
  | {
      ok: true;
      targetId: string;
      title: string;
      url: string;
      engine: CdpEngine;
      profile: string;
      port: number;
      owned: boolean;
      /** Which root owned it, or null for a permitted foreign browser. */
      scope: ProfileScope | null;
      warnings: string[];
    }
  | { ok: false; kind: CdpFailureKind; reason: CdpFailureReason; error: string };

export interface FocusTabDeps extends RegistryDeps {
  activate?: typeof activateTab;
  listTabs?: typeof listPageTabs;
}

/**
 * Bring one tab of a browser this project owns to the front.
 *
 * Deliberately shorter than `closeCdpTab`, and each thing it does *not* do is a
 * decision:
 *
 *   - **No session guard.** `closeCdpTab` refuses a tab a live session is
 *     driving; this must not. "Show me what the test is doing" is the single
 *     most likely reason to call it, and the tab a session holds is exactly the
 *     tab the user wants to see. Focusing changes no automation state —
 *     Playwright drives a page by target, not by which tab is frontmost.
 *   - **No last-tab guard.** Nothing here closes anything.
 *   - **No queue, and callers need not serialise.** The close route serialises
 *     per port because two concurrent closes can defeat the last-tab guard.
 *     There is no guard here to defeat: two concurrent focuses mean the second
 *     wins, which is what "focus" means.
 *   - **No confirm poll.** A closed tab has an observable absence to poll for;
 *     "is this window in front of every other application" has no read over the
 *     DevTools HTTP surface. So `ok` means the browser accepted it — see
 *     `activateTab`.
 *
 * The one guard it keeps beyond ownership is the **shared page-type filter**,
 * and that is load-bearing rather than tidy: the browser answers
 * `200 "Target activated"` for `iframe` and `browser_ui` ids as readily as for
 * real tabs, so without looking the id up in `toPageTabs`'s output first this
 * would report success for having "focused" an omnibox. Anything the agent was
 * never shown in the listing is rejected by us, not by the browser.
 */
export async function focusCdpTab(
  opts: FocusTabOptions,
  deps?: FocusTabDeps,
): Promise<FocusTabResult> {
  const activate = deps?.activate ?? activateTab;
  const listTabs = deps?.listTabs ?? listPageTabs;

  // 1. Ownership — the same resolution, and therefore the same answer, as a
  //    close against this port.
  const resolved = await resolveCdpOwner(
    opts.roots,
    opts.port,
    opts.allowUnowned === true,
    deps,
  );
  if (!resolved.ok) return resolved;
  const owner = resolved.owner;

  // 2. The tab must be one the caller was shown. See the doc comment: the
  //    browser will happily activate things that are not tabs.
  const tabs = await listTabs(opts.port);
  if (tabs === null) {
    return {
      ok: false,
      kind: 'launch_failed',
      reason: 'tab_list_unreadable',
      error:
        `Could not read the tab list from ${owner.label} on port ${opts.port}. ` +
        'The browser may be shutting down.\n' +
        'Call list_cdp_browsers to see what is still running.',
    };
  }

  const target = tabs.find((t) => t.targetId === opts.targetId);
  if (!target) {
    // Both readings, because the caller cannot tell them apart from here — the
    // same contract `close_cdp_tab` holds, and for the same reason: picking one
    // would be a guess presented as a fact.
    return {
      ok: false,
      kind: 'not_found',
      reason: 'tab_not_found',
      error:
        `No tab with target id ${opts.targetId} is open in ${owner.label} ` +
        `(port ${opts.port}).\n\n` +
        'Either it has already been closed, or the id belongs to a different browser.\n' +
        'Call list_cdp_browsers for the tabs open right now.',
    };
  }

  // 3. Activate, and echo what was read in step 2 so the caller can name what it
  //    brought forward.
  const requested = await activate(opts.port, opts.targetId);
  if (requested.notFound) {
    // In the list a moment ago and gone now — something else closed it in
    // between. Reported rather than absorbed: a caller told `focused: true`
    // with a title and url would tell the user it is looking at a tab that no
    // longer exists.
    return {
      ok: false,
      kind: 'not_found',
      reason: 'tab_vanished',
      error:
        `Tab ${opts.targetId} ("${target.title || target.url}") was open a moment ago but ` +
        'the browser no longer has it — something else closed it first.\n\n' +
        'Call list_cdp_browsers for the tabs open now.',
    };
  }
  if (!requested.ok) {
    return {
      ok: false,
      kind: 'launch_failed',
      reason: 'tab_focus_refused',
      error:
        `The browser refused to bring that tab forward: ${requested.error ?? 'unknown error'}.\n` +
        'Call list_cdp_browsers to check the browser is still running, then retry.',
    };
  }

  return {
    ok: true,
    targetId: opts.targetId,
    title: target.title,
    url: target.url,
    engine: owner.engine,
    profile: owner.profile,
    port: opts.port,
    owned: owner.owned,
    scope: owner.scope,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Reset (§12) — the only destructive operation in this story
// ---------------------------------------------------------------------------

export type ResetResult =
  | { ok: true; warnings: string[] }
  | { ok: false; kind: CdpFailureKind; reason: CdpFailureReason; error: string };

/**
 * Empty a profile so the next launch starts genuinely signed out.
 *
 * Without this a profile can accumulate state but never shed it: test a
 * sign-in flow once and the profile is signed in, so the next run skips the
 * login page and either fails on a missing element or — worse — passes without
 * exercising the login at all.
 *
 * Every step below is a guard, and each closes a different hole. They are
 * ordered cheapest-and-most-certain first, so the ones that cannot be tricked
 * run before the ones that can.
 */
export async function resetProfile(
  projectRoot: string,
  engine: LaunchableEngine,
  profile: string,
  deps?: RegistryDeps,
): Promise<ResetResult> {
  const existsSync = deps?.existsSync ?? fs.existsSync;
  const realpath = deps?.realpath ?? fs.realpathSync;
  const isSymlink = deps?.isSymlink ?? defaultIsSymlink;
  const rename = deps?.rename ?? fs.renameSync;
  const rm = deps?.rm ?? ((p: string) => fs.rmSync(p, { recursive: true, force: true }));
  const warnings: string[] = [];

  // 1. Validate the name. Rejects separators and `..` before any path is
  //    built, so nothing downstream ever sees a traversal.
  const nameError = validateProfileName(profile);
  if (nameError) return { ok: false, kind: 'invalid_input', reason: 'profile_name_invalid', error: nameError };

  const root = cdpProfilesRoot(projectRoot);
  const profileDir = profileDirFor(projectRoot, engine, profile);

  // Nothing to delete is a successful reset, not an error: the caller asked
  // for an empty profile and an absent one is empty.
  if (!existsSync(profileDir)) return { ok: true, warnings };

  // 2. Refuse a symlinked profile directory outright.
  //
  //    §12 specifies a realpath comparison, and that is below. This check is
  //    stricter and sits in front of it because realpath alone leaves one case
  //    open: a symlink pointing at a *sibling* profile resolves to a path that
  //    passes confinement, has a valid marker, and is one level below the
  //    root — so the reset would delete a different, legitimate profile than
  //    the caller named. Nothing legitimate creates a symlink here.
  if (isSymlink(profileDir)) {
    return {
      ok: false,
      kind: 'refused',
      reason: 'profile_dir_is_symlink',
      error:
        `Refusing to reset ${profileDir}: it is a symbolic link, and this framework ` +
        'only deletes real directories it created.\n' +
        'Remove the link by hand if that is genuinely what you want reset.',
    };
  }

  // 3. Resolve BOTH sides and compare on a segment boundary. `path.resolve`
  //    does not follow symlinks, so without the realpath a link anywhere in
  //    the chain turns this into a recursive delete of its target.
  let realRoot: string;
  let realDir: string;
  try {
    realRoot = realpath(root);
    realDir = realpath(profileDir);
  } catch (err) {
    return {
      ok: false,
      kind: 'refused',
      reason: 'profile_dir_unresolvable',
      error:
        `Cannot resolve the profile directory ${profileDir}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const rel = path.relative(realRoot, realDir);
  const oneLevelBelow =
    rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
  if (!oneLevelBelow) {
    // Covers the root itself (rel === ''), anything outside it, and anything
    // deeper than one level.
    return {
      ok: false,
      kind: 'refused',
      reason: 'profile_dir_outside_root',
      error:
        `Refusing to reset ${realDir}: it is not a direct child of ${realRoot}.\n` +
        'Only a single profile directory can be reset, never the profiles root ' +
        'and nothing outside it.',
    };
  }

  // 4. Require the marker. This is the guard that does not depend on the path
  //    logic above being right — a directory without it is not one we created,
  //    whatever the confinement check concluded.
  if (!existsSync(path.join(realDir, PROFILE_MARKER))) {
    return {
      ok: false,
      kind: 'refused',
      reason: 'profile_dir_unmarked',
      error:
        `Refusing to reset ${realDir}: it has no ${PROFILE_MARKER} marker, so this ` +
        'framework did not create it and will not delete it.\n' +
        'If wiping that directory is genuinely intended, delete it by hand — this ' +
        'refusal is deliberate and is not worked around in code.',
    };
  }

  // 5. Refuse while a browser is live on it. Deleting under a running browser
  //    pulls the floor out from a live session, and the port is named so the
  //    caller can act rather than guess.
  const existing = await findProfile(projectRoot, engine, profile, deps);
  if (existing?.live) {
    return {
      ok: false,
      kind: 'refused',
      reason: 'profile_in_use',
      error:
        `Cannot reset the ${engineLabel(engine)} profile "${profile}": a browser is ` +
        `running on it (port ${existing.port}).\n` +
        'Close that browser window — or close_session if a run is holding it — then retry.',
    };
  }

  // 6. Rename, then delete.
  //
  //    A direct recursive delete can stop half-way on any error and leave a
  //    partially-removed profile that still looks launchable — a corrupt
  //    browser profile is a far worse outcome than a failed reset. A rename
  //    within one filesystem is atomic, so the real path is either wholly
  //    present or wholly gone.
  //
  //    On Windows the rename also fails outright while files are open, which
  //    is a useful backstop for the case guard 5 cannot see: a browser process
  //    alive but its debugging port dead. It fails loudly with the OS error
  //    instead of corrupting the profile.
  const trash = path.join(realRoot, `${TRASH_PREFIX}${engine}-${profile}-${process.pid}`);
  try {
    rename(realDir, trash);
  } catch (err) {
    return {
      ok: false,
      // Not `refused`: the request was fine and we tried. A locked file is the
      // machine saying no, and the caller's next move is to close whatever
      // holds it and retry — same shape as a launch failure.
      kind: 'launch_failed',
      reason: 'profile_reset_failed',
      error:
        `Could not reset the ${engineLabel(engine)} profile "${profile}": ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        '**Nothing was deleted** — the profile is intact. Close anything holding ' +
        'files in it (a browser, an explorer window, an antivirus scan) and retry.',
    };
  }

  // The real path is already gone as far as any caller is concerned, so a
  // failed cleanup is a warning rather than an error.
  try {
    rm(trash);
  } catch (err) {
    warnings.push(
      `The profile was reset, but its staging directory could not be removed: ` +
        `${trash} (${err instanceof Error ? err.message : String(err)}). ` +
        'Delete it by hand when convenient.',
    );
  }

  return { ok: true, warnings };
}

// ---------------------------------------------------------------------------
// Real-fs defaults
// ---------------------------------------------------------------------------

function defaultReaddir(dir: string): { name: string; isDirectory: () => boolean }[] {
  return fs.readdirSync(dir, { withFileTypes: true });
}

function defaultIsSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function defaultUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // Absent is the expected case on a first launch.
  }
}
