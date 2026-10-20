/**
 * The record a Steptix client leaves in the user root so the launcher's
 * clean-up keeps a server it needs (docs/specs/SPEC-install.md §4.3 in the
 * Steptix repo).
 *
 * A deliberate duplicate of `writeClientRecord` in the framework's
 * `src/launcher/runtimes.ts`, for the reason given in `user-root.ts`: runner-core
 * cannot import from the framework. `tests/client-record-parity.test.ts` in the
 * framework holds the two to one format.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { userRootDir, type UserRootDeps } from './user-root.js';

export interface ClientRecord {
  /** `vscode` for the VS Code extension, `launcher` for a `steptix` command. */
  kind: string;
  version: string;
  /** The server it needs: this major.minor, at least this patch. */
  requires: string;
  /** Where the client is installed. The clean-up drops a record whose location has gone. */
  location: string;
}

/** `<major>.<minor>.0` for a client that needs no particular server patch. */
export function ownMinorRequirement(version: string): string | null {
  const m = /^(\d+)\.(\d+)\.\d+/.exec(version);
  return m ? `${m[1]}.${m[2]}.0` : null;
}

/** `<user root>/clients/<kind>-<id>.json`, one per place a client is installed. */
export function clientRecordPath(record: Pick<ClientRecord, 'kind' | 'location'>, deps?: UserRootDeps): string {
  const platform = deps?.platform ?? process.platform;
  const resolved = path.resolve(record.location);
  const key = platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
  const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(userRootDir(deps), 'clients', `${record.kind}-${id}.json`);
}

/** Write the record, leaving the file alone when nothing in it changed. */
export function writeClientRecord(record: ClientRecord, deps?: UserRootDeps): void {
  const file = clientRecordPath(record, deps);
  const content = JSON.stringify(record, null, 2) + '\n';
  try {
    if (fs.readFileSync(file, 'utf-8') === content) return;
  } catch {
    // Not written yet.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
