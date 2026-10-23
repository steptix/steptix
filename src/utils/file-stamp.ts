/**
 * Which Steptix version wrote a file (docs/specs/SPEC-install.md §4.13).
 *
 * Two versions can work on the same project: VS Code's server and a
 * `steptix run` in a terminal whose major.minor differs. So every file
 * Steptix writes in a project to read back later records the version that
 * wrote it, and a reader of another major.minor knows what it is holding:
 *
 * - **the same or an older major.minor:** read as always, since newer
 *   versions keep reading what older ones wrote;
 * - **a newer major.minor:** ignored, never rewritten on its own, and said so.
 *
 * Patches never change these files' format (§4.2), so only major.minor is
 * compared. A file with no stamp was written before stamps existed, which
 * makes it older.
 *
 * JSON files carry the version in a {@link STAMP_FIELD} field; a compiled
 * steps file carries it in a comment line (src/codebehind/stamp.ts).
 */

import { getPackageVersion } from './version.js';

/** The field a JSON file Steptix writes in a project carries its version in. */
export const STAMP_FIELD = 'steptixVersion';

/** `[major, minor]` of a version such as `1.5.2` or `1.5.0-beta.1`, or null. */
function majorMinor(version: string): [number, number] | null {
  const m = /^\s*(\d+)\.(\d+)(?:[.\-+]|$)/.exec(version);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** `1.5.2` → `1.5`, the way the messages name a version. */
export function majorMinorLabel(version: string): string {
  const mm = majorMinor(version);
  return mm ? `${mm[0]}.${mm[1]}` : version;
}

/**
 * True when `stamped` is a newer major.minor than `own`, this build's version
 * unless a test says otherwise. False for a missing or unreadable stamp, and
 * when this build's own version is unknown: with nothing to compare, the file
 * is read as it always was.
 */
export function writtenByNewer(stamped: unknown, own: string = getPackageVersion()): boolean {
  if (typeof stamped !== 'string') return false;
  const theirs = majorMinor(stamped);
  const ours = majorMinor(own);
  if (!theirs || !ours) return false;
  return theirs[0] > ours[0] || (theirs[0] === ours[0] && theirs[1] > ours[1]);
}

/** The version a JSON file Steptix wrote says it was written by, if any. */
export function stampOf(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value = (parsed as Record<string, unknown>)[STAMP_FIELD];
  return typeof value === 'string' ? value : undefined;
}

/** What a reader says when it leaves a newer version's file alone. */
export function leftAloneMessage(file: string, stamped: string, own: string = getPackageVersion()): string {
  return (
    `${file} was written by Steptix ${majorMinorLabel(stamped)}, newer than this ${majorMinorLabel(own)}, ` +
    'so this version does not use or rewrite it.'
  );
}
