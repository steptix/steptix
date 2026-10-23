/**
 * The VS Code extension reads `runtimes/` with its own copy of the launcher's
 * rules (steptix-vscode/src/extension/install-core.ts), since its bundle
 * cannot import the framework. Held to the launcher's (src/launcher/) here: if
 * the two drifted, a terminal and VS Code could see different servers, or the
 * extension start one the launcher would not (docs/specs/SPEC-install.md §4.2).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listRuntimes, selectRuntime, writeChoice, readChoice, type Layout } from '../src/launcher/runtimes.js';
import { compareVersions } from '../src/launcher/versions.js';
// The extension's source, as control-line-parity.test.ts imports runner-core's.
import {
  compareVersions as extensionCompare,
  listInstalledServers,
  pickServer,
  readServerChoice,
} from '../steptix-vscode/src/extension/install-core.ts';
import { makeScratch, removeScratch, scratchLayout, writeFakePackage, writeFakeRuntime } from './launcher-helpers.js';

let scratch: string;
let layout: Layout;

beforeEach(() => {
  scratch = makeScratch('steptix-install-parity-');
  layout = scratchLayout(scratch);
});

afterEach(() => removeScratch(scratch));

describe('the extension and the launcher', () => {
  it('order versions the same way', () => {
    const names = ['1.10.0', '1.2.10', '1.2.9', '2.0.0', '1.0.0-beta.1', '1.0.0', 'notes', '1.0.0-beta.10', '1.0.0-beta.2'];
    expect([...names].sort(extensionCompare)).toEqual([...names].sort(compareVersions));
  });

  it('see the same installed servers, from the same sources', () => {
    writeFakeRuntime(layout, '1.4.0', 'npm');
    writeFakeRuntime(layout, '1.4.2', 'extension');
    writeFakeRuntime(layout, '1.5.0', 'offline file');
    writeFakePackage(path.join(layout.runtimesDir, '.partial-1.4.3-1-ab'), { version: '1.4.3' });
    writeFakePackage(path.join(layout.runtimesDir, '1.0.0-beta.1', 'server'), { version: '1.0.0-beta.1' });
    // A package with no install record: copied in by hand, so neither runs it.
    writeFakePackage(path.join(layout.runtimesDir, '1.4.1'), { version: '1.4.1' });

    const launcher = listRuntimes(layout).map((r) => [r.version, r.source]);
    const extension = listInstalledServers(layout.runtimesDir).map((s) => [s.version, s.source]);
    expect(extension).toEqual(launcher);
  });

  it('pick the same server for a requirement, and read the same choice', () => {
    for (const v of ['1.3.0', '1.4.0', '1.4.2', '1.5.0']) writeFakeRuntime(layout, v);
    const runtimes = listRuntimes(layout);
    const servers = listInstalledServers(layout.runtimesDir);
    for (const requires of ['1.4.0', '1.4.2', '1.3.0', '1.6.0']) {
      const launcher = selectRuntime(runtimes, requires, null).runtime?.version ?? null;
      const picked = pickServer(servers, requires, null);
      expect(picked.kind === 'run' ? picked.server.version : null).toBe(launcher);
    }
    writeChoice(layout, '1.4.0');
    expect(readServerChoice(layout.root)).toBe(readChoice(layout));
    const picked = pickServer(servers, '1.4.0', readServerChoice(layout.root));
    expect(picked).toMatchObject({ kind: 'run', chosen: true, server: { version: selectRuntime(runtimes, '1.4.0', readChoice(layout)).runtime?.version } });
    expect(fs.existsSync(layout.choiceFile)).toBe(true);
  });
});
