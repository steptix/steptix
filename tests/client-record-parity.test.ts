/**
 * The extension records itself through runner-core's copy of the client
 * record (runner-core/src/runtime-clients.ts); the launcher's clean-up reads
 * it with src/launcher/runtimes.ts. Held to one file and one format here
 * (docs/specs/SPEC-install.md §4.3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layoutOf, readClientRecords, writeClientRecord } from '../src/launcher/runtimes.js';
import { userRootDir } from '../src/env/user-root-dir.js';
// runner-core's source, as control-line-parity.test.ts explains.
import {
  clientRecordPath,
  ownMinorRequirement,
  writeClientRecord as coreWrite,
} from '../runner-core/src/runtime-clients.ts';
import { makeScratch, removeScratch } from './launcher-helpers.js';

let scratch: string;

beforeEach(() => {
  scratch = makeScratch('steptix-client-parity-');
});

afterEach(() => removeScratch(scratch));

describe('client records', () => {
  it("runner-core writes the record the launcher's clean-up reads, at the same path", () => {
    const base = path.join(scratch, 'base');
    const deps = { env: { LOCALAPPDATA: base, XDG_CONFIG_HOME: base } };
    expect(userRootDir(deps)).toBe(path.join(base, 'steptix'));
    const rootLayout = layoutOf(userRootDir(deps));
    const ext = path.join(scratch, 'ext');
    fs.mkdirSync(ext);
    const record = { kind: 'vscode', version: '1.4.1', requires: '1.4.0', location: ext };

    coreWrite(record, deps);
    expect(readClientRecords(rootLayout)).toEqual([record]);

    // The launcher's writer lands on the same file, so the two never leave two records.
    writeClientRecord(rootLayout, { ...record, version: '1.4.2' });
    expect(fs.readdirSync(rootLayout.clientsDir)).toEqual([path.basename(clientRecordPath(record, deps))]);
  });

  it('asks for its own major.minor, any patch', () => {
    expect(ownMinorRequirement('1.4.7')).toBe('1.4.0');
    expect(ownMinorRequirement('dev')).toBeNull();
  });
});
