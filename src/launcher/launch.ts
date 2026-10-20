/**
 * The launcher: the first thing every `steptix` command does
 * (docs/specs/SPEC-install.md §3.4, §4.2, §5.1).
 *
 * It picks which server version on this machine runs the command, copies its
 * own package into `<Steptix folder>/runtimes/<version>/` on first use, and
 * hands the command to the runtime it picked by importing that runtime's
 * entry point in this same process. The imported entry runs this module
 * again, finds the launch already made ({@link LAUNCH_KEY}) and goes on to
 * the command.
 *
 * What it does depends on where this package is:
 *
 * - **In a checkout** (`node dist/index.js` in this repo, `npm link`): runs
 *   the command here and touches nothing in the Steptix folder, so a checkout
 *   always runs its own build.
 * - **Installed by npm** (any `node_modules/steptix`): records itself as a
 *   client, sets itself up in `runtimes/` on first use, then hands off to the
 *   newest matching runtime, or the one chosen with `steptix server use`.
 * - **In `runtimes/`** (the extension's `steptix` script, a server the
 *   extension starts): hands off the same way, to the chosen runtime or the
 *   newest one of its own major.minor, which is usually itself.
 *
 * Imports only Node built-ins and modules that themselves import only Node
 * built-ins and each other (src/launcher/, src/env/user-root-dir.ts,
 * src/utils/pid-alive.ts): `steptix mcp` runs through here too, and nothing
 * may print on its stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { userRootDir } from '../env/user-root-dir.js';
import {
  cleanUp,
  INSTALL_RECORD,
  InstallError,
  installPackage,
  layoutOf,
  listRuntimes,
  markInUse,
  NotSelfContainedError,
  readChoice,
  readPackageInfo,
  selectRuntime,
  writeClientRecord,
  type Layout,
  type Runtime,
} from './runtimes.js';
import { firstRunLines } from './first-run.js';
import { compareVersions, defaultRequirement, satisfies } from './versions.js';

export type InstallKind = 'checkout' | 'npm' | 'runtime';

/** What the launch decided, for `steptix --version` and `steptix server`. */
export interface LaunchInfo {
  /** The package the command was started from. */
  launcherRoot: string;
  launcherVersion: string;
  launcherKind: InstallKind;
  /** The server this launcher needs: its own major.minor, any patch. */
  requires: string;
  layout: Layout;
  /** The runtime running the command, or null when it runs from
   *  `launcherRoot` without one: a checkout, npm's copy when no runtime
   *  matches, and `steptix server` and `steptix uninstall`, which never
   *  pick one. */
  runtime: Runtime | null;
  /** True when `runtime` is the version chosen with `steptix server use`. */
  chosen: boolean;
}

/**
 * Where the launch is kept for the runtime it hands off to. A process-wide
 * symbol, not a module variable: the runtime's copy of this module is a
 * different module instance, possibly of another version. Every version from
 * 1.0.0 on reads it, so keep its name and the fields it reads stable.
 */
export const LAUNCH_KEY = Symbol.for('steptix.launch');

type LaunchGlobal = { [LAUNCH_KEY]?: LaunchInfo };

/** Commands that manage the runtimes themselves: run by the package they were
 *  started from, never handed off, and never set up a runtime first. */
const MANAGEMENT_COMMANDS = new Set(['server', 'uninstall']);

/** `dist/launcher/launch.js` and `src/launcher/launch.ts` are both two levels down. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface LaunchDeps {
  packageRoot?: string;
  userRoot?: string;
  platform?: NodeJS.Platform;
  /** Where the launcher's own lines go. Never stdout: see the module comment. */
  log?: (line: string) => void;
  /** Holds the launch: `globalThis` unless a test gives its own. */
  store?: object;
  /** Prepares this process to run a runtime: {@link applyRuntimeHooks} unless a test stubs it. */
  applyHooks?: (runtimeDir: string, args: string[]) => Promise<void>;
  /** Runs `fn` when the process exits: `process.once('exit')` unless a test stubs it. */
  onExit?: (fn: () => void) => void;
  /** What the first set-up says about the browser and the AI: {@link firstRunLines}
   *  for this machine unless a test stubs it. */
  firstRun?: (machineEnv: string) => string[];
}

export type LaunchPlan =
  | { kind: 'here' }
  | { kind: 'hand-off'; /** The runtime's entry point, as a URL to import. */ entry: string; version: string; dir: string };

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const fold = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  return fold(realpath(a)) === fold(realpath(b));
}

/**
 * Where this package is, read from the package alone, never from the user
 * root: a runtime is a folder in some `runtimes/` that an install recorded
 * itself in, and an npm install is a `node_modules/steptix`.
 */
export function installKindOf(packageRoot: string): InstallKind {
  const real = realpath(packageRoot);
  const parent = path.basename(path.dirname(real)).toLowerCase();
  if (parent === 'runtimes' && fs.existsSync(path.join(real, INSTALL_RECORD))) return 'runtime';
  return parent === 'node_modules' ? 'npm' : 'checkout';
}

/** The launch made for this process, or what it would be with no launch step
 *  (vitest, or code imported without going through `src/index.ts`). */
export function currentLaunch(deps: LaunchDeps = {}): LaunchInfo {
  const made = ((deps.store ?? globalThis) as LaunchGlobal)[LAUNCH_KEY];
  if (made) return made;
  return describeHere(deps);
}

function describeHere(deps: LaunchDeps): LaunchInfo {
  const root = deps.packageRoot ?? PACKAGE_ROOT;
  const version = readPackageInfo(root)?.version ?? 'unknown';
  const kind = installKindOf(root);
  // A runtime belongs to the Steptix folder it sits in. Everything else uses
  // the user's, worked out from the environment without touching the disk.
  const layout = layoutOf(
    kind === 'runtime' ? path.dirname(path.dirname(path.resolve(root))) : (deps.userRoot ?? userRootDir()),
  );
  return {
    launcherRoot: root,
    launcherVersion: version,
    launcherKind: kind,
    requires: defaultRequirement(version) ?? version,
    layout,
    runtime: null,
    chosen: false,
  };
}

/**
 * Decide where `args` runs. Returns `here` to run it in this package, or the
 * entry point of the runtime to import instead.
 */
export async function prepareLaunch(args: string[], deps: LaunchDeps = {}): Promise<LaunchPlan> {
  const g = (deps.store ?? globalThis) as LaunchGlobal;
  // This is the runtime a launcher handed off to.
  if (g[LAUNCH_KEY]) return { kind: 'here' };

  const log = deps.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const applyHooks = deps.applyHooks ?? applyRuntimeHooks;
  const platform = deps.platform ?? process.platform;
  const info = describeHere(deps);
  g[LAUNCH_KEY] = info;
  if (info.launcherKind === 'checkout') return { kind: 'here' };

  const { layout, launcherRoot: root, launcherVersion: version, requires } = info;
  if (info.launcherKind === 'npm') {
    try {
      writeClientRecord(layout, { kind: 'launcher', version, requires, location: realpath(root) });
    } catch {
      // A read-only Steptix folder: the clean-up may then not know this
      // launcher's needs, but it always keeps the newest version.
    }
  }

  if (MANAGEMENT_COMMANDS.has(args[0] ?? '')) return { kind: 'here' };

  let runtimes = listRuntimes(layout);
  if (info.launcherKind === 'npm') {
    // Set up this version unless a matching one at least as new is there
    // already. The clean-up removes an older patch, so copying one back on
    // every command would only have it removed again.
    const covered = runtimes.some((r) => satisfies(r.version, requires) && compareVersions(r.version, version) >= 0);
    if (!covered) {
      try {
        const result = await installPackage(root, layout, {
          onCopy: (v) => log(`Setting up Steptix ${v} (first run only)…`),
          onWait: () => log('Waiting for Steptix to finish setting up in another window or terminal…'),
        });
        if (result.installed) {
          // The very first set-up on this machine, not an update beside an
          // older version: say whether a browser and an AI are there (§7.5).
          if (runtimes.length === 0) {
            const lines =
              deps.firstRun ??
              ((machineEnv: string) => firstRunLines({ cwd: process.cwd(), machineEnv, env: process.env, platform }));
            for (const line of lines(path.join(layout.root, '.env'))) log(line);
          }
          runtimes = listRuntimes(layout);
        }
      } catch (err) {
        // Whatever stopped the copy, npm's own copy still works, so the
        // command runs. A local install cannot be copied and works where it
        // is, so that one runs a matching installed runtime, or else itself,
        // quietly.
        if (!(err instanceof NotSelfContainedError)) {
          const why =
            err instanceof InstallError
              ? err.message
              : `Could not set up Steptix ${version} in ${layout.runtimesDir}: ${err instanceof Error ? err.message : String(err)}`;
          log(`${why}\nRunning Steptix from ${root} this time.`);
        }
      }
    }
  }

  const selection = selectRuntime(runtimes, requires, readChoice(layout));
  if (selection.chosenMissing !== null) {
    log(
      `You chose Steptix server ${selection.chosenMissing} with steptix server use, but it is no longer ` +
        'installed, so the newest one runs instead. To clear the choice: steptix server use newest',
    );
  }
  const target = selection.runtime;
  if (!target) {
    // Nothing installed matches and nothing was chosen: npm's copy could not
    // be set up, or this is a runtime of an older major.minor than any other
    // there. It runs itself.
    await applyHooks(root, args);
    return { kind: 'here' };
  }
  info.runtime = target;
  info.chosen = selection.chosen;

  (deps.onExit ?? ((fn) => process.once('exit', fn)))(markInUse(layout, target.version));
  try {
    await cleanUp(layout, { keep: [target.version], runtimes });
  } catch {
    // Removing old versions is housekeeping; the command still runs.
  }

  await applyHooks(target.dir, args);
  return samePath(root, target.dir, platform)
    ? { kind: 'here' }
    : {
        kind: 'hand-off',
        entry: pathToFileURL(path.join(target.dir, 'dist', 'index.js')).href,
        version: target.version,
        dir: target.dir,
      };
}

/**
 * What an installed Steptix needs before it runs a command, that a checkout
 * run with `node dist/index.js` does without. Carried over from the Windows
 * runtime's launcher (packaging/runtime/runtime-launcher.cjs and
 * runtime-bootstrap.mjs), which this replaces:
 *
 * - `steptix` and `steptix/*` imports that the project cannot resolve itself
 *   resolve to the runtime, so a test project's tools need no copy of
 *   Steptix of their own (§3.4). The server's own tool bundling does the same
 *   in src/tools/reload.ts; this covers what `steptix run` imports directly.
 * - tsx, so tools written in TypeScript load in a project with no
 *   package.json.
 * - source maps, so stack traces name the TypeScript lines.
 * - for `serve`, a Node inspector on a free localhost port, which the
 *   extension's code-behind debugger attaches to.
 */
export async function applyRuntimeHooks(runtimeDir: string, args: string[]): Promise<void> {
  const manifestPath = path.join(runtimeDir, 'package.json');
  let exportsMap: Record<string, string | Record<string, string>>;
  try {
    exportsMap = (JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { exports?: typeof exportsMap }).exports ?? {};
  } catch {
    return;
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (specifier !== 'steptix' && !specifier.startsWith('steptix/')) throw err;
        if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw err;
        const entry = exportsMap[specifier === 'steptix' ? '.' : `./${specifier.slice('steptix/'.length)}`];
        const target = typeof entry === 'string' ? entry : (entry?.['import'] ?? entry?.['default']);
        if (!target) throw err;
        return { url: pathToFileURL(path.join(runtimeDir, target)).href, shortCircuit: true };
      }
    },
  });
  process.setSourceMapsEnabled(true);
  // tsx's main entry, as `node --import tsx` loads it: its ESM and CommonJS
  // hooks both. A project with no package.json, which `steptix init` makes,
  // puts its `.ts` files in a CommonJS scope.
  await import(pathToFileURL(createRequire(manifestPath).resolve('tsx')).href);
  if (args[0] === 'serve') {
    const inspector = await import('node:inspector');
    if (!inspector.url()) inspector.open(0, '127.0.0.1');
  }
}
