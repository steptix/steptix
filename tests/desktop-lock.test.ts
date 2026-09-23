/**
 * The one-computer-mode-session-per-machine lock
 * (docs/specs/SPEC-use-computer.md §5.9; acceptance §13 item 5: "The lock
 * refuses a second live holder and takes over a dead one").
 *
 * Every case runs against a lock file in a temp directory of its own, never
 * `os.tmpdir()/aiui-computer.lock`. That path is machine-global by design, and
 * a suite that wrote to it would fight the developer's own running server for
 * the mouse — the exact collision the lock exists to prevent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireComputerLock,
  computerLockInUseMessage,
  computerLockPath,
  isPidAlive,
  readComputerLock,
  releaseComputerLock,
} from '../src/desktop/lock.js';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aiui-lock-test-'));
  lockPath = path.join(dir, 'aiui-computer.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const alive = () => true;
const dead = () => false;

describe('acquireComputerLock — §5.9', () => {
  it('takes a free lock and records pid, session and the time', () => {
    const record = acquireComputerLock('sess-1', { lockPath, pid: 4242, isAlive: dead });
    expect(record).toMatchObject({ pid: 4242, sessionId: 'sess-1' });
    expect(Date.parse(record.since)).not.toBeNaN();
    expect(readComputerLock({ lockPath })).toMatchObject({ pid: 4242, sessionId: 'sess-1' });
  });

  it('refuses a second session while a LIVE pid holds it, in §5.9\'s words', () => {
    acquireComputerLock('sess-1', { lockPath, pid: 4242, isAlive: alive });
    expect(() =>
      acquireComputerLock('sess-2', { lockPath, pid: 9999, isAlive: alive }),
    ).toThrow('computer mode is in use by session sess-1 (pid 4242) — one computer-mode run per machine');
  });

  it('refuses a second SESSION in the same process, too', () => {
    // One server process runs many sessions. Sharing a pid with the holder is
    // not the same as being the holder — two sessions in one server would
    // fight over the mouse exactly as two servers would.
    acquireComputerLock('sess-1', { lockPath, pid: 4242, isAlive: alive });
    expect(() =>
      acquireComputerLock('sess-2', { lockPath, pid: 4242, isAlive: alive }),
    ).toThrow(/in use by session sess-1/);
  });

  it('takes over a lock whose pid is dead', () => {
    acquireComputerLock('sess-1', { lockPath, pid: 4242, isAlive: alive });
    const taken = acquireComputerLock('sess-2', { lockPath, pid: 9999, isAlive: dead });
    expect(taken).toMatchObject({ pid: 9999, sessionId: 'sess-2' });
    expect(readComputerLock({ lockPath })).toMatchObject({ sessionId: 'sess-2' });
  });

  it('is idempotent for the same pid AND session, keeping the original `since`', () => {
    // Sections and skills open with `[use computer]` defensively (§4.5), so
    // re-entry is the normal case, not the odd one. The record must still say
    // when the mouse was FIRST taken.
    const first = acquireComputerLock('sess-1', { lockPath, pid: 4242, isAlive: alive });
    const again = acquireComputerLock('sess-1', { lockPath, pid: 4242, isAlive: alive });
    expect(again).toEqual(first);
  });

  it('replaces a lock file that was truncated mid-write', () => {
    writeFileSync(lockPath, '{"pid": 42', 'utf8');
    const record = acquireComputerLock('sess-1', { lockPath, pid: 4242, isAlive: alive });
    expect(record.sessionId).toBe('sess-1');
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ sessionId: 'sess-1' });
  });
});

describe('releaseComputerLock — §5.9', () => {
  it('releases a lock this pid and session holds', () => {
    acquireComputerLock('sess-1', { lockPath, pid: 4242, isAlive: alive });
    expect(releaseComputerLock('sess-1', { lockPath, pid: 4242 })).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses to release someone else\'s', () => {
    // `[use browser]` and session close both call this. A session that never
    // got the lock — because another one held it and the step failed — must
    // not clear the holder's on its way out.
    acquireComputerLock('sess-1', { lockPath, pid: 4242, isAlive: alive });
    expect(releaseComputerLock('sess-2', { lockPath, pid: 4242 })).toBe(false);
    expect(releaseComputerLock('sess-1', { lockPath, pid: 9999 })).toBe(false);
    expect(readComputerLock({ lockPath })).toMatchObject({ sessionId: 'sess-1' });
  });

  it('is harmless when nothing is held', () => {
    expect(releaseComputerLock('sess-1', { lockPath, pid: 4242 })).toBe(false);
  });

  it('frees the lock for the next session', () => {
    acquireComputerLock('sess-1', { lockPath, pid: 4242, isAlive: alive });
    releaseComputerLock('sess-1', { lockPath, pid: 4242 });
    expect(
      acquireComputerLock('sess-2', { lockPath, pid: 9999, isAlive: alive }),
    ).toMatchObject({ sessionId: 'sess-2' });
  });
});

describe('isPidAlive', () => {
  it('says yes to this process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('says no to a pid that cannot exist', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});

describe('the default lock path', () => {
  it('is os.tmpdir()/aiui-computer.lock (§5.9)', () => {
    expect(computerLockPath()).toBe(path.join(os.tmpdir(), 'aiui-computer.lock'));
  });

  it('formats the in-use message from a record', () => {
    expect(computerLockInUseMessage({ pid: 7, sessionId: 'abc', since: '' })).toBe(
      'computer mode is in use by session abc (pid 7) — one computer-mode run per machine',
    );
  });
});
