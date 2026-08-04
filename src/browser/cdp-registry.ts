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
import { probePort, type CdpDiscoveryTab } from './cdp-discovery.js';

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
 *   - `refused`       — the request is well-formed but the state on disk says
 *                       no: a live browser, a directory we did not create (409).
 *   - `launch_failed` — we tried and the machine or the browser let us down
 *                       (500). The engine is missing, the port file never
 *                       appeared, the profile dir is not writable.
 */
export type CdpFailureKind = 'invalid_input' | 'refused' | 'launch_failed';

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
