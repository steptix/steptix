/**
 * `steptix server install|list|use|remove`, `steptix uninstall` and the
 * `--version` details (docs/specs/SPEC-install.md §4.8, §5.3, §6.5, §9.1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchInfo } from '../src/launcher/launch.js';
import { listRuntimes, markInUse, readChoice, writeChoice, writeClientRecord, type Layout } from '../src/launcher/runtimes.js';
import {
  serverInstall,
  serverList,
  serverRemove,
  serverUse,
  uninstall,
  versionDetails,
  type ServerIo,
} from '../src/cli/commands/server.js';
import { makeScratch, npmPackageDir, removeScratch, scratchLayout, writeFakePackage, writeFakeRuntime } from './launcher-helpers.js';

let scratch: string;
let layout: Layout;
let out: string[];
let err: string[];

beforeEach(() => {
  scratch = makeScratch('steptix-server-cmd-');
  layout = scratchLayout(scratch);
  out = [];
  err = [];
});

afterEach(() => removeScratch(scratch));

function io(answer?: boolean): ServerIo {
  const result: ServerIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
  if (answer !== undefined) {
    result.confirm = async (question) => {
      out.push(question);
      return answer;
    };
  }
  return result;
}

function npmLaunch(version = '1.4.0'): LaunchInfo {
  const root = writeFakePackage(npmPackageDir(scratch), { version });
  return { launcherRoot: root, launcherVersion: version, launcherKind: 'npm', requires: '1.4.0', layout, runtime: null, chosen: false };
}

describe('server install', () => {
  it("copies npm's package into runtimes and reports it as JSON", async () => {
    expect(await serverInstall(npmLaunch(), { json: true }, io())).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({
      version: '1.4.0',
      dir: path.join(layout.runtimesDir, '1.4.0'),
      source: 'npm',
      installed: true,
    });
    expect(err).toEqual(['Setting up Steptix 1.4.0…']);
  });

  it('records the VS Code extension as the source when it does the install', async () => {
    expect(await serverInstall(npmLaunch(), { json: true, source: 'extension' }, io())).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ version: '1.4.0', source: 'extension' });
    expect(listRuntimes(layout)[0]?.source).toBe('extension');
  });

  it('says it was set up already', async () => {
    writeFakeRuntime(layout, '1.4.0');
    expect(await serverInstall(npmLaunch(), {}, io())).toBe(0);
    expect(out).toEqual([`Steptix 1.4.0 is already set up in ${path.join(layout.runtimesDir, '1.4.0')}`]);
  });

  it('refuses in a checkout, saying how to try an install', async () => {
    const info = { ...npmLaunch(), launcherKind: 'checkout' as const };
    expect(await serverInstall(info, {}, io())).toBe(1);
    expect(err[0]).toMatch(/runs from a checkout .* npm pack/);
    expect(listRuntimes(layout)).toEqual([]);
  });
});

describe('server list', () => {
  it('shows each version, where it came from, which one runs, the choice and what is running', () => {
    writeFakeRuntime(layout, '1.3.0', 'npm');
    writeFakeRuntime(layout, '1.4.0', 'extension');
    writeFakeRuntime(layout, '1.4.1', 'offline file');
    markInUse(layout, '1.4.1');

    expect(serverList(npmLaunch(), {}, io())).toBe(0);
    expect(out).toEqual([
      `Steptix servers in ${layout.runtimesDir}:`,
      '  1.4.1  from an offline file, runs in this terminal, running now',
      '  1.4.0  from the VS Code extension',
      '  1.3.0  from npm',
      'No version is chosen, so the newest one that matches runs. Choose one with: steptix server use <version>',
    ]);
  });

  it('shows the choice', () => {
    writeFakeRuntime(layout, '1.3.0');
    writeFakeRuntime(layout, '1.4.0');
    writeChoice(layout, '1.3.0');

    serverList(npmLaunch(), { json: true }, io());

    const listed = JSON.parse(out[0]!) as { chosen: string; runtimes: Array<{ version: string; runsHere: boolean }> };
    expect(listed.chosen).toBe('1.3.0');
    expect(listed.runtimes.filter((r) => r.runsHere).map((r) => r.version)).toEqual(['1.3.0']);
  });
});

describe('server use', () => {
  it('chooses an installed version, and newest undoes it', () => {
    writeFakeRuntime(layout, '1.3.0');
    expect(serverUse(npmLaunch(), '1.3.0', io())).toBe(0);
    expect(readChoice(layout)).toBe('1.3.0');
    expect(out.join('\n')).toMatch(/run Steptix server 1\.3\.0[\s\S]*extension is 1\.3\.x/);

    expect(serverUse(npmLaunch(), 'newest', io())).toBe(0);
    expect(readChoice(layout)).toBeNull();
  });

  it('refuses a version that is not installed, naming what is', () => {
    writeFakeRuntime(layout, '1.4.0');
    expect(serverUse(npmLaunch(), '1.3.0', io())).toBe(1);
    expect(err).toEqual(['Steptix server 1.3.0 is not installed. Installed: 1.4.0.']);
    expect(readChoice(layout)).toBeNull();
  });
});

describe('server remove', () => {
  it('removes a version', async () => {
    writeFakeRuntime(layout, '1.3.0');
    expect(await serverRemove(npmLaunch(), '1.3.0', io())).toBe(0);
    expect(listRuntimes(layout)).toEqual([]);
  });

  it('refuses the chosen version, and one that is running', async () => {
    writeFakeRuntime(layout, '1.3.0');
    writeFakeRuntime(layout, '1.4.0');
    writeChoice(layout, '1.3.0');
    markInUse(layout, '1.4.0');

    expect(await serverRemove(npmLaunch(), '1.3.0', io())).toBe(1);
    expect(await serverRemove(npmLaunch(), '1.4.0', io())).toBe(1);
    expect(err[0]).toMatch(/version you chose with steptix server use/);
    expect(err[1]).toMatch(/is running\. Stop it first with steptix stop/);
    expect(listRuntimes(layout)).toHaveLength(2);
  });
});

describe('uninstall', () => {
  it('asks, removes every server and the choice, then names npm rm -g steptix', async () => {
    writeFakeRuntime(layout, '1.3.0');
    writeFakeRuntime(layout, '1.4.0');
    writeChoice(layout, '1.3.0');

    expect(await uninstall(npmLaunch(), {}, io(true))).toBe(0);
    expect(out).toContain('Remove them? [y/N] ');
    expect(out.at(-1)).toBe('To remove the steptix command too, run: npm rm -g steptix');
    expect(listRuntimes(layout)).toEqual([]);
    expect(readChoice(layout)).toBeNull();
  });

  it('warns first when the VS Code extension uses the servers', async () => {
    writeFakeRuntime(layout, '1.4.0');
    const ext = path.join(scratch, 'ext');
    fs.mkdirSync(ext);
    writeClientRecord(layout, { kind: 'vscode', version: '1.4.0', requires: '1.4.0', location: ext });

    expect(await uninstall(npmLaunch(), {}, io(false))).toBe(1);
    expect(out).toContain(
      'The Steptix extension in VS Code uses these servers. It will download one again on its next Run. Remove them anyway? [y/N] ',
    );
    expect(listRuntimes(layout)).toHaveLength(1);
  });

  it('asks the user to stop a running server first', async () => {
    writeFakeRuntime(layout, '1.4.0');
    markInUse(layout, '1.4.0');

    expect(await uninstall(npmLaunch(), { yes: true }, io())).toBe(1);
    expect(err[0]).toMatch(/running from server 1\.4\.0\. Stop it first with steptix stop/);
    expect(listRuntimes(layout)).toHaveLength(1);
  });

  it('does not remove anything with nobody to answer, unless told --yes', async () => {
    writeFakeRuntime(layout, '1.4.0');
    expect(await uninstall(npmLaunch(), {}, io())).toBe(1);
    expect(err.join('\n')).toMatch(/steptix uninstall --yes/);
    expect(listRuntimes(layout)).toHaveLength(1);

    expect(await uninstall(npmLaunch(), { yes: true }, io())).toBe(0);
    expect(listRuntimes(layout)).toEqual([]);
  });
});

describe('--version', () => {
  it('names the launcher, the server it runs and where from, and whether it was chosen', () => {
    const dir = writeFakeRuntime(layout, '1.4.2');
    const runtime = { version: '1.4.2', dir, source: 'npm' as const };

    const newest = versionDetails({ ...npmLaunch(), runtime }).split('\n');
    expect(newest[0]).toMatch(/^1\.4\.0\b/);
    expect(newest[1]).toMatch(new RegExp(`^Server: 1\\.4\\.2\\b.*, from ${dir.replace(/\\/g, '\\\\')}$`));
    expect(newest[2]).toBe('The newest 1.4.x installed; none was chosen with steptix server use.');

    const chosen = versionDetails({ ...npmLaunch(), runtime, chosen: true }).split('\n');
    expect(chosen[2]).toMatch(/You chose this version with steptix server use/);
  });

  it('says a checkout runs itself', () => {
    const info = { ...npmLaunch(), launcherKind: 'checkout' as const };
    expect(versionDetails(info).split('\n')[1]).toBe(`Server: this checkout, ${info.launcherRoot}`);
  });
});
