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
  closeTab,
  listPageTabs,
  portAnswers,
  type CdpDiscoveryTab,
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
  | { ok: false; kind: CdpFailureKind; error: string };

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
  if (nameError) return { ok: false, kind: 'invalid_input', error: nameError };

  const existsSync = deps?.existsSync ?? fs.existsSync;
  const launch = deps?.launch ?? launchCdpBrowser;
  const probe = deps?.probe ?? probePort;
  const profileDir = profileDirFor(opts.projectRoot, opts.engine, profile);
  const warnings: string[] = [];

  let outcome: CdpOutcome;

  if (opts.reset) {
    const reset = await resetProfile(opts.projectRoot, opts.engine, profile, deps);
    if (!reset.ok) return { ok: false, kind: reset.kind, error: reset.error };
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
  if (!launched.ok) return { ok: false, kind: 'launch_failed', error: launched.error };

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
  projectRoot: string;
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
   * Which live session, if any, is driving a given tab of this browser.
   *
   * Injected because the answer lives in the server's session map, which this
   * module knows nothing about — and must not, since it is also the module the
   * CLI and any future client sit on.
   */
  sessionHolding?: (targetId: string) => Promise<string | null> | string | null;
}

export type CloseTabResult =
  | {
      ok: true;
      targetId: string;
      title: string;
      url: string;
      engine: LaunchableEngine;
      profile: string;
      port: number;
      /** Page tabs left, counted from the browser after the close — not
       *  arithmetic on the before-count. 0 when the browser exited. */
      remainingTabs: number;
      /** Observed, never assumed: the port stopped answering. */
      browserExited: boolean;
      warnings: string[];
    }
  | { ok: false; kind: CdpFailureKind; error: string };

export interface CloseTabDeps extends RegistryDeps {
  close?: typeof closeTab;
  listTabs?: typeof listPageTabs;
  alive?: typeof portAnswers;
  /** Injected so tests do not spend the confirm budget in real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Close one tab in a browser this project owns.
 *
 * Every guard below closes a different hole, and they run cheapest-first so
 * nothing irreversible happens until the request has fully earned it. The
 * ordering that matters most is 3-before-4: a caller who has not asked for a
 * browser exit is told so *before* we bother checking sessions, so the common
 * refusal is the cheap one.
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

  // 1. The port must be one of ours and live. `knownProfiles` is the only
  //    answer to "ours": our ports are OS-assigned, so nothing about the number
  //    itself is recognisable.
  const profiles = await knownProfiles(opts.projectRoot, deps);
  const owner = profiles.find((p) => p.live && p.port === opts.port);
  if (!owner) {
    const running = profiles.filter((p) => p.live);
    return {
      ok: false,
      kind: 'not_found',
      error:
        `Port ${opts.port} is not a CDP browser this project has running.\n` +
        (running.length > 0
          ? `Running now: ${running.map((p) => `${engineLabel(p.engine)} "${p.profile}" on port ${p.port}`).join(', ')}.`
          : 'This project has no CDP browser running.'),
    };
  }

  // 2. Read the tab list through the SHARED filter, so what may be closed and
  //    what was listed can never disagree.
  const before = await listTabs(opts.port);
  if (before === null) {
    return {
      ok: false,
      kind: 'launch_failed',
      error:
        `Could not read the tab list from ${engineLabel(owner.engine)} "${owner.profile}" ` +
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
      error:
        `No tab with target id ${opts.targetId} is open in ${engineLabel(owner.engine)} ` +
        `"${owner.profile}" (port ${opts.port}).\n\n` +
        'Either it has already been closed, or the id belongs to a different browser.\n' +
        'Call list_cdp_browsers for the tabs open right now.',
    };
  }

  // 3. The last tab. Closing it closes the browser — there is no zero-tab
  //    Chromium — so it needs saying out loud rather than discovering.
  const isLast = before.length === 1;
  if (isLast && opts.allowBrowserExit !== true) {
    return {
      ok: false,
      kind: 'refused',
      error:
        `"${target.title || target.url}" is the only tab open in ` +
        `${engineLabel(owner.engine)} "${owner.profile}", and closing a browser's last ` +
        'tab closes the browser itself.\n\n' +
        '**Nothing is lost by doing it** — the profile keeps its signed-in state on ' +
        `disk, and start_cdp_browser with profile "${owner.profile}" brings it back still ` +
        'signed in.\n' +
        'Pass allow_browser_exit: true if closing the browser is what you want.',
    };
  }

  // 4. A tab a live session is driving. Yanking it turns that session's next
  //    step into a baffling page-closed failure, so the session gets closed
  //    deliberately first — via the door that exists for it.
  const holder = await opts.sessionHolding?.(opts.targetId);
  if (holder) {
    return {
      ok: false,
      kind: 'refused',
      error:
        `Session "${holder}" is driving that tab ("${target.title || target.url}"). ` +
        'Closing it would break that session mid-run.\n\n' +
        `Close the session first — close_session with session_id "${holder}" — then ` +
        'retry, or leave the tab alone if the session is still wanted.',
    };
  }

  // 5. Close, then confirm. The browser acknowledges before the tab is gone
  //    (W0: 1-5 ms ack, 7-41 ms actual), so the ack alone is an intention.
  const requested = await close(opts.port, opts.targetId);
  if (!requested.ok && !requested.notFound) {
    return {
      ok: false,
      kind: 'launch_failed',
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
        `The tab was closed but ${engineLabel(owner.engine)} "${owner.profile}" is still ` +
          `running on port ${opts.port}. It may be configured to stay resident with no ` +
          'windows open.',
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
      warnings,
    };
  }

  const gone = await pollUntil(async () => {
    const tabs = await listTabs(opts.port);
    return tabs !== null && !tabs.some((t) => t.targetId === opts.targetId);
  }, { sleep, now });

  if (!gone) {
    return {
      ok: false,
      kind: 'launch_failed',
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
        warnings,
      };
    }
    if (after === null) {
      warnings.push(
        `The tab was closed, but the tab list could not be re-read on port ${opts.port}, ` +
          'so the remaining count may be stale.',
      );
    }
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
// Reset (§12) — the only destructive operation in this story
// ---------------------------------------------------------------------------

export type ResetResult =
  | { ok: true; warnings: string[] }
  | { ok: false; kind: CdpFailureKind; error: string };

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
  if (nameError) return { ok: false, kind: 'invalid_input', error: nameError };

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
