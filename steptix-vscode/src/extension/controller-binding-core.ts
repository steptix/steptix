/**
 * Does a cached RunController still belong to the file it is being asked
 * about? (issue 50)
 *
 * The registry caches one controller per document URI, and a controller holds
 * a `TextDocument`. Two things can leave that pairing wrong while the URI
 * stays the same:
 *
 * - **The document was closed and opened again.** VS Code keeps a closed
 *   `TextDocument` readable with its last text and hands out a NEW object on
 *   the next open, so a controller that kept the old one ran frozen text and
 *   sent its line numbers. The file is the same file: the controller keeps
 *   everything it holds (a run in flight or parked at a breakpoint, its
 *   session, compile state) and just reads the new document — exactly as if
 *   the tab had never closed. That is a `rebind`.
 * - **A different file now lives at that path.** Rename `ABC2.md` away and
 *   `ABC1.md` onto its name, and `ABC2.md`'s controller would run ABC1's text
 *   inside the old ABC2's browser session — an interactive session is named
 *   after the file's path, so the old one is still open under exactly that
 *   name. The controller has to go, so the next run starts from a fresh one
 *   that closes that session first. That is a `replace`. A run parked at a
 *   breakpoint goes with it: its Continue would send the other file's steps
 *   into the paused session. A run still IN FLIGHT is the one exception — it
 *   keeps the document it started with, so the rest of it does not read the
 *   other file's steps (`keep`), and it is replaced once it ends.
 *
 * Telling the two apart needs the file's identity on disk, which a rename
 * keeps and a different file does not share: the inode on Linux and macOS,
 * the NTFS file id on Windows (Node reports both as `ino`). Edits keep it too,
 * since VS Code writes a file in place. A tool that saves by writing a new
 * file and renaming it over the old one gives it a new identity, and so does
 * a `git checkout` that rewrites it, or `steptix run` appending its "Latest
 * runs" line (APPEND_RUN_HISTORY_TO_TEST_FILE, history-appender.ts; runs from
 * the extension never append). The next run of that file then starts in a
 * fresh session, which is the right call for a file that changed under the
 * session anyway.
 *
 * Renames and deletes made THROUGH VS Code are handled before any of this by
 * the registry's file-operation listeners, which know exactly which file went
 * where. This is what catches the rest: the Windows Explorer, a terminal, git.
 */
import * as fs from 'node:fs';

/** A file's identity on disk: device and inode / file id. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * The identity of the file at `fsPath`, or null when it cannot be known: no
 * file there, a stat that fails, or a filesystem that reports no inode (`0`,
 * as some network shares do). Unknown is never read as "a different file".
 *
 * BigInt on purpose: an NTFS file id is 64 bits wide, and a `number` loses
 * the low bits of one past 2^53 — two files could then compare equal.
 */
export function readFileIdentity(fsPath: string): FileIdentity | null {
  try {
    const stat = fs.statSync(fsPath, { bigint: true, throwIfNoEntry: false });
    if (!stat || stat.ino === 0n) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/** True only when both identities are known and name different files. */
export function isDifferentFile(
  recorded: FileIdentity | null,
  current: FileIdentity | null,
): boolean {
  if (recorded === null || current === null) return false;
  return recorded.dev !== current.dev || recorded.ino !== current.ino;
}

export type Binding = 'keep' | 'rebind' | 'replace';

/**
 * What to do with a cached controller asked about `document`.
 *
 * - `replace` — a different file is at the path. The controller goes, and a
 *   run parked at a breakpoint goes with it: Continue would otherwise send
 *   the other file's steps into the paused session.
 * - `keep` — nothing changed; or a different file is at the path while a run
 *   or a recording is IN FLIGHT. Dropping that controller would orphan the
 *   run with nothing left to stop it, and pointing it at the other file
 *   would hand the rest of the run (a later row's or block's steps, the text
 *   its failures quote) to a different test. So it keeps the document it
 *   started with, and the caller asks again once it has ended — leaving the
 *   recorded identity as it was, for exactly that.
 * - `rebind` — the same file in a new document object.
 *
 * `replaceable` is false for the Test Explorer's batch controllers, which are
 * rebound rather than replaced when a different file is at their path. Each
 * batch run is already a fresh server session (`<path>::run-N`), so a
 * different file inherits nothing from one — while the controller's run
 * counter is what keeps those ids distinct across runs of one path
 * (issue 032), and a new controller would start counting from 1 again.
 */
export function bindingFor(input: {
  /** Is the controller's document the very object being asked about? */
  sameDocument: boolean;
  /** The file identity recorded for the controller's document. */
  recorded: FileIdentity | null;
  /** The identity of the file at the path now. */
  current: FileIdentity | null;
  /** A run or a recording in flight. A run parked at a breakpoint is not:
   *  nothing of it is executing. */
  inFlight: boolean;
  replaceable: boolean;
}): Binding {
  if (isDifferentFile(input.recorded, input.current)) {
    if (input.inFlight) return 'keep';
    return input.replaceable ? 'replace' : 'rebind';
  }
  return input.sameDocument ? 'keep' : 'rebind';
}

/** What a controller's file was last checked against: the identity it had,
 *  and the document and version that check was made for. */
export interface FileCheck<D> {
  identity: FileIdentity | null;
  document: D;
  version: number;
}

/**
 * Can the identity check be skipped? Yes when the controller already holds
 * this very document, at the version it had when last checked.
 *
 * The check is a `stat`, and the registry is asked for the active file's
 * controller on every editor switch, context refresh and command. Nothing it
 * decides can have changed meanwhile: a file reopened is a new document
 * object, and a file replaced while it is open is reloaded into the same one,
 * which bumps its version — unless the new file's text is identical, which
 * is the one case where carrying on as before is right anyway.
 */
export function isCheckCurrent<D extends { version: number }>(
  check: FileCheck<D> | undefined,
  held: D,
  document: D,
): boolean {
  return (
    check !== undefined &&
    held === document &&
    check.document === document &&
    check.version === document.version
  );
}

/**
 * Is `key` the resource `target` names, or inside it? Both are
 * `Uri.toString()` forms; a folder rename or delete reaches every file under
 * it, and `/` is the separator in every URI whatever the platform.
 */
export function isSameOrInside(key: string, target: string): boolean {
  if (key === target) return true;
  const folder = target.endsWith('/') ? target : `${target}/`;
  return key.startsWith(folder);
}
