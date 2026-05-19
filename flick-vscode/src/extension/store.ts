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

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HistoryEntry, SessionMeta } from '../shared/protocol';

export class Store {
  private readonly root: string;
  private readonly historyDir: string;
  private readonly screenshotsDir: string;
  private readonly sessionsFile: string;
  private readonly cdpStateFile: string;

  constructor(root: string) {
    this.root = root;
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
    await writeJson(this.sessionsFile, sessions);
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
    await writeJson(this.cdpStateFile, { lastLaunched: value });
  }

  // --- history/<guid>.json -------------------------------------------------

  async loadHistory(sessionId: string): Promise<HistoryEntry[]> {
    const raw = await readJson<HistoryEntry[]>(this.historyFile(sessionId));
    return Array.isArray(raw) ? raw : [];
  }

  async saveHistory(sessionId: string, entries: HistoryEntry[]): Promise<void> {
    await writeJson(this.historyFile(sessionId), entries);
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

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
