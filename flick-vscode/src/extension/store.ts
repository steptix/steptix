// Local persistence for Flick, mirroring SPEC-FLICK.md "Local Persistence".
//
// Adapted for the extension context: instead of an OS app-data directory, all
// files live under the extension's globalStorageUri:
//
//   <globalStorage>/sessions.json        — SessionMeta[]
//   <globalStorage>/cdp-state.json       — { lastLaunched: 'chrome' | 'edge' | null }
//   <globalStorage>/history/<guid>.json  — HistoryEntry[]
//   <globalStorage>/screenshots/<guid>/  — decoded PNG files
//
// Settings are NOT stored here — they come from VS Code's configuration
// (workspace/user settings), which is the idiomatic equivalent of settings.json.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HistoryEntry, SessionMeta } from '../shared/protocol';

/** The two filesystem calls a JSON save makes. Injectable so a test can hold
 *  one save part-way and see what a second save of the same file does. */
export interface StoreFileOps {
  writeFile(file: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const realFileOps: StoreFileOps = {
  writeFile: (file, text) => fs.writeFile(file, text, 'utf8'),
  rename: (from, to) => fs.rename(from, to),
};

export class Store {
  private readonly root: string;
  private readonly historyDir: string;
  private readonly screenshotsDir: string;
  private readonly sessionsFile: string;
  private readonly cdpStateFile: string;
  private readonly fileOps: StoreFileOps;

  constructor(root: string, fileOps: StoreFileOps = realFileOps) {
    this.root = root;
    this.fileOps = fileOps;
    this.historyDir = path.join(root, 'history');
    this.screenshotsDir = path.join(root, 'screenshots');
    this.sessionsFile = path.join(root, 'sessions.json');
    // Kept as a separate tiny file rather than co-mingled with sessions.json:
    // sessions.json is a SessionMeta[] today (no envelope) and bolting a sibling
    // key on would change its shape, breaking the round-trip Store.loadSessions
    // assumes. A dedicated cdp-state.json mirrors how sessions/history already
    // each own their own file — same pattern, no migration.
    this.cdpStateFile = path.join(root, 'cdp-state.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.historyDir, { recursive: true });
    await fs.mkdir(this.screenshotsDir, { recursive: true });
  }

  /** Directory the store writes into; used by the controller as a fallback
   *  base for CDP profile dirs when no workspace folder is open. */
  get baseDir(): string {
    return this.root;
  }

  // --- sessions.json -------------------------------------------------------

  async loadSessions(): Promise<SessionMeta[]> {
    const raw = await readJson<SessionMeta[]>(this.sessionsFile);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s) => s && typeof s.id === 'string')
      .sort((a, b) => a.order - b.order);
  }

  async saveSessions(sessions: SessionMeta[]): Promise<void> {
    await writeJson(this.sessionsFile, sessions, this.fileOps);
  }

  // --- cdp-state.json ------------------------------------------------------

  /** Returns the last-launched CDP engine, or null on first run / corrupt
   *  state. Drives which "Launch with CDP" button appears first in the
   *  dropdown when both Chrome and Edge are installed. */
  async loadCdpLastLaunched(): Promise<'chrome' | 'edge' | null> {
    const raw = await readJson<{ lastLaunched?: unknown }>(this.cdpStateFile);
    const v = raw?.lastLaunched;
    return v === 'chrome' || v === 'edge' ? v : null;
  }

  async saveCdpLastLaunched(value: 'chrome' | 'edge' | null): Promise<void> {
    await writeJson(this.cdpStateFile, { lastLaunched: value }, this.fileOps);
  }

  // --- history/<guid>.json -------------------------------------------------

  async loadHistory(sessionId: string): Promise<HistoryEntry[]> {
    const raw = await readJson<HistoryEntry[]>(this.historyFile(sessionId));
    return Array.isArray(raw) ? raw : [];
  }

  async saveHistory(sessionId: string, entries: HistoryEntry[]): Promise<void> {
    await writeJson(this.historyFile(sessionId), entries, this.fileOps);
  }

  // --- screenshots ---------------------------------------------------------

  /**
   * Decodes a base64 data-URI screenshot and writes it under
   * screenshots/<guid>/<timestamp>_<stepIndex>.png. Returns the absolute path,
   * or null if the input was empty/unparseable.
   */
  async saveScreenshot(
    sessionId: string,
    stepIndex: number,
    dataUri: string | null,
  ): Promise<string | null> {
    if (!dataUri) return null;
    const base64 = dataUri.includes(',') ? dataUri.slice(dataUri.indexOf(',') + 1) : dataUri;
    if (!base64.trim()) return null;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      return null;
    }
    if (buffer.length === 0) return null;
    const dir = path.join(this.screenshotsDir, sanitize(sessionId));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}_${stepIndex}.png`);
    await fs.writeFile(file, buffer);
    return file;
  }

  // --- deletion ------------------------------------------------------------

  /** Removes the history file and screenshot directory for a deleted session. */
  async deleteSessionData(sessionId: string): Promise<void> {
    await fs.rm(this.historyFile(sessionId), { force: true });
    await fs.rm(path.join(this.screenshotsDir, sanitize(sessionId)), {
      recursive: true,
      force: true,
    });
  }

  /** Root that must be added to the webview's localResourceRoots. */
  get screenshotsRoot(): string {
    return this.screenshotsDir;
  }

  private historyFile(sessionId: string): string {
    return path.join(this.historyDir, `${sanitize(sessionId)}.json`);
  }
}

function sanitize(id: string): string {
  // Session IDs are GUIDs in normal use, but guard against path traversal anyway.
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The save each target file is waiting on, if any; see writeJson. */
const pendingWrites = new Map<string, Promise<void>>();

/**
 * Replace `file` whole with `value` as JSON, so a reader never sees half of it.
 *
 * Saves of one file are applied in the order they were made: each waits for
 * the previous save of that file to finish, so a slow older save (its rename
 * retrying, below) can never land on top of a newer one. A failed save does
 * not hold up the next. `value` is serialised now, not when the save's turn
 * comes, so a caller can go on changing it.
 */
function writeJson(file: string, value: unknown, fileOps: StoreFileOps): Promise<void> {
  const key = path.resolve(file);
  const text = JSON.stringify(value, null, 2);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const write = previous.then(() => replaceFile(file, text, fileOps));
  const settled = write.then(
    () => undefined,
    () => undefined,
  );
  pendingWrites.set(key, settled);
  void settled.then(() => {
    if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
  });
  return write;
}

/**
 * Write `text` to a temp file beside `file`, then rename it over `file`.
 *
 * The temp name is unique per write, so no two saves ever share one. Windows
 * refuses a rename onto a file that something else has open — an antivirus
 * scan of the file just written, typically — with EPERM or EBUSY for a
 * moment, so the rename is retried for about two seconds before the error is
 * let through.
 */
async function replaceFile(file: string, text: string, fileOps: StoreFileOps): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fileOps.writeFile(tmp, text);
    await renameRetrying(tmp, file, fileOps);
  } catch (err) {
    // Best effort: the save's own error is the one worth reporting.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

const RENAME_REFUSALS = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameRetrying(from: string, to: string, fileOps: StoreFileOps): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fileOps.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 20 || !RENAME_REFUSALS.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
