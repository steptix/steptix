/**
 * `steptix server install|list|use|remove`, `steptix uninstall` and the
 * `steptix --version` details (docs/specs/SPEC-install.md §4.8, §5.3, §6.5,
 * §9.1).
 *
 * The launcher runs `server` and `uninstall` in the package they were started
 * from, never in a runtime it would hand off to, and sets nothing up first
 * (src/launcher/launch.ts).
 */

import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { currentLaunch, type LaunchInfo } from '../../launcher/launch.js';
import {
  cleanUp,
  InstallError,
  installPackage,
  listRuntimes,
  readChoice,
  readClientRecords,
  readRuntime,
  removeRuntimes,
  selectRuntime,
  versionsInUse,
  withInstallLock,
  writeChoice,
  type Runtime,
  type RuntimeSource,
} from '../../launcher/runtimes.js';
import { majorMinor, parseVersion } from '../../launcher/versions.js';
import { buildInfoAt, describeVersion, getBuildInfo } from '../../utils/version.js';

/** Where a command's lines go, and how it asks a yes/no question. */
export interface ServerIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Asks and resolves true on yes. Undefined when nobody can answer, such as
   *  with stdin not a terminal. */
  confirm?: (question: string) => Promise<boolean>;
}

const NPM_REMOVE_HINT = 'To remove the steptix command too, run: npm rm -g steptix';

function sourceLabel(source: RuntimeSource | null): string {
  switch (source) {
    case 'npm':
      return 'from npm';
    case 'extension':
      return 'from the VS Code extension';
    case 'offline file':
      return 'from an offline file';
    default:
      return 'source unknown';
  }
}

/** The runtime this launcher would run, as the launch step chooses it. */
function selectionFor(info: LaunchInfo, runtimes: Runtime[]) {
  return selectRuntime(runtimes, info.requires, readChoice(info.layout));
}

// ---------------------------------------------------------------------------
// --version (§4.8)
// ---------------------------------------------------------------------------

/**
 * What `steptix --version` prints: the launcher's version and build on the
 * first line, as it always has, then the server it runs, from where, and
 * whether the user chose it.
 */
export function versionDetails(info: LaunchInfo = currentLaunch()): string {
  const { runtime } = info;
  // When the command runs where it was started, this code is the launcher's
  // own; read its stamp the usual way, which knows when it runs from src/.
  const launcherBuild = runtime === null ? getBuildInfo() : buildInfoAt(info.launcherRoot);
  const lines = [describeVersion({ version: info.launcherVersion, ...launcherBuild })];
  if (runtime !== null) {
    lines.push(`Server: ${describeVersion({ version: runtime.version, ...getBuildInfo() })}, from ${runtime.dir}`);
    lines.push(
      info.chosen
        ? `You chose this version with steptix server use. To run the newest again: steptix server use newest`
        : `The newest ${majorMinor(info.requires) ?? info.requires}.x installed; none was chosen with steptix server use.`,
    );
  } else if (info.launcherKind === 'checkout') {
    lines.push(`Server: this checkout, ${info.launcherRoot}`);
  } else {
    lines.push(`Server: ${info.launcherVersion}, from ${info.launcherRoot}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// server install (§5.3)
// ---------------------------------------------------------------------------

export async function serverInstall(info: LaunchInfo, opts: { json?: boolean }, io: ServerIo): Promise<number> {
  const report = (runtime: Runtime, installed: boolean) => {
    if (opts.json) {
      io.out(JSON.stringify({ version: runtime.version, dir: runtime.dir, source: runtime.source, installed }));
    } else {
      io.out(`Steptix ${runtime.version} is ${installed ? 'now' : 'already'} set up in ${runtime.dir}`);
    }
    return 0;
  };
  if (info.launcherKind === 'checkout') {
    io.err(
      `This steptix runs from a checkout (${info.launcherRoot}), not from an install, so there is nothing to set up. ` +
        'To try an install, pack it with npm pack and install the file with npm i -g.',
    );
    return 1;
  }
  if (info.launcherKind === 'runtime') {
    const runtime = readRuntime(info.layout.runtimesDir, info.launcherVersion);
    if (runtime) return report(runtime, false);
  }
  try {
    const result = await installPackage(info.launcherRoot, info.layout, {
      onCopy: (v) => io.err(`Setting up Steptix ${v}…`),
      onWait: () => io.err('Waiting for Steptix to finish setting up in another window or terminal…'),
    });
    await cleanUp(info.layout, { keep: [result.runtime.version] }).catch(() => undefined);
    return report(result.runtime, result.installed);
  } catch (err) {
    if (!(err instanceof InstallError)) throw err;
    io.err(err.message);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// server list (§6.5)
// ---------------------------------------------------------------------------

export function serverList(info: LaunchInfo, opts: { json?: boolean }, io: ServerIo): number {
  const runtimes = listRuntimes(info.layout);
  const choice = readChoice(info.layout);
  const inUse = versionsInUse(info.layout);
  const runsHere = info.launcherKind === 'checkout' ? null : (selectionFor(info, runtimes).runtime?.version ?? null);
  if (opts.json) {
    io.out(
      JSON.stringify({
        runtimesDir: info.layout.runtimesDir,
        chosen: choice,
        launcher: { version: info.launcherVersion, kind: info.launcherKind, root: info.launcherRoot },
        runtimes: runtimes.map((r) => ({
          version: r.version,
          dir: r.dir,
          source: r.source,
          runsHere: r.version === runsHere,
          running: inUse.has(r.version),
        })),
      }),
    );
    return 0;
  }
  if (runtimes.length === 0) {
    io.out(`No Steptix servers are installed in ${info.layout.runtimesDir}.`);
  } else {
    io.out(`Steptix servers in ${info.layout.runtimesDir}:`);
    const width = Math.max(...runtimes.map((r) => r.version.length));
    for (const r of [...runtimes].reverse()) {
      const notes = [sourceLabel(r.source)];
      if (r.version === runsHere) notes.push('runs in this terminal');
      if (r.version === choice) notes.push('chosen');
      if (inUse.has(r.version)) notes.push('running now');
      io.out(`  ${r.version.padEnd(width)}  ${notes.join(', ')}`);
    }
  }
  if (info.launcherKind === 'checkout') {
    io.out(`This steptix runs from a checkout instead: ${info.launcherRoot}`);
  } else if (info.launcherKind === 'npm' && !runtimes.some((r) => r.version === info.launcherVersion) && runsHere === null) {
    io.out(`npm's steptix ${info.launcherVersion} is set up on its first command.`);
  }
  io.out(
    choice === null
      ? 'No version is chosen, so the newest one that matches runs. Choose one with: steptix server use <version>'
      : `Chosen with steptix server use: ${choice}. To run the newest again: steptix server use newest`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// server use (§6.5)
// ---------------------------------------------------------------------------

export function serverUse(info: LaunchInfo, version: string, io: ServerIo): number {
  if (version === 'newest') {
    writeChoice(info.layout, null);
    io.out('From the next start, the terminal and VS Code run the newest Steptix server that matches each of them.');
    return 0;
  }
  const runtimes = listRuntimes(info.layout);
  if (!runtimes.some((r) => r.version === version)) {
    io.err(
      parseVersion(version) === null
        ? `"${version}" is not a version. Give one from steptix server list, or newest.`
        : `Steptix server ${version} is not installed. ` +
            (runtimes.length > 0
              ? `Installed: ${runtimes.map((r) => r.version).join(', ')}.`
              : 'None is installed.'),
    );
    return 1;
  }
  writeChoice(info.layout, version);
  io.out(`From the next start, the terminal and VS Code run Steptix server ${version}.`);
  io.out(
    `VS Code runs it only while the Steptix extension is ${majorMinor(version)}.x too. ` +
      'To undo the choice: steptix server use newest',
  );
  return 0;
}

// ---------------------------------------------------------------------------
// server remove
// ---------------------------------------------------------------------------

export async function serverRemove(info: LaunchInfo, version: string, io: ServerIo): Promise<number> {
  const runtime = listRuntimes(info.layout).find((r) => r.version === version);
  if (!runtime) {
    io.err(`Steptix server ${version} is not installed. See steptix server list.`);
    return 1;
  }
  if (readChoice(info.layout) === version) {
    io.err(
      `Steptix server ${version} is the version you chose with steptix server use. ` +
        'Choose another first, or run: steptix server use newest',
    );
    return 1;
  }
  const result = await withInstallLock(info.layout, () => removeRuntimes(info.layout, [runtime]));
  const skipped = result.skipped[0];
  if (skipped) {
    io.err(
      skipped.reason === 'running'
        ? `Steptix server ${version} is running. Stop it first with steptix stop, then try again.`
        : `Could not remove Steptix server ${version}: ${skipped.reason}. Close whatever uses it and try again.`,
    );
    return 1;
  }
  io.out(`Removed Steptix server ${version}.`);
  return 0;
}

// ---------------------------------------------------------------------------
// uninstall (§9.1)
// ---------------------------------------------------------------------------

export async function uninstall(info: LaunchInfo, opts: { yes?: boolean }, io: ServerIo): Promise<number> {
  const runtimes = listRuntimes(info.layout);
  const hint = info.launcherKind === 'npm' ? [NPM_REMOVE_HINT] : [];
  if (runtimes.length === 0) {
    io.out(`No Steptix servers are installed in ${info.layout.runtimesDir}.`);
    hint.forEach((line) => io.out(line));
    return 0;
  }
  const inUse = versionsInUse(info.layout);
  const running = runtimes.filter((r) => inUse.has(r.version)).map((r) => r.version);
  if (running.length > 0) {
    io.err(
      `Steptix is running from ${running.length === 1 ? 'server' : 'servers'} ${running.join(', ')}. ` +
        'Stop it first with steptix stop (in VS Code: Steptix: Stop Server), then run steptix uninstall again.',
    );
    return 1;
  }
  const versions = runtimes.map((r) => r.version).join(', ');
  io.out(`This removes ${runtimes.length === 1 ? 'the Steptix server' : 'the Steptix servers'} ${versions} from ${info.layout.runtimesDir}.`);
  if (!opts.yes) {
    const usedByVsCode = readClientRecords(info.layout).some((c) => c.kind === 'vscode');
    const question = usedByVsCode
      ? 'The Steptix extension in VS Code uses these servers. It will download one again on its next Run. Remove them anyway? [y/N] '
      : 'Remove them? [y/N] ';
    if (!io.confirm) {
      io.err(`${question.replace(/ \[y\/N\] $/, '')}\nRun steptix uninstall --yes to remove them without being asked.`);
      return 1;
    }
    if (!(await io.confirm(question))) {
      io.out('Nothing was removed.');
      return 1;
    }
  }
  const result = await withInstallLock(info.layout, () => {
    writeChoice(info.layout, null);
    return removeRuntimes(info.layout, runtimes);
  });
  if (result.removed.length > 0) io.out(`Removed ${result.removed.join(', ')}.`);
  for (const { version, reason } of result.skipped) {
    io.err(
      reason === 'running'
        ? `Steptix server ${version} started running, so it was left. Stop it with steptix stop and run this again.`
        : `Could not remove Steptix server ${version}: ${reason}. Close whatever uses it and run this again.`,
    );
  }
  hint.forEach((line) => io.out(line));
  return result.skipped.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function consoleIo(): ServerIo {
  const io: ServerIo = {
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n'),
  };
  if (process.stdin.isTTY) {
    io.confirm = async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    };
  }
  return io;
}

function finish(code: number): void {
  // Not process.exit(): stdout to a pipe is asynchronous on Windows.
  process.exitCode = code;
}

export function registerServerCommand(program: Command): void {
  const server = program
    .command('server')
    .description('Manage the Steptix servers installed on this machine');

  server
    .command('install')
    .description("Set up this steptix's own version as an installed server")
    .option('--json', 'Print the result as JSON')
    .action(async (opts: { json?: boolean }) => finish(await serverInstall(currentLaunch(), opts, consoleIo())));

  server
    .command('list')
    .description('List the installed servers, where each came from, and which one runs')
    .option('--json', 'Print the list as JSON')
    .action((opts: { json?: boolean }) => finish(serverList(currentLaunch(), opts, consoleIo())));

  server
    .command('use <version>')
    .description('Run this installed version from the next start, or "newest" to undo a choice')
    .action((version: string) => finish(serverUse(currentLaunch(), version, consoleIo())));

  server
    .command('remove <version>')
    .description('Remove an installed server')
    .action(async (version: string) => finish(await serverRemove(currentLaunch(), version, consoleIo())));
}

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Remove every installed Steptix server (then npm rm -g steptix removes the command)')
    .option('-y, --yes', 'Remove them without asking')
    .action(async (opts: { yes?: boolean }) => finish(await uninstall(currentLaunch(), opts, consoleIo())));
}
