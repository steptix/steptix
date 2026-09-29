/**
 * Where the scoreboard's lines live, and how they are written, read, aged out
 * and switched off (docs/specs/SPEC-scoreboard.md §6). Every test points the
 * user root at its own temp folder through the `UserRootDeps` seam — never at
 * the real %LOCALAPPDATA%.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import {
  appendStatsLines,
  DEFAULT_RETAIN_MONTHS,
  flushStatsWrites,
  formatStatsLine,
  listStatsMonths,
  MAX_LINE_BYTES,
  MAX_TEXT_CHARS,
  monthFileFor,
  pruneStatsFiles,
  readStatsLines,
  statsDir,
  statsSettings,
} from '../src/stats/store.js';
import type { StatsActionLine, StatsRunLine, StatsStepLine } from '../src/stats/types.js';
import type { UserRootDeps } from '../src/env/user-root.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-stats-store-')));
});

afterEach(async () => {
  await flushStatsWrites();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Deps that put the user root inside this test's tmp dir on every platform. */
function deps(): UserRootDeps {
  return { env: { LOCALAPPDATA: tmp, XDG_CONFIG_HOME: tmp }, platform: process.platform };
}

function actionLine(over: Partial<StatsActionLine> = {}): StatsActionLine {
  return {
    v: 1,
    kind: 'action',
    t: '2026-09-28T07:12:57.000Z',
    run: 'r-20260928-071250-4f1c',
    project: 'C:\\work\\templates\\init',
    test: 'tests/recording.md',
    step: 11,
    exec: 3,
    stepText: 'Select "Mr" from the Title Select list',
    attempt: 1,
    turn: 1,
    action: 'click',
    selector: '[role="listbox"] [role="option"]:text-is("Mr")',
    form: 'text-is',
    outcome: 'no-match',
    ms: 10012,
    site: 'secure.super.test',
    model: 'openai/gpt-6-luna',
    prompt: 'p-3f9a1c',
    fw: '1.0.0+b700473',
    suite: 'user',
    source: 'ai',
    ...over,
  };
}

function stepLine(over: Partial<StatsStepLine> = {}): StatsStepLine {
  return {
    v: 1,
    kind: 'step',
    t: '2026-09-28T07:13:10.000Z',
    run: 'r-20260928-071250-4f1c',
    project: 'C:\\work\\templates\\init',
    test: 'tests/recording.md',
    step: 11,
    exec: 3,
    stepText: 'Select "Mr" from the Title Select list',
    status: 'passed',
    attempts: 2,
    turns: 3,
    firstTry: false,
    ms: 23000,
    calls: 3,
    tokensIn: 12000,
    tokensOut: 300,
    suite: 'user',
    source: 'ai',
    ...over,
  };
}

function runLine(over: Partial<StatsRunLine> = {}): StatsRunLine {
  return {
    v: 1,
    kind: 'run',
    t: '2026-09-28T07:14:00.000Z',
    run: 'r-20260928-071250-4f1c',
    project: 'C:\\work\\templates\\init',
    test: 'tests/recording.md',
    suite: 'user',
    status: 'passed',
    steps: 14,
    firstTry: 12,
    failed: 0,
    tokensIn: 50000,
    tokensOut: 2000,
    report: 'C:\\work\\templates\\init\\reports\\2026-09-28_07-12-50-recording.html',
    ...over,
  };
}

function monthFile(month: string): string {
  return path.join(tmp, 'steptix', 'stats', `actions-${month}.jsonl`);
}

/** Lines as the writer writes them, one per line. */
function jsonl(lines: readonly object[]): string {
  return lines.map((line) => `${JSON.stringify(line)}
`).join('');
}

function writeRaw(month: string, content: string): void {
  fs.mkdirSync(path.dirname(monthFile(month)), { recursive: true });
  fs.writeFileSync(monthFile(month), content);
}

describe('where the lines live (§6.1)', () => {
  it('<user root>/stats', () => {
    expect(statsDir(deps())).toBe(path.join(tmp, 'steptix', 'stats'));
  });

  it('one file per UTC month', () => {
    expect(monthFileFor(new Date('2026-09-28T07:12:57Z'), deps())).toBe(monthFile('2026-09'));
    // 23:30 on 30 September in UTC-5 is already October in UTC.
    expect(monthFileFor(new Date('2026-09-30T23:30:00-05:00'), deps())).toBe(monthFile('2026-10'));
    // 00:30 on 1 January in UTC+10 is still December in UTC.
    expect(monthFileFor(new Date('2026-01-01T00:30:00+10:00'), deps())).toBe(monthFile('2025-12'));
  });
});

describe('appending and reading back', () => {
  it('round-trips every kind of line, in the order written', async () => {
    const lines = [actionLine(), actionLine({ turn: 2, outcome: 'ok', selector: 'role=option[name="Mr"]', form: 'role' }), stepLine(), runLine()];
    appendStatsLines(lines, deps());
    await flushStatsWrites();

    const raw = fs.readFileSync(monthFile('2026-09'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    const rawLines = raw.split('\n').slice(0, -1);
    expect(rawLines).toHaveLength(4);
    for (const text of rawLines) expect(Buffer.byteLength(`${text}\n`)).toBeLessThanOrEqual(MAX_LINE_BYTES);

    expect(await readStatsLines({ deps: deps() })).toEqual({ lines, skipped: 0 });
  });

  it('creates the stats folder on first use and appends after that', async () => {
    expect(fs.existsSync(statsDir(deps()))).toBe(false);
    appendStatsLines([actionLine()], deps());
    await flushStatsWrites();
    appendStatsLines([stepLine()], deps());
    await flushStatsWrites();
    const { lines } = await readStatsLines({ deps: deps() });
    expect(lines.map((line) => line.kind)).toEqual(['action', 'step']);
  });

  it('files each line under the month of its own t', async () => {
    appendStatsLines(
      [actionLine({ t: '2026-08-31T23:59:59.000Z' }), stepLine({ t: '2026-09-01T00:00:01.000Z' })],
      deps(),
    );
    await flushStatsWrites();
    expect(fs.readFileSync(monthFile('2026-08'), 'utf-8')).toContain('"kind":"action"');
    expect(fs.readFileSync(monthFile('2026-09'), 'utf-8')).toContain('"kind":"step"');
  });

  it('returns at once and writes nothing until the queue runs', () => {
    appendStatsLines([actionLine()], deps());
    // Synchronously, the append has only been queued.
    expect(fs.existsSync(monthFile('2026-09'))).toBe(false);
  });

  it('an empty batch is a no-op', async () => {
    appendStatsLines([], deps());
    await flushStatsWrites();
    expect(fs.existsSync(statsDir(deps()))).toBe(false);
  });

  it('a missing stats folder reads as no lines', async () => {
    expect(await readStatsLines({ deps: deps() })).toEqual({ lines: [], skipped: 0 });
  });
});

describe('line size (§6.2)', () => {
  it('cuts stepText and selector to 500 characters and says so', () => {
    const written = formatStatsLine(actionLine({ stepText: 'a'.repeat(600), selector: `#${'b'.repeat(700)}` }));
    expect(written).not.toBeNull();
    const line = JSON.parse(written!) as StatsActionLine;
    expect(line.stepText).toBe('a'.repeat(MAX_TEXT_CHARS));
    expect(line.selector).toBe(`#${'b'.repeat(MAX_TEXT_CHARS - 1)}`);
    expect(line.truncated).toBe(true);
  });

  it('leaves text at the limit alone, and a short line unmarked', () => {
    const atLimit = JSON.parse(formatStatsLine(actionLine({ stepText: 'a'.repeat(MAX_TEXT_CHARS) }))!) as StatsActionLine;
    expect(atLimit.stepText).toHaveLength(MAX_TEXT_CHARS);
    expect(atLimit).not.toHaveProperty('truncated');
  });

  it('counts characters, not UTF-16 units, and never splits a pair', () => {
    // 500 emoji are 1000 UTF-16 units: at the limit, not over it.
    const emoji = '😀'.repeat(MAX_TEXT_CHARS);
    const kept = JSON.parse(formatStatsLine(stepLine({ stepText: emoji }))!) as StatsStepLine;
    expect(kept.stepText).toBe(emoji);
    expect(kept).not.toHaveProperty('truncated');

    const cut = JSON.parse(formatStatsLine(stepLine({ stepText: `${emoji}😀x` }))!) as StatsStepLine;
    expect(cut.stepText).toBe(emoji);
    expect(cut.truncated).toBe(true);
  });

  it('a line still over 4 KB after the cut drops its step text rather than go out oversized', () => {
    // A 500-character selector of control characters escapes to 3000 bytes of
    // JSON, and 500 CJK characters of step text are 1500 more.
    const selector = '\u0001'.repeat(MAX_TEXT_CHARS);
    const written = formatStatsLine(actionLine({ selector, stepText: '語'.repeat(MAX_TEXT_CHARS) }));
    expect(written).not.toBeNull();
    expect(Buffer.byteLength(written!)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const line = JSON.parse(written!) as StatsActionLine;
    expect(line).not.toHaveProperty('stepText');
    expect(line.selector).toBe(selector);
    expect(line.truncated).toBe(true);
    // What the reader counts by is still there.
    expect(line).toMatchObject({ form: 'text-is', outcome: 'no-match', site: 'secure.super.test' });
  });

  it('a line that cannot be made to fit is not written at all', async () => {
    const huge = runLine({ project: `C:\\${'deep\\'.repeat(1000)}` });
    expect(formatStatsLine(huge)).toBeNull();

    appendStatsLines([huge, runLine({ run: 'r-20260928-071250-beef' })], deps());
    await flushStatsWrites();
    const { lines } = await readStatsLines({ deps: deps() });
    expect(lines.map((line) => line.run)).toEqual(['r-20260928-071250-beef']);
  });
});

describe('reading what is there', () => {
  it('skips and counts lines it cannot use, and ignores blank ones', async () => {
    const good = JSON.stringify(runLine());
    writeRaw(
      '2026-09',
      [
        `\ufeff${good}`, // a byte-order mark an editor added
        '{not json',
        '[]',
        '"a string"',
        JSON.stringify({ kind: 'run', t: '2026-09-28T07:14:00.000Z' }), // no v
        JSON.stringify({ v: 2, kind: 'run', t: '2026-09-28T07:14:00.000Z' }), // a newer framework's
        JSON.stringify({ v: 1, kind: 'mystery', t: '2026-09-28T07:14:00.000Z' }),
        JSON.stringify({ v: 1, kind: 'run', t: 'yesterday' }),
        '',
        '   ',
        good,
        '{"v":1,"kind":"run","t":"2026-09-28T07:1', // torn by a crash mid-write
      ].join('\n'),
    );
    const { lines, skipped } = await readStatsLines({ deps: deps() });
    expect(lines).toEqual([runLine(), runLine()]);
    expect(skipped).toBe(8);
  });

  it('reads the month files from the one holding since on, and keeps the action and step lines inside the window', async () => {
    // Garbage in July: if July were read at all, it would be counted.
    writeRaw('2026-07', 'garbage\n');
    writeRaw(
      '2026-08',
      jsonl([actionLine({ run: 'aug-early', t: '2026-08-01T00:00:00.000Z' }), stepLine({ run: 'aug-15', t: '2026-08-15T00:00:00.000Z' })]),
    );
    writeRaw(
      '2026-09',
      jsonl([actionLine({ run: 'sep-10', t: '2026-09-10T00:00:00.000Z' }), stepLine({ run: 'sep-late', t: '2026-09-20T00:00:00.000Z' })]),
    );
    writeRaw('2026-10', 'more garbage\n');
    // Neither a month file nor read.
    fs.writeFileSync(path.join(statsDir(deps()), 'imported.json'), '{}');

    // Both bounds inclusive.
    const { lines, skipped } = await readStatsLines({
      since: new Date('2026-08-15T00:00:00.000Z'),
      until: new Date('2026-09-10T00:00:00.000Z'),
      deps: deps(),
    });
    expect(lines.map((line) => line.run)).toEqual(['aug-15', 'sep-10']);
    // October is past `until` but still read — it may hold a run line — so
    // its garbage is counted.
    expect(skipped).toBe(1);

    const all = await readStatsLines({ deps: deps() });
    expect(all.lines.map((line) => line.run)).toEqual(['aug-early', 'aug-15', 'sep-10', 'sep-late']);
    expect(all.skipped).toBe(2);

    const since = await readStatsLines({ since: new Date('2026-09-15T00:00:00.000Z'), deps: deps() });
    expect(since.lines.map((line) => line.run)).toEqual(['sep-late']);
    expect(since.skipped).toBe(1); // October is in the window; July and August are not
  });

  it('keeps run lines past until: a run’s line is written when it ends, after the window', async () => {
    writeRaw(
      '2026-09',
      jsonl([
        runLine({ run: 'too-early', t: '2026-09-09T23:59:59.000Z' }),
        actionLine({ run: 'r1', t: '2026-09-10T08:00:00.000Z' }),
        actionLine({ run: 'r1', t: '2026-09-10T09:30:00.000Z' }), // past until
        runLine({ run: 'r1', t: '2026-09-10T09:31:00.000Z' }),
      ]),
    );
    writeRaw('2026-10', jsonl([runLine({ run: 'r2', t: '2026-10-01T00:00:00.000Z' })]));
    const { lines } = await readStatsLines({
      since: new Date('2026-09-10T00:00:00.000Z'),
      until: new Date('2026-09-10T09:00:00.000Z'),
      deps: deps(),
    });
    expect(lines.map((line) => `${line.kind} ${line.run} ${line.t}`)).toEqual([
      'action r1 2026-09-10T08:00:00.000Z',
      'run r1 2026-09-10T09:31:00.000Z',
      'run r2 2026-10-01T00:00:00.000Z',
    ]);
  });

  it('decides from the prefix alone, and never parses a line the window does not need', async () => {
    writeRaw(
      '2026-09',
      jsonl([
        actionLine({ run: 'before', t: '2026-09-01T00:00:00.000Z' }),
        stepLine({ run: 'before', t: '2026-09-01T00:00:01.000Z' }),
        actionLine({ run: 'inside', t: '2026-09-15T00:00:00.000Z' }),
        stepLine({ run: 'after', t: '2026-09-25T00:00:00.000Z' }),
        runLine({ run: 'after', t: '2026-09-25T00:00:01.000Z' }),
      ]),
    );
    const parse = vi.spyOn(JSON, 'parse');
    let lines: Awaited<ReturnType<typeof readStatsLines>>['lines'];
    let parsed: unknown[][];
    try {
      ({ lines } = await readStatsLines({
        since: new Date('2026-09-10T00:00:00.000Z'),
        until: new Date('2026-09-20T00:00:00.000Z'),
        deps: deps(),
      }));
      parsed = parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('"kind":'));
    } finally {
      parse.mockRestore();
    }
    expect(lines.map((line) => `${line.kind} ${line.run}`)).toEqual(['action inside', 'run after']);
    expect(parsed.map(([text]) => (JSON.parse(text as string) as { run: string }).run)).toEqual(['inside', 'after']);
  });

  it('a line written in another key order is still read, and still held to the window', async () => {
    // Hand-edited, or written by something other than formatStatsLine: no
    // prefix to decide from, so it is parsed.
    const reordered = (line: object): string => {
      const { v, kind, t, ...rest } = line as { v: number; kind: string; t: string };
      return JSON.stringify({ ...rest, t, kind, v });
    };
    writeRaw(
      '2026-09',
      [
        reordered(actionLine({ run: 'outside', t: '2026-09-01T00:00:00.000Z' })),
        reordered(actionLine({ run: 'inside', t: '2026-09-15T00:00:00.000Z' })),
      ].join('\n'),
    );
    const { lines, skipped } = await readStatsLines({ since: new Date('2026-09-10T00:00:00.000Z'), deps: deps() });
    expect(lines.map((line) => line.run)).toEqual(['inside']);
    expect(skipped).toBe(0);
  });

  it('streams a file larger than one read: every line whole, whatever falls on a chunk boundary', async () => {
    // Over 3 MB of lines full of multi-byte text, some ending in CRLF as an
    // editor on Windows would save them, and a byte-order mark first.
    const written: StatsActionLine[] = [];
    const texts: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const line = actionLine({
        run: `r-${i}`,
        t: new Date(Date.UTC(2026, 8, 2) + i * 1000).toISOString(),
        stepText: `${'語😀é'.repeat(80 + (i % 7))} #${i}`,
      });
      written.push(line);
      texts.push(`${formatStatsLine(line)!.trimEnd()}${i % 3 === 0 ? '\r' : ''}`);
    }
    writeRaw('2026-09', `﻿${texts.join('\n')}`);
    expect(fs.statSync(monthFile('2026-09')).size).toBeGreaterThan(3 * 1024 * 1024);
    const { lines, skipped } = await readStatsLines({ deps: deps() });
    expect(skipped).toBe(0);
    expect(lines).toEqual(written);
  });

  it('checks the fields §5 requires of each kind, and skips and counts a line without them', async () => {
    const drop = <T extends object>(line: T, field: string): object => {
      const copy: Record<string, unknown> = { ...line };
      delete copy[field];
      return copy;
    };
    const bad = [
      drop(actionLine(), 'outcome'),
      drop(actionLine(), 'suite'),
      drop(actionLine(), 'run'),
      drop(actionLine(), 'selector'), // null when there is none, never absent
      { ...actionLine(), attempt: 0 },
      { ...actionLine(), step: '11' },
      { ...actionLine(), exec: -1 },
      { ...actionLine(), ms: -1 },
      { ...actionLine(), outcome: '' },
      { ...actionLine(), matchCount: 'none' },
      drop(stepLine(), 'firstTry'),
      drop(stepLine(), 'source'),
      { ...stepLine(), calls: '3' },
      { ...stepLine(), card: 'no' },
      { ...stepLine(), interrupted: false },
      { ...stepLine(), test: 7 },
      drop(runLine(), 'report'),
      { ...runLine(), steps: -1 },
      { ...runLine(), status: 3 },
    ];
    const good = [
      // Words a newer framework may add are still counted, not thrown away.
      actionLine({ outcome: 'teleported' as never }),
      stepLine({ suite: 'nightly' as never }),
      { ...actionLine(), somethingNew: [1, 2, 3] },
      // Optional fields may be absent, and a line written before `exec`.
      drop(drop(drop(actionLine(), 'exec'), 'site'), 'stepText'),
      stepLine({ card: false, site: 'example.org', model: 'm' }),
      runLine({ report: null, aborted: true }),
    ];
    writeRaw('2026-09', jsonl([...bad, ...good]));
    const { lines, skipped } = await readStatsLines({ deps: deps() });
    expect(skipped).toBe(bad.length);
    expect(lines).toEqual(good);
  });
});

describe('listStatsMonths', () => {
  it('the month files, oldest first; nothing when the folder is missing', async () => {
    expect(await listStatsMonths(deps())).toEqual([]);
    for (const month of ['2026-09', '2025-12', '2026-01']) writeRaw(month, '');
    fs.writeFileSync(path.join(statsDir(deps()), 'imported.json'), '{}');
    fs.writeFileSync(path.join(statsDir(deps()), 'actions-2026-13.jsonl'), '');
    const months = await listStatsMonths(deps());
    expect(months.map((month) => month.month)).toEqual(['2025-12', '2026-01', '2026-09']);
    expect(months[0]).toEqual({
      name: 'actions-2025-12.jsonl',
      month: '2025-12',
      start: Date.UTC(2025, 11, 1),
      end: Date.UTC(2026, 0, 1),
    });
  });
});

describe('formatStatsLine writes the prefix the reader decides from', () => {
  it('v, kind and t first, whatever order the line was built in', () => {
    const { v, kind, t, ...rest } = runLine();
    const built = { ...rest, t, kind, v } as StatsRunLine;
    const written = formatStatsLine(built)!;
    expect(written.startsWith(`{"v":1,"kind":"run","t":"${t}",`)).toBe(true);
    expect(JSON.parse(written)).toEqual(runLine());
  });
});

describe('retention (§6.3)', () => {
  const NOW = new Date('2026-09-29T10:00:00.000Z');

  function seed(): void {
    fs.mkdirSync(statsDir(deps()), { recursive: true });
    for (const month of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
      fs.writeFileSync(monthFile(month), `${JSON.stringify(runLine())}\n`);
    }
    fs.writeFileSync(path.join(statsDir(deps()), 'imported.json'), '{}');
    fs.writeFileSync(path.join(statsDir(deps()), 'actions-notes.txt'), 'mine');
  }

  function remaining(): string[] {
    return fs.readdirSync(statsDir(deps())).sort();
  }

  it('deletes a month only when even its last day is older than the window', async () => {
    seed();
    const deleted = await pruneStatsFiles({ retainMonths: 6, now: NOW, deps: deps() });
    expect(deleted.map((file) => path.basename(file)).sort()).toEqual([
      'actions-2025-12.jsonl',
      'actions-2026-01.jsonl',
      'actions-2026-02.jsonl',
    ]);
    // March stays: its last days are under six months old on 29 September.
    // The folder's other files, and a month ahead of the clock, are left alone.
    expect(remaining()).toEqual([
      'actions-2026-03.jsonl',
      'actions-2026-04.jsonl',
      'actions-2026-05.jsonl',
      'actions-2026-06.jsonl',
      'actions-2026-07.jsonl',
      'actions-2026-08.jsonl',
      'actions-2026-09.jsonl',
      'actions-2026-10.jsonl',
      'actions-notes.txt',
      'imported.json',
    ]);
  });

  it('a window of one month keeps this month and the last', async () => {
    seed();
    await pruneStatsFiles({ retainMonths: 1, now: NOW, deps: deps() });
    expect(remaining().filter((name) => name.endsWith('.jsonl'))).toEqual([
      'actions-2026-08.jsonl',
      'actions-2026-09.jsonl',
      'actions-2026-10.jsonl',
    ]);
  });

  it('a bad window, or a clock that is not a date, deletes nothing', async () => {
    seed();
    for (const retainMonths of [0, -1, 1.5, Number.NaN]) {
      expect(await pruneStatsFiles({ retainMonths, now: NOW, deps: deps() })).toEqual([]);
    }
    // An invalid date compares false with every month — "all older" if unguarded.
    expect(await pruneStatsFiles({ retainMonths: 6, now: new Date(Number.NaN), deps: deps() })).toEqual([]);
    expect(remaining()).toHaveLength(13);
  });

  it('a missing folder prunes nothing and does not throw', async () => {
    expect(await pruneStatsFiles({ retainMonths: DEFAULT_RETAIN_MONTHS, now: NOW, deps: deps() })).toEqual([]);
  });

  it('keepFrom: no month that ends after it is deleted, however old', async () => {
    seed();
    // `steptix stats --since 2026-01-15`: January is in the window, February and
    // on hold what it links through. Only December goes.
    const deleted = await pruneStatsFiles({ retainMonths: 6, now: NOW, deps: deps(), keepFrom: new Date('2026-01-15T00:00:00.000Z') });
    expect(deleted.map((file) => path.basename(file))).toEqual(['actions-2025-12.jsonl']);
    // A window starting on the 1st keeps that month; the ones before it go.
    seed();
    const onTheFirst = await pruneStatsFiles({ retainMonths: 6, now: NOW, deps: deps(), keepFrom: new Date('2026-02-01T00:00:00.000Z') });
    expect(onTheFirst.map((file) => path.basename(file)).sort()).toEqual(['actions-2025-12.jsonl', 'actions-2026-01.jsonl']);
    // An invalid date deletes nothing rather than everything.
    seed();
    expect(await pruneStatsFiles({ retainMonths: 6, now: NOW, deps: deps(), keepFrom: new Date(Number.NaN) })).toEqual([]);
  });
});

describe('writing never fails a run (§6.2)', () => {
  function breakTheFolder(): void {
    // A FILE where the stats folder should be: every append and every mkdir fails.
    fs.mkdirSync(path.join(tmp, 'steptix'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'steptix', 'stats'), 'not a folder');
  }

  it('neither throws nor rejects, and leaves no unhandled rejection behind', async () => {
    breakTheFolder();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(() => appendStatsLines([actionLine(), stepLine()], deps())).not.toThrow();
      await expect(flushStatsWrites()).resolves.toBeUndefined();
      expect(await pruneStatsFiles({ retainMonths: 6, deps: deps() })).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('survives a user root that cannot even be named', async () => {
    const broken: UserRootDeps = {
      env: {},
      platform: 'linux',
      homedir: () => {
        throw new Error('no home directory');
      },
    };
    expect(() => appendStatsLines([actionLine()], broken)).not.toThrow();
    await expect(flushStatsWrites()).resolves.toBeUndefined();
  });

  it('logs a failing write once per process, at debug', async () => {
    // A fresh module: the once-per-process memory starts empty.
    vi.resetModules();
    const store = await import('../src/stats/store.js');
    const log = await import('../src/utils/logger.js');
    const seen: Array<{ level: string; message: string }> = [];
    const dispose = log.addLogCallback((level, message) => {
      if (message.startsWith('stats:')) seen.push({ level, message });
    });
    try {
      breakTheFolder();
      store.appendStatsLines([actionLine()], deps());
      store.appendStatsLines([actionLine(), stepLine()], deps());
      await store.flushStatsWrites();
    } finally {
      dispose();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ level: 'debug' });
    expect(seen[0]!.message).toMatch(/^stats: could not write a line: /);
  });
});

describe('statsSettings (§6.4, §5.6, §6.3)', () => {
  function machineEnv(content: string): void {
    fs.mkdirSync(path.join(tmp, 'steptix'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'steptix', '.env'), content);
  }

  it('records by default, as the user, keeping six months', () => {
    expect(statsSettings({ env: {}, deps: deps() })).toEqual({ enabled: true, suite: 'user', retainMonths: 6 });
  });

  it('STEPTIX_STATS off in the environment turns recording off', () => {
    for (const value of ['off', 'OFF', '0', 'false', 'False ', 'no']) {
      expect(statsSettings({ env: { STEPTIX_STATS: value }, deps: deps() }).enabled, value).toBe(false);
    }
    for (const value of ['on', '1', 'true', '', 'maybe']) {
      expect(statsSettings({ env: { STEPTIX_STATS: value }, deps: deps() }).enabled, value).toBe(true);
    }
  });

  it('STEPTIX_STATS off in the machine .env turns it off, whatever the environment says', () => {
    machineEnv('AI_MODEL=m1\nSTEPTIX_STATS=off\n');
    expect(statsSettings({ env: {}, deps: deps() }).enabled).toBe(false);
    expect(statsSettings({ env: { STEPTIX_STATS: 'on' }, deps: deps() }).enabled).toBe(false);
  });

  it('a project with stats.enabled false records nothing; others are untouched', () => {
    expect(statsSettings({ env: {}, projectEnabled: false, deps: deps() }).enabled).toBe(false);
    expect(statsSettings({ env: {}, projectEnabled: true, deps: deps() }).enabled).toBe(true);
    expect(statsSettings({ env: {}, projectEnabled: undefined, deps: deps() }).enabled).toBe(true);
    // A project cannot switch the machine back on.
    expect(statsSettings({ env: { STEPTIX_STATS: 'off' }, projectEnabled: true, deps: deps() }).enabled).toBe(false);
  });

  it('the suite comes from STEPTIX_STATS_SUITE in the environment; anything unknown is user', () => {
    expect(statsSettings({ env: { STEPTIX_STATS_SUITE: 'live' }, deps: deps() }).suite).toBe('live');
    expect(statsSettings({ env: { STEPTIX_STATS_SUITE: ' Bench ' }, deps: deps() }).suite).toBe('bench');
    expect(statsSettings({ env: { STEPTIX_STATS_SUITE: 'compile' }, deps: deps() }).suite).toBe('compile');
    expect(statsSettings({ env: { STEPTIX_STATS_SUITE: 'nightly' }, deps: deps() }).suite).toBe('user');
    expect(statsSettings({ env: { STEPTIX_STATS_SUITE: '' }, deps: deps() }).suite).toBe('user');
    // Not from the machine file: that would tag every run on the machine.
    machineEnv('STEPTIX_STATS_SUITE=live\n');
    expect(statsSettings({ env: {}, deps: deps() }).suite).toBe('user');
  });

  it('retention from the machine .env, else six — never from the environment', () => {
    // A shell that says 1 must not prune months the machine was told to keep:
    // the server and every `steptix stats` read the same file (§6.3).
    expect(statsSettings({ env: { STEPTIX_STATS_RETAIN_MONTHS: '1' }, deps: deps() }).retainMonths).toBe(6);
    machineEnv('STEPTIX_STATS_RETAIN_MONTHS=12\n');
    expect(statsSettings({ env: {}, deps: deps() }).retainMonths).toBe(12);
    expect(statsSettings({ env: { STEPTIX_STATS_RETAIN_MONTHS: '2' }, deps: deps() }).retainMonths).toBe(12);
    for (const value of ['0', '-2', '1.5', 'abc', '']) {
      machineEnv(`STEPTIX_STATS_RETAIN_MONTHS=${value}\n`);
      expect(statsSettings({ env: {}, deps: deps() }).retainMonths, value).toBe(6);
    }
  });

  it('with no env given, reads the seam’s env — never the real one', () => {
    const seam: UserRootDeps = { env: { LOCALAPPDATA: tmp, XDG_CONFIG_HOME: tmp, STEPTIX_STATS: 'off' }, platform: process.platform };
    expect(statsSettings({ deps: seam }).enabled).toBe(false);
  });

  it('an unreadable machine .env counts as empty rather than failing', () => {
    fs.mkdirSync(path.join(tmp, 'steptix', '.env'), { recursive: true }); // a folder: EISDIR
    expect(statsSettings({ env: {}, deps: deps() })).toEqual({ enabled: true, suite: 'user', retainMonths: 6 });
  });
});

describe('the project switch in steptix.config.json (§6.4)', () => {
  it('the schema accepts stats.enabled as a boolean and nothing else', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const schema = JSON.parse(fs.readFileSync(path.resolve(here, '../schema/steptix.config.schema.json'), 'utf8'));
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
    expect(validate({ stats: { enabled: false } })).toBe(true);
    expect(validate({ stats: {} })).toBe(true);
    expect(validate({ stats: { enabled: 'no' } })).toBe(false);
    expect(validate({ stats: { enable: false } })).toBe(false);
  });

  it('rides through the loader, so the run can hand it to statsSettings', async () => {
    const { loadConfig } = await import('../src/config/loader.js');
    // The loader's machine-AI floor reads the user root: keep it in tmp.
    const preserved = { LOCALAPPDATA: process.env['LOCALAPPDATA'], XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] };
    process.env['LOCALAPPDATA'] = tmp;
    process.env['XDG_CONFIG_HOME'] = tmp;
    try {
      const off = path.join(tmp, 'off.json');
      fs.writeFileSync(off, JSON.stringify({ stats: { enabled: false } }));
      const plain = path.join(tmp, 'plain.json');
      fs.writeFileSync(plain, JSON.stringify({}));

      const offConfig = await loadConfig(off);
      expect(offConfig.stats).toEqual({ enabled: false });
      expect(statsSettings({ env: {}, projectEnabled: offConfig.stats?.enabled, deps: deps() }).enabled).toBe(false);

      const plainConfig = await loadConfig(plain);
      expect(plainConfig.stats).toBeUndefined();
      expect(statsSettings({ env: {}, projectEnabled: plainConfig.stats?.enabled, deps: deps() }).enabled).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(preserved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
