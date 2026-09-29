/**
 * Where the scoreboard's lines live, and how they are written, read and aged
 * out (docs/specs/SPEC-scoreboard.md §6).
 *
 * `<user root>/stats/actions-YYYY-MM.jsonl`, one file per UTC month, beside
 * the machine-wide `.env` (src/env/user-root.ts): per OS user, and never sent
 * anywhere.
 *
 * Append-only JSON Lines, with no lock. Several processes write at once —
 * Steptix's server, a CLI run, four live-suite servers — and that is safe
 * because each line is ONE append of one short, complete line, which appends
 * do not interleave. A reader that still meets a line that does not parse (a
 * crash mid-write), or one that is not the shape §5 describes, skips it and
 * counts it.
 *
 * Every line starts `{"v":1,"kind":"…","t":"…"` ({@link formatStatsLine}
 * puts those three first), so the reader can tell from that prefix alone
 * whether a window needs a line, and parses only the lines it keeps. The
 * files are streamed, never loaded whole.
 *
 * Writing never fails a run: it is not awaited on the step's path, it never
 * throws, and whatever goes wrong is logged once per process at debug.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseBoolEnv } from '../env/loader.js';
import { readUserRootEnv, userRootDir, type UserRootDeps } from '../env/user-root.js';
import { logger } from '../utils/logger.js';
import type { StatsLine, StatsSuite } from './types.js';

/** The longest line written, newline included (§6.2). */
export const MAX_LINE_BYTES = 4096;
/** Where `stepText` and `selector` are cut (§6.2). */
export const MAX_TEXT_CHARS = 500;
/** Months kept when the machine `.env` has no usable `STEPTIX_STATS_RETAIN_MONTHS` (§6.3). */
export const DEFAULT_RETAIN_MONTHS = 6;

const MONTH_FILE = /^actions-(\d{4})-(\d{2})\.jsonl$/;

/** `<user root>/stats`. */
export function statsDir(deps?: UserRootDeps): string {
  return path.join(userRootDir(deps), 'stats');
}

/** The month file a line dated `date` belongs in — the UTC month, so every
 *  machine and every process agrees where midnight on the 1st falls. */
export function monthFileFor(date: Date, deps?: UserRootDeps): string {
  const at = Number.isNaN(date.getTime()) ? new Date() : date;
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return path.join(statsDir(deps), `actions-${at.getUTCFullYear()}-${month}.jsonl`);
}

// ── Errors, once ─────────────────────────────────────────────────────────────

const logged = new Set<string>();

/**
 * One debug line per kind of failure per process (§6.2), `what` naming the
 * kind ("could not write a line"). A broken stats folder fails every append
 * the same way, and a line per step would bury the run's own log. Guarded
 * itself, because the logger writes to the console and this must not be the
 * thing that throws.
 */
export function logStatsErrorOnce(what: string, err: unknown): void {
  if (logged.has(what)) return;
  logged.add(what);
  const message = err instanceof Error ? err.message : String(err);
  try {
    logger.debug(`stats: ${what}: ${message} (logged once per process)`);
  } catch {
    /* nothing left to tell */
  }
}

const WRITE_FAILED = 'could not write a line';
const PRUNE_FAILED = 'could not prune old month files';

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Optional fields a line gives up, in this order, when it is still over
 * {@link MAX_LINE_BYTES} after the cut. `stepText` first because it is the one
 * that makes a line big, and nothing is counted by it; the rest are small and
 * go only if that was not enough. Grouping fields a reader counts by (`form`,
 * `outcome`, `row`, the flags) are never dropped.
 */
const DROPPABLE = ['stepText', 'site', 'model', 'fw', 'prompt', 'matchCount'] as const;

/** `value` cut to `max` characters — code points, so a cut never splits a
 *  surrogate pair into a character that was never on the page. */
function cutChars(value: string, max: number): string {
  if (value.length <= max) return value;
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

function fits(json: string): boolean {
  return Buffer.byteLength(json, 'utf8') + 1 <= MAX_LINE_BYTES;
}

/**
 * The line as it is written — one JSON object and a newline, at most
 * {@link MAX_LINE_BYTES} — or `null` when it cannot be made to fit.
 *
 * `v`, `kind` and `t` come first, in that order, whatever order the object was
 * built in: {@link readStatsLines} decides from that prefix whether a window
 * needs the line before it parses it.
 *
 * `stepText` and `selector` are cut to {@link MAX_TEXT_CHARS} with `truncated:
 * true`. The recorder masks before this runs, so a secret straddling the cut
 * was already `***` and cannot leave half of itself behind. A line still too
 * big gives up {@link DROPPABLE} fields rather than be written oversized; one
 * that does not fit even then is not written at all.
 */
export function formatStatsLine(line: StatsLine): string | null {
  const { v, kind, t, ...rest } = line;
  const out: Record<string, unknown> = { v, kind, t, ...rest };
  let truncated = false;
  for (const key of ['stepText', 'selector'] as const) {
    const value = out[key];
    if (typeof value !== 'string') continue;
    const cut = cutChars(value, MAX_TEXT_CHARS);
    if (cut !== value) {
      out[key] = cut;
      truncated = true;
    }
  }
  if (truncated) out['truncated'] = true;

  let json = JSON.stringify(out);
  for (const key of DROPPABLE) {
    if (fits(json)) break;
    if (!(key in out)) continue;
    delete out[key];
    out['truncated'] = true;
    json = JSON.stringify(out);
  }
  return fits(json) ? `${json}\n` : null;
}

/** Where a line goes: the month of its own `t`, so a step that straddles
 *  midnight on the 1st files each line where a reader filtering by `t` will
 *  look for it. */
function lineDate(line: StatsLine): Date {
  const time = Date.parse(line.t);
  return Number.isNaN(time) ? new Date() : new Date(time);
}

/**
 * This process's writes, in order. Chaining keeps a step's lines in the order
 * they were made (its actions, then the step), keeps one file handle open at a
 * time however fast a run records, and gives {@link flushStatsWrites}
 * something to wait on. Every link catches its own errors, so the chain never
 * rejects.
 */
let queue: Promise<void> = Promise.resolve();

/**
 * Append `lines` to their month files. Fire-and-forget: returns at once,
 * never throws, never rejects — the step that produced the lines has already
 * moved on (§6.2).
 *
 * One append per line, the stats folder created on first use, and each line
 * kept under 4 KB by {@link formatStatsLine}.
 */
export function appendStatsLines(lines: readonly StatsLine[], deps?: UserRootDeps): void {
  try {
    const writes: Array<{ file: string; text: string }> = [];
    for (const line of lines) {
      const text = formatStatsLine(line);
      if (text === null) {
        logStatsErrorOnce(
          'dropped a line',
          `a ${line.kind} line of run ${line.run} does not fit in ${MAX_LINE_BYTES} bytes`,
        );
        continue;
      }
      writes.push({ file: monthFileFor(lineDate(line), deps), text });
    }
    if (writes.length === 0) return;
    queue = queue
      .then(async () => {
        for (const write of writes) await appendOne(write.file, write.text);
      })
      .catch((err: unknown) => logStatsErrorOnce(WRITE_FAILED, err));
  } catch (err) {
    logStatsErrorOnce(WRITE_FAILED, err);
  }
}

async function appendOne(file: string, text: string): Promise<void> {
  try {
    await fs.promises.appendFile(file, text, 'utf-8');
    return;
  } catch (err) {
    if (!isMissing(err)) {
      logStatsErrorOnce(WRITE_FAILED, err);
      return;
    }
  }
  // The folder is missing: the first line on this machine, or someone
  // deleted it while the server ran. Create it and try once more.
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, text, 'utf-8');
  } catch (err) {
    logStatsErrorOnce(WRITE_FAILED, err);
  }
}

/**
 * Resolves once every append queued so far has finished (or failed and been
 * logged). Never rejects. For tests, and for a CLI that is about to exit —
 * an unawaited append dies with the process.
 */
export function flushStatsWrites(): Promise<void> {
  return queue;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface StatsReadResult {
  /** Oldest month first, each file in the order it was written. */
  lines: StatsLine[];
  /** Lines the window needed that could not be used: they did not parse, or
   *  are not a `v: 1` line of a known `kind` with the fields §5 requires. */
  skipped: number;
}

/** What one field of a line must be. */
type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === 'string';
const isText: Check = (value) => typeof value === 'string' && value !== '';
const isTextOrNull: Check = (value) => value === null || typeof value === 'string';
const isTrue: Check = (value) => value === true;
const isBoolean: Check = (value) => typeof value === 'boolean';
/** A count or a duration: a finite number, not negative. */
const isAmount: Check = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
/** A number that names something (a step, a row, a place in a hook scope, an
 *  execution): a whole number, not negative. */
const isIndex: Check = (value) => Number.isInteger(value) && (value as number) >= 0;
/** An attempt or a turn, both counted from 1 (§5.1). */
const isOrdinal: Check = (value) => Number.isInteger(value) && (value as number) >= 1;
/** An optional field: absent, or what `check` wants. */
function optional(value: unknown, check: Check): boolean {
  return value === undefined || check(value);
}

/*
 * §5's fields, per kind: the ones every line of the kind carries, and the
 * optional ones, checked only when present. Fields not named here are let
 * through unchecked — a newer writer may add one, and nothing here reads it.
 *
 * Suites, sources and outcomes are checked as words, not against today's
 * lists: a line from a newer framework with a new outcome is still a failure
 * worth counting, and one with a new suite is simply left out by the default
 * view rather than thrown away.
 *
 * Written out rather than looped over a table: the reader checks every line it
 * keeps, and named property reads are several times cheaper than looked-up
 * ones at a few hundred thousand lines.
 */

/** What an action line and a step line share (§5.1, §5.2). */
function hasStepFields(line: Record<string, unknown>): boolean {
  return (
    isText(line['run'])
    && isString(line['project'])
    && isTextOrNull(line['test'])
    && isIndex(line['step'])
    && isText(line['suite'])
    && isText(line['source'])
    && optional(line['row'], isIndex)
    && optional(line['hook'], isText)
    && optional(line['hookIndex'], isIndex)
    && optional(line['stepText'], isString)
    && optional(line['prompt'], isTextOrNull)
    && optional(line['fw'], isString)
    && optional(line['truncated'], isTrue)
    && optional(line['imported'], isTrue)
    // The writer's newer fields (§5.1, §5.2, §8.3).
    && optional(line['exec'], isIndex)
    && optional(line['card'], isBoolean)
    && optional(line['site'], isString)
    && optional(line['model'], isString)
  );
}

function isActionLine(line: Record<string, unknown>): boolean {
  return (
    hasStepFields(line)
    && isOrdinal(line['attempt'])
    && isOrdinal(line['turn'])
    && isString(line['action'])
    && isTextOrNull(line['selector'])
    && isTextOrNull(line['form'])
    && isText(line['outcome'])
    && isAmount(line['ms'])
    && optional(line['matchCount'], isAmount)
  );
}

function isStepLine(line: Record<string, unknown>): boolean {
  return (
    hasStepFields(line)
    && isText(line['status'])
    && isAmount(line['attempts'])
    && isAmount(line['turns'])
    && isBoolean(line['firstTry'])
    && isAmount(line['ms'])
    && isAmount(line['calls'])
    && isAmount(line['tokensIn'])
    && isAmount(line['tokensOut'])
    && optional(line['tolerated'], isTrue)
    && optional(line['interrupted'], isTrue)
    && optional(line['tokensCached'], isAmount)
    && optional(line['tokensEstimated'], isTrue)
  );
}

function isRunLine(line: Record<string, unknown>): boolean {
  return (
    isText(line['run'])
    && isString(line['project'])
    && isTextOrNull(line['test'])
    && isText(line['suite'])
    && isText(line['status'])
    && isAmount(line['steps'])
    && isAmount(line['firstTry'])
    && isAmount(line['failed'])
    && isTextOrNull(line['report'])
    && optional(line['aborted'], isTrue)
    && optional(line['tokensIn'], isAmount)
    && optional(line['tokensOut'], isAmount)
    && optional(line['imported'], isTrue)
  );
}

/**
 * A line this reader can vouch for, or `null`. A `v` other than 1 is a line
 * from a newer framework, whose shape this one cannot vouch for.
 *
 * `t` is the line's time when the caller already read it from the prefix, so
 * it is not parsed twice.
 */
function parseLine(text: string, t?: number): StatsLine | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const line = value as Record<string, unknown>;
  if (line['v'] !== 1) return null;
  if (typeof line['t'] !== 'string' || (t === undefined && Number.isNaN(Date.parse(line['t'])))) return null;
  const kind = line['kind'];
  const ok = kind === 'action' ? isActionLine(line) : kind === 'step' ? isStepLine(line) : kind === 'run' && isRunLine(line);
  return ok ? (value as StatsLine) : null;
}

/**
 * The start of a line as {@link formatStatsLine} writes it: enough to know the
 * kind and time without parsing the rest. A line that does not start this way
 * (edited by hand, written in another key order) is simply parsed.
 */
const PREFIX = /^\{"v":1,"kind":"(action|step|run)","t":"([^"\\]*)"/;

/** Bytes read from a month file at a time. */
const CHUNK_BYTES = 1 << 20;

/**
 * Calls `onLine` with each line of `file`, without its newline, holding one
 * chunk of the file at a time rather than the whole of it. A byte-order mark
 * at the start is dropped (an editor adds one on save; nothing here writes
 * one). Rejects when the file cannot be read.
 */
async function eachLine(file: string, onLine: (text: string) => void): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: 'utf-8', highWaterMark: CHUNK_BYTES });
  let carry = '';
  let first = true;
  for await (const piece of stream as AsyncIterable<string>) {
    let chunk = piece;
    if (first) {
      first = false;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    let end = chunk.indexOf('\n');
    if (end === -1) {
      carry += chunk;
      continue;
    }
    onLine(carry + chunk.slice(0, end));
    let start = end + 1;
    while ((end = chunk.indexOf('\n', start)) !== -1) {
      onLine(chunk.slice(start, end));
      start = end + 1;
    }
    carry = chunk.slice(start);
  }
  if (carry !== '') onLine(carry);
}

/** One month file's name, and the span of time it covers (UTC). */
export interface StatsMonthFile {
  name: string;
  /** `2026-09`. */
  month: string;
  /** Its first instant, and the first instant after it, in ms. */
  start: number;
  end: number;
}

/** The month files among `names`, oldest first. */
function monthFilesIn(names: readonly string[]): StatsMonthFile[] {
  const out: StatsMonthFile[] = [];
  for (const name of names) {
    const match = MONTH_FILE.exec(name);
    if (!match) continue;
    const [year, month] = [Number(match[1]), Number(match[2])];
    if (month < 1 || month > 12) continue;
    out.push({ name, month: `${match[1]}-${match[2]}`, start: Date.UTC(year, month - 1, 1), end: Date.UTC(year, month, 1) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The month files in the stats folder, oldest first; none when the folder is
 * missing. Throws when it exists and cannot be listed.
 */
export async function listStatsMonths(deps?: UserRootDeps): Promise<StatsMonthFile[]> {
  try {
    return monthFilesIn(await fs.promises.readdir(statsDir(deps)));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/**
 * The action and step lines with `since <= t <= until`, and the run lines
 * with `since <= t` (either bound optional).
 *
 * `until` does not bound the run lines: a run's line is written when the run
 * ends, which can be after any window, and it is what a line in the window
 * links to its report through (§8.2). So `until` narrows the lines kept, not
 * the months read — every month file from the one holding `since` on is
 * streamed, and a line the window does not need is recognised from its prefix
 * and never parsed.
 *
 * A missing stats folder is no lines, not an error, and so is a month file
 * pruned between the listing and the read. Throws only when the folder or a
 * file in it exists and cannot be read — `steptix stats` should say so rather
 * than report an empty month.
 */
export async function readStatsLines(
  opts: { since?: Date | undefined; until?: Date | undefined; deps?: UserRootDeps | undefined } = {},
): Promise<StatsReadResult> {
  const since = opts.since?.getTime();
  const until = opts.until?.getTime();
  const dir = statsDir(opts.deps);
  const months = (await listStatsMonths(opts.deps)).filter((month) => since === undefined || month.end > since);

  const wanted = (kind: string, t: number): boolean =>
    (since === undefined || t >= since) && (kind === 'run' || until === undefined || t <= until);

  const lines: StatsLine[] = [];
  let skipped = 0;
  const onLine = (text: string): void => {
    const prefix = PREFIX.exec(text);
    let t: number | undefined;
    if (prefix !== null) {
      const at = Date.parse(prefix[2]!);
      if (!Number.isNaN(at)) {
        // Not needed: not parsed, not checked, not counted.
        if (!wanted(prefix[1]!, at)) return;
        t = at;
      }
    } else if (text.trim() === '') {
      return;
    }
    const line = parseLine(text, t);
    if (line === null) {
      skipped++;
      return;
    }
    if (t !== undefined || wanted(line.kind, Date.parse(line.t))) lines.push(line);
  };

  for (const month of months) {
    try {
      await eachLine(path.join(dir, month.name), onLine);
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }
  }
  return { lines, skipped };
}

// ── Retention ────────────────────────────────────────────────────────────────

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/**
 * Delete the month files older than `retainMonths` (§6.3) and return their
 * paths. Never throws.
 *
 * A file goes when even its newest possible line is older than the window:
 * with 6 in September, March stays (its last days are under six months old)
 * and February goes. So the current month and the `retainMonths` before it
 * are kept, and nothing younger than the window is ever deleted.
 *
 * `keepFrom` is for `steptix stats`, which prunes after it reads: no month that
 * ends after `keepFrom` — the start of the window it was asked for — is
 * deleted, however old. Asking about January must not be what deletes
 * January, and the months after it hold the run lines its lines link through.
 *
 * Only `actions-YYYY-MM.jsonl` names are touched. A `retainMonths` that is not
 * a whole number of at least 1, or a `now` that is not a date, deletes
 * nothing: a bad argument must not be able to empty the folder.
 */
export async function pruneStatsFiles(opts: {
  retainMonths: number;
  now?: Date | undefined;
  deps?: UserRootDeps | undefined;
  keepFrom?: Date | undefined;
}): Promise<string[]> {
  const deleted: string[] = [];
  const now = opts.now ?? new Date();
  if (!Number.isInteger(opts.retainMonths) || opts.retainMonths < 1) return deleted;
  // An invalid date compares false with everything, which would read as
  // "every month is older than the window".
  if (Number.isNaN(now.getTime())) return deleted;
  const keepFrom = opts.keepFrom?.getTime();
  if (keepFrom !== undefined && Number.isNaN(keepFrom)) return deleted;
  const oldestKept = monthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1) - opts.retainMonths;
  try {
    const dir = statsDir(opts.deps);
    for (const name of await fs.promises.readdir(dir)) {
      const month = MONTH_FILE.exec(name);
      if (!month || monthIndex(Number(month[1]), Number(month[2])) >= oldestKept) continue;
      if (keepFrom !== undefined && Date.UTC(Number(month[1]), Number(month[2]), 1) > keepFrom) continue;
      const file = path.join(dir, name);
      try {
        await fs.promises.unlink(file);
        deleted.push(file);
      } catch (err) {
        // ENOENT: another process pruned it first.
        if (!isMissing(err)) logStatsErrorOnce(PRUNE_FAILED, err);
      }
    }
  } catch (err) {
    if (!isMissing(err)) logStatsErrorOnce(PRUNE_FAILED, err);
  }
  return deleted;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface StatsSettings {
  /** Whether this run records at all (§6.4). */
  enabled: boolean;
  /** Who is running (§5.6): `STEPTIX_STATS_SUITE`, else `user`. */
  suite: StatsSuite;
  /** Months of files to keep (§6.3). */
  retainMonths: number;
}

const SUITES: ReadonlySet<string> = new Set<StatsSuite>(['user', 'live', 'bench', 'compile']);

function retainFrom(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*\d+\s*$/.test(value)) return undefined;
  const months = Number(value.trim());
  return months >= 1 ? months : undefined;
}

/** The user root's `.env`, `{}` when it cannot be read — a settings lookup
 *  on the run's path must not be what fails it. */
function machineEnv(deps?: UserRootDeps): Record<string, string> {
  try {
    return readUserRootEnv(deps);
  } catch (err) {
    logStatsErrorOnce('could not read the machine .env', err);
    return {};
  }
}

/**
 * Whether to record, under which suite, and how long to keep the files.
 *
 * - **Off** (§6.4) when `STEPTIX_STATS` is off in the environment OR in the
 *   machine `.env` — either one turns off the whole machine, so a value set in
 *   one place cannot quietly be undone by the other — or when the project's
 *   `stats.enabled` is `false`. "Off" is whatever `parseBoolEnv` reads as
 *   false (`off`, `0`, `false`, `no`, any case), the one rule every boolean
 *   variable here follows. Pass `env: {}` to ask about the machine alone.
 * - **Suite** from `STEPTIX_STATS_SUITE` in the environment only. It says who is
 *   running THIS process — `runLiveTest.cjs` sets it on each server it starts
 *   — so a machine-wide value would tag every run on the machine and hide the
 *   user's own from the default view. Anything unknown is `user`.
 * - **Retention** (§6.3) from `STEPTIX_STATS_RETAIN_MONTHS` in the machine `.env`
 *   only, else 6. Never from the environment: the server prunes at start and
 *   every `steptix stats` prunes too, each in its own environment, and a CLI run
 *   from a shell that says 1 must not delete months the machine was told to
 *   keep. The machine file is the one place they all read. A value that is
 *   not a whole number of at least 1 is ignored.
 *
 * `env` defaults to `deps.env`, then `process.env`, so a test that points the
 * user root at a temp folder is also isolated from the real environment.
 */
export function statsSettings(
  opts: {
    env?: NodeJS.ProcessEnv | undefined;
    projectEnabled?: boolean | undefined;
    deps?: UserRootDeps | undefined;
  } = {},
): StatsSettings {
  const env = opts.env ?? opts.deps?.env ?? process.env;
  const machine = machineEnv(opts.deps);

  const enabled =
    parseBoolEnv(env['STEPTIX_STATS']) !== false
    && parseBoolEnv(machine['STEPTIX_STATS']) !== false
    && opts.projectEnabled !== false;

  const named = env['STEPTIX_STATS_SUITE']?.trim().toLowerCase();
  const suite = named !== undefined && SUITES.has(named) ? (named as StatsSuite) : 'user';

  const retainMonths = retainFrom(machine['STEPTIX_STATS_RETAIN_MONTHS']) ?? DEFAULT_RETAIN_MONTHS;

  return { enabled, suite, retainMonths };
}
