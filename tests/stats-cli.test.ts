/**
 * `steptix stats` end to end (docs/specs/SPEC-scoreboard.md §9, §15 "The
 * command"): the real command against a fixture month file in a temp user
 * root — never the real %LOCALAPPDATA% — with the clock and the time zone
 * pinned, the way `steptix status` and `steptix stop` are tested (console captured,
 * exit code returned).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseWhen, statsCommand, type StatsOptions } from '../src/cli/commands/stats.js';
import { formatStatsLine } from '../src/stats/store.js';
import type { StatsLine } from '../src/stats/types.js';
import type { UserRootDeps } from '../src/env/user-root.js';

const NOW = new Date('2026-09-29T10:00:00.000Z');

let tmp: string;
let out: string[];
let err: string[];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-stats-cli-')));
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The user root inside this test's tmp dir, on every platform. */
function deps(env: Record<string, string> = {}): UserRootDeps {
  return { env: { LOCALAPPDATA: tmp, XDG_CONFIG_HOME: tmp, ...env }, platform: process.platform };
}

function stats(opts: StatsOptions = {}, env: Record<string, string> = {}): Promise<number> {
  return statsCommand(opts, { deps: deps(env), now: NOW, timeZone: 'UTC' });
}

function statsDir(): string {
  return path.join(tmp, 'steptix', 'stats');
}

function machineEnv(content: string): void {
  fs.mkdirSync(path.join(tmp, 'steptix'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'steptix', '.env'), content);
}

function writeMonth(month: string, content: string): void {
  fs.mkdirSync(statsDir(), { recursive: true });
  fs.writeFileSync(path.join(statsDir(), `actions-${month}.jsonl`), content);
}

type Line = Record<string, unknown>;

/** Lines as the writer writes them: `formatStatsLine`, `v`, `kind`, `t` first. */
function jsonl(lines: readonly Line[]): string {
  return lines.map((line) => formatStatsLine(line as unknown as StatsLine)!).join('');
}

/** What `--failures` prints for a report on disk: its file: URL and the anchor. */
function link(file: string, anchor: string): string {
  return `  report: ${pathToFileURL(file).href}#${anchor}`;
}

interface Fixture {
  project: string;
  reportA: string;
  reportB: string;
  reportC: string;
  reportD: string;
  reportF: string;
}

const TITLE = 'Select "{{title}}" from the Title Select list on the About you page';

/**
 * Two weeks of one user's runs, as the recorder would have written them, in a
 * project whose path has a space in it:
 *
 * - A (09-20), `recording.md` under the old rules, written before lines had
 *   an `exec`. Its step 11 recovered from a failed click inside one attempt.
 * - B (09-28 07:12), the same test and rules. Step 11 failed twice, and its
 *   report has since been deleted.
 * - Q (09-28 08:00), the new rules, crashed after a failed step more than a
 *   day ago: no run line.
 * - C (09-28 09:30), a data-row run under the new rules with two `before`
 *   hook steps, the second of which recovered from a blocked click.
 * - D (09-29), the new rules: a first try, a skipped step as older writers
 *   recorded it, a `[use ai]` step (no actions, no fingerprint) and a step
 *   that passed on its second attempt.
 * - E, an errand that wrote no report; F, lines imported from an old report.
 * - P, a run still going (or crashed within the day): no run line.
 * - Lines the default view leaves out: the live suite, a code-behind replay,
 *   and one from 40 days ago. Plus a line torn by a crash, and a January
 *   month file that retention deletes.
 */
function writeFixture(): Fixture {
  const project = path.join(tmp, 'my templates', 'init');
  const reports = path.join(project, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  const fixture: Fixture = {
    project,
    reportA: path.join(reports, '2026-09-20_09-15-00-recording.html'),
    reportB: path.join(reports, '2026-09-28_07-12-50-recording.html'),
    reportC: path.join(reports, '2026-09-28_09-30-00-signup-rows.html'),
    reportD: path.join(reports, '2026-09-29_08-00-00-recording.html'),
    reportF: path.join(reports, '2026-09-10_11-00-00-recording.html'),
  };
  // B's report is named by its run line and is not on disk.
  for (const file of [fixture.reportA, fixture.reportC, fixture.reportD, fixture.reportF]) fs.writeFileSync(file, '<html></html>');

  const base = { v: 1, project, suite: 'user', source: 'ai' };
  const fund = { site: 'www.super.test', model: 'openai/gpt-6-luna' };
  const app = { site: 'localhost:8787', model: 'openai/gpt-6-luna' };
  const lines: Line[] = [];
  // A (before `exec`) and F (imported from a report) carry none; every other
  // run numbers its executions, a step's actions sharing its number.
  const noExec = new Set(['r-20260920-091500-aaaa', 'r-20260910-110000-eeee']);
  const execs = new Map<string, number>();
  const execFor = (line: Line, closes: boolean): Line => {
    const runId = String(line['run']);
    if (noExec.has(runId)) return {};
    const exec = (execs.get(runId) ?? 0) + 1;
    if (closes) execs.set(runId, exec);
    return { exec };
  };
  const act = (line: Line) => lines.push({ ...base, kind: 'action', attempt: 1, turn: 1, ms: 300, ...execFor(line, false), ...line });
  const stp = (line: Line) => lines.push({ ...base, kind: 'step', attempts: 1, turns: 1, ms: 4000, ...execFor(line, true), ...line });
  const run = (line: Line) => lines.push({ v: 1, kind: 'run', project, suite: 'user', ...line });
  const NAV = 'Navigate to ${BASE_URL}/join';
  const TEXT_IS = '[role="listbox"] [role="option"]:text-is("Mr")';

  let r: Line = { run: 'r-20260920-091500-aaaa', test: 'tests/recording.md', prompt: 'p-3f9a1c' };
  act({ ...r, ...fund, t: '2026-09-20T09:15:10.000Z', step: 1, stepText: NAV, action: 'navigate', selector: null, form: null, outcome: 'ok' });
  stp({ ...r, t: '2026-09-20T09:15:11.000Z', step: 1, stepText: NAV, status: 'passed', firstTry: true, calls: 1, tokensIn: 3000, tokensOut: 100 });
  act({ ...r, ...fund, t: '2026-09-20T09:15:40.000Z', step: 11, stepText: TITLE, action: 'click', selector: TEXT_IS, form: 'text-is', outcome: 'no-match', ms: 10012 });
  act({ ...r, ...fund, t: '2026-09-20T09:15:55.000Z', step: 11, stepText: TITLE, turn: 2, action: 'click', selector: 'role=option[name="Mr"]', form: 'role', outcome: 'ok' });
  stp({ ...r, t: '2026-09-20T09:16:00.000Z', step: 11, stepText: TITLE, status: 'passed', firstTry: false, turns: 2, calls: 2, tokensIn: 9000, tokensOut: 300 });
  act({ ...r, ...fund, t: '2026-09-20T09:16:20.000Z', step: 12, stepText: 'Click Continue', action: 'click', selector: 'role=button[name="Continue"]', form: 'role', outcome: 'ok' });
  stp({ ...r, t: '2026-09-20T09:16:30.000Z', step: 12, stepText: 'Click Continue', status: 'passed', firstTry: true, calls: 1, tokensIn: 4000, tokensOut: 80 });
  run({ run: r['run'], test: r['test'], t: '2026-09-20T09:17:00.000Z', status: 'passed', steps: 3, firstTry: 2, failed: 0, report: fixture.reportA });

  r = { run: 'r-20260928-071250-4f1c', test: 'tests/recording.md', prompt: 'p-3f9a1c' };
  act({ ...r, ...fund, t: '2026-09-28T07:12:52.000Z', step: 1, stepText: NAV, action: 'navigate', selector: null, form: null, outcome: 'ok' });
  stp({ ...r, ...fund, t: '2026-09-28T07:12:53.000Z', step: 1, stepText: NAV, status: 'passed', firstTry: true, calls: 1, tokensIn: 2800, tokensOut: 90 });
  act({ ...r, ...fund, t: '2026-09-28T07:12:57.000Z', step: 11, stepText: TITLE, action: 'click', selector: TEXT_IS, form: 'text-is', outcome: 'no-match', ms: 10012 });
  act({ ...r, ...fund, t: '2026-09-28T07:13:30.000Z', step: 11, stepText: TITLE, attempt: 2, action: 'click', selector: '[role="option"][name="Mr"]', form: 'css-role-name', outcome: 'no-match', ms: 10009 });
  stp({ ...r, ...fund, t: '2026-09-28T07:13:40.000Z', step: 11, stepText: TITLE, status: 'failed', firstTry: false, attempts: 2, turns: 2, calls: 3, tokensIn: 20000, tokensOut: 500, tokensEstimated: true });
  run({ run: r['run'], test: r['test'], t: '2026-09-28T07:14:00.000Z', status: 'failed', steps: 2, firstTry: 1, failed: 1, report: fixture.reportB });

  r = { run: 'r-20260928-080000-7777', test: 'tests/recording.md', prompt: 'p-7b20e4' };
  act({ ...r, ...fund, t: '2026-09-28T08:00:30.000Z', step: 2, stepText: 'Click Save', action: 'click', selector: '[data-testid="save"]', form: 'testid', outcome: 'no-match' });
  stp({ ...r, ...fund, t: '2026-09-28T08:00:31.000Z', step: 2, stepText: 'Click Save', status: 'failed', firstTry: false, calls: 1, tokensIn: 3500, tokensOut: 70 });

  r = { run: 'r-20260928-093000-bbbb', test: 'tests/signup-rows.md', prompt: 'p-7b20e4' };
  const hook = { step: 0, row: 1, hook: 'before' };
  act({ ...r, ...app, ...hook, hookIndex: 1, t: '2026-09-28T09:30:05.000Z', stepText: 'Open the fixture app', action: 'navigate', selector: null, form: null, outcome: 'ok' });
  stp({ ...r, ...app, ...hook, hookIndex: 1, t: '2026-09-28T09:30:06.000Z', stepText: 'Open the fixture app', status: 'passed', firstTry: true, calls: 1, tokensIn: 1500, tokensOut: 40 });
  act({ ...r, ...app, ...hook, hookIndex: 2, t: '2026-09-28T09:30:10.000Z', stepText: 'Sign in as {{user}}', action: 'fill', selector: '#username', form: 'id', outcome: 'ok' });
  act({ ...r, ...app, ...hook, hookIndex: 2, t: '2026-09-28T09:30:21.000Z', stepText: 'Sign in as {{user}}', action: 'click', selector: 'role=button[name="Sign in"]', form: 'role', outcome: 'blocked' });
  act({ ...r, ...app, ...hook, hookIndex: 2, t: '2026-09-28T09:30:25.000Z', stepText: 'Sign in as {{user}}', turn: 2, action: 'click', selector: '#sign-in', form: 'id', outcome: 'ok' });
  stp({ ...r, ...app, ...hook, hookIndex: 2, t: '2026-09-28T09:30:26.000Z', stepText: 'Sign in as {{user}}', status: 'passed', firstTry: false, turns: 2, calls: 2, tokensIn: 5200, tokensOut: 150 });
  act({ ...r, ...app, t: '2026-09-28T09:30:40.000Z', step: 1, row: 1, stepText: 'Fill the email with {{email}}', action: 'fill', selector: '[name="email"]', form: 'name-attr', outcome: 'ok' });
  stp({ ...r, ...app, t: '2026-09-28T09:30:41.000Z', step: 1, row: 1, stepText: 'Fill the email with {{email}}', status: 'passed', firstTry: true, calls: 1, tokensIn: 3100, tokensOut: 60 });
  act({ ...r, ...app, t: '2026-09-28T09:31:40.000Z', step: 1, row: 2, stepText: 'Fill the email with {{email}}', action: 'fill', selector: '[name="email"]', form: 'name-attr', outcome: 'ok' });
  stp({ ...r, ...app, t: '2026-09-28T09:31:41.000Z', step: 1, row: 2, stepText: 'Fill the email with {{email}}', status: 'passed', firstTry: true, calls: 1, tokensIn: 3050, tokensOut: 60 });
  act({ ...r, ...app, t: '2026-09-28T09:32:10.000Z', step: 2, row: 2, stepText: 'Click Create account', action: 'click', selector: 'button:has-text("Create account")', form: 'has-text', outcome: 'timeout', ms: 30000 });
  act({ ...r, ...app, t: '2026-09-28T09:32:50.000Z', step: 2, row: 2, stepText: 'Click Create account', attempt: 2, action: 'click', selector: 'button:has-text("Create account")', form: 'has-text', outcome: 'timeout', ms: 30000 });
  stp({ ...r, ...app, t: '2026-09-28T09:33:00.000Z', step: 2, row: 2, stepText: 'Click Create account', status: 'failed', firstTry: false, attempts: 2, turns: 2, calls: 2, tokensIn: 7400, tokensOut: 200 });
  run({ run: r['run'], test: r['test'], t: '2026-09-28T09:33:30.000Z', status: 'failed', steps: 5, firstTry: 3, failed: 1, report: fixture.reportC });

  r = { run: 'r-20260929-080000-cccc', test: 'tests/recording.md', prompt: 'p-7b20e4' };
  act({ ...r, ...fund, t: '2026-09-29T08:00:30.000Z', step: 11, stepText: TITLE, action: 'click', selector: 'role=option[name="Mr"]', form: 'role', outcome: 'ok' });
  stp({ ...r, ...fund, t: '2026-09-29T08:00:31.000Z', step: 11, stepText: TITLE, status: 'passed', firstTry: true, calls: 1, tokensIn: 3900, tokensOut: 100 });
  // What older writers recorded for a condition that did not hold: no call,
  // no turn. The reader ignores it.
  stp({ ...r, t: '2026-09-29T08:00:32.000Z', step: 12, stepText: 'If the Continue button shows, click it', status: 'skipped', firstTry: false, turns: 0, calls: 0, tokensIn: 0, tokensOut: 0 });
  // A `[use ai]` step: asked through a prompt of its own, so no fingerprint,
  // and no actions — its site and model are on its own line.
  const { prompt: _rules, ...useAi } = r;
  stp({ ...useAi, ...fund, t: '2026-09-29T08:00:35.000Z', step: 13, stepText: '[use ai] Summarise the offer on the page', status: 'passed', firstTry: true, calls: 1, tokensIn: 2500, tokensOut: 60 });
  act({ ...r, ...fund, t: '2026-09-29T08:00:40.000Z', step: 14, stepText: 'Click Continue', action: 'click', selector: 'role=button[name="Continue"]', form: 'role', outcome: 'no-match' });
  act({ ...r, ...fund, t: '2026-09-29T08:00:50.000Z', step: 14, stepText: 'Click Continue', attempt: 2, action: 'click', selector: 'role=button[name="Continue"]', form: 'role', outcome: 'ok' });
  stp({ ...r, ...fund, t: '2026-09-29T08:00:55.000Z', step: 14, stepText: 'Click Continue', status: 'passed', firstTry: false, attempts: 2, turns: 2, calls: 2, tokensIn: 6000, tokensOut: 150 });
  run({ run: r['run'], test: r['test'], t: '2026-09-29T08:01:00.000Z', status: 'passed', steps: 3, firstTry: 2, failed: 0, report: fixture.reportD });

  r = { run: 'r-20260928-120000-dddd', test: null, prompt: 'p-7b20e4' };
  const errand = { site: 'example.org', model: 'anthropic/claude-x' };
  act({ ...r, ...errand, t: '2026-09-28T12:00:10.000Z', step: 1, stepText: 'Accept the cookie banner', action: 'click', selector: 'text=Accept cookies', form: 'text-engine', outcome: 'ok' });
  stp({ ...r, ...errand, t: '2026-09-28T12:00:11.000Z', step: 1, stepText: 'Accept the cookie banner', status: 'passed', firstTry: true, calls: 1, tokensIn: 2000, tokensOut: 50 });
  run({ run: r['run'], test: null, t: '2026-09-28T12:00:20.000Z', status: 'passed', steps: 1, firstTry: 1, failed: 0, report: null });

  r = { run: 'r-20260910-110000-eeee', test: 'tests/recording.md', prompt: null, imported: true };
  act({ ...r, ...fund, t: '2026-09-10T11:00:40.000Z', step: 11, stepText: TITLE, action: 'click', selector: TEXT_IS, form: 'text-is', outcome: 'no-match' });
  act({ ...r, ...fund, t: '2026-09-10T11:00:55.000Z', step: 11, stepText: TITLE, turn: 2, action: 'click', selector: 'role=option[name="Mr"]', form: 'role', outcome: 'ok' });
  stp({ ...r, t: '2026-09-10T11:01:00.000Z', step: 11, stepText: TITLE, status: 'passed', firstTry: false, turns: 2, calls: 2, tokensIn: 8000, tokensOut: 250 });
  run({ run: r['run'], test: r['test'], imported: true, t: '2026-09-10T11:02:00.000Z', status: 'passed', steps: 1, firstTry: 0, failed: 0, report: fixture.reportF });

  r = { run: 'r-20260929-093000-9a9a', test: 'tests/recording.md', prompt: 'p-7b20e4' };
  act({ ...r, ...fund, t: '2026-09-29T09:30:20.000Z', step: 3, stepText: 'Click the Next button', action: 'click', selector: 'div.footer > button.next', form: 'css-other', outcome: 'ambiguous' });
  stp({ ...r, ...fund, t: '2026-09-29T09:30:21.000Z', step: 3, stepText: 'Click the Next button', status: 'failed', firstTry: false, calls: 1, tokensIn: 4100, tokensOut: 90 });

  r = { run: 'r-20260927-120000-ffff', test: 'tests/recording.md', prompt: 'p-7b20e4', suite: 'live' };
  act({ ...r, ...app, t: '2026-09-27T12:00:10.000Z', step: 3, stepText: 'Click Sign in', action: 'click', selector: 'role=button[name="Sign in"]', form: 'role', outcome: 'ok' });
  stp({ ...r, ...app, t: '2026-09-27T12:00:11.000Z', step: 3, stepText: 'Click Sign in', status: 'passed', firstTry: true, calls: 1, tokensIn: 2500, tokensOut: 40 });

  r = { run: 'r-20260929-090000-abcd', test: 'tests/recording.md', source: 'code' };
  stp({ ...r, t: '2026-09-29T09:00:05.000Z', step: 1, stepText: NAV, status: 'passed', firstTry: true, turns: 0, calls: 0, tokensIn: 0, tokensOut: 0 });

  writeMonth('2026-09', `${jsonl(lines)}{"v":1,"kind":"step","t":"2026-09-2\n`);
  writeMonth(
    '2026-08',
    jsonl([{ ...base, kind: 'action', run: 'r-old', test: 'tests/recording.md', t: '2026-08-20T10:00:00.000Z', step: 1, exec: 1, stepText: 'Click Old', attempt: 1, turn: 1, action: 'click', selector: '#old', form: 'id', outcome: 'ok', ms: 1 }]),
  );
  writeMonth('2026-01', '');
  return fixture;
}

const NOTES = ['', 'Note: skipped 1 line that could not be read.', 'Note: removed 1 month file older than 6 months.'];
const RETRIES = 'First try ok and Most common failure count each step’s first attempt; Actions counts retries too.';

describe('steptix stats', () => {
  it('by default: the last 30 days of your runs by selector form, then the steps and cost lines', async () => {
    writeFixture();
    expect(await stats()).toBe(0);
    expect(out).toEqual([
      'Last 30 days · your runs · all sites',
      '',
      'Selector form        Actions   First try ok   Most common failure',
      'role=                      7            67%   no-match (1)',
      ':text-is                   3             0%   no-match (3)',
      '(no selector)              3           100%',
      ':has-text                  2             0%   timeout (1)',
      '#id                        2           100%',
      '[name]                     2           100%',
      'other CSS                  1             0%   ambiguous (1)',
      '[role][name] (CSS)         1              —',
      'data-testid                1             0%   no-match (1)',
      'text=                      1           100%',
      RETRIES,
      '',
      // 9 first try, 1 after a real retry (D's step 14), 3 recovered inside
      // their first attempt, 4 failed: 52.9 / 5.9 / 17.6 / 23.5, rounded so
      // they add up to 100.
      'Steps: 17 run · 53% passed first try · 6% after a retry · 18% after a failed action · 23% failed',
      'Cost:  5,376 tokens a step on average (some estimated) · 1.4 model calls a step',
      ...NOTES,
    ]);
    expect(err).toEqual([]);
    // §6.3: the start of `steptix stats` ages out old months.
    expect(fs.readdirSync(statsDir()).sort()).toEqual(['actions-2026-08.jsonl', 'actions-2026-09.jsonl']);
  });

  it('--failures: failed actions, newest first, each with a report link a terminal can open', async () => {
    const { reportA, reportB, reportC, reportD, reportF } = writeFixture();
    expect(await stats({ failures: true })).toBe(0);
    const title = 'Select "{{title}}" from the Title Select list on the About …';
    expect(out).toEqual([
      'Last 30 days · your runs · all sites · 10 failed actions, newest first',
      '',
      '2026-09-29 09:30  tests/recording.md  step 3  Click the Next button',
      '  click  div.footer > button.next    ambiguous',
      '  report: (not written yet)',
      '',
      '2026-09-29 08:00  tests/recording.md  step 14  Click Continue',
      '  click  role=button[name="Continue"]    no-match',
      link(reportD, 'step-14'),
      '',
      '2026-09-28 09:32  tests/signup-rows.md  row 2, step 2  Click Create account',
      '  click  button:has-text("Create account")    timeout (attempt 2)',
      link(reportC, 'row-2-step-2'),
      '',
      '2026-09-28 09:32  tests/signup-rows.md  row 2, step 2  Click Create account',
      '  click  button:has-text("Create account")    timeout',
      link(reportC, 'row-2-step-2'),
      '',
      '2026-09-28 09:30  tests/signup-rows.md  row 1, before hook 2  Sign in as {{user}}',
      '  click  role=button[name="Sign in"]    blocked',
      link(reportC, 'row-1-hook-before-2-step-0'),
      '',
      '2026-09-28 08:00  tests/recording.md  step 2  Click Save',
      '  click  [data-testid="save"]    no-match',
      '  report: (run did not finish)',
      '',
      `2026-09-28 07:13  tests/recording.md  step 11  ${title}`,
      '  click  [role="option"][name="Mr"]    no-match (attempt 2)',
      `  report: ${reportB} (report deleted)`,
      '',
      `2026-09-28 07:12  tests/recording.md  step 11  ${title}`,
      '  click  [role="listbox"] [role="option"]:text-is("Mr")    no-match',
      `  report: ${reportB} (report deleted)`,
      '',
      `2026-09-20 09:15  tests/recording.md  step 11  ${title}`,
      '  click  [role="listbox"] [role="option"]:text-is("Mr")    no-match',
      link(reportA, 'step-11'),
      '',
      `2026-09-10 11:00  tests/recording.md  step 11  ${title}`,
      '  click  [role="listbox"] [role="option"]:text-is("Mr")    no-match',
      link(reportF, 'step-11'),
      ...NOTES,
    ]);
    // The space in "my templates" is escaped, so the link does not end there.
    expect(link(reportA, 'step-11')).toContain('/my%20templates/init/reports/2026-09-20_09-15-00-recording.html#step-11');
    expect(link(reportA, 'step-11').startsWith('  report: file:///')).toBe(true);
  });

  it('--failures --limit shows the newest and says how many more there are', async () => {
    writeFixture();
    expect(await stats({ failures: true, limit: 2 })).toBe(0);
    expect(out.filter((line) => /^\d{4}-\d{2}-\d{2} /.test(line))).toHaveLength(2);
    expect(out).toContain('Showing 2 of 10. --limit 10 shows them all.');
  });

  it('--by prompt: each rules version with when it was in use; imported history and [use ai] steps apart', async () => {
    writeFixture();
    expect(await stats({ by: 'prompt' })).toBe(0);
    expect(out.slice(0, 8)).toEqual([
      'Last 30 days · your runs · all sites',
      '',
      'Rules version                Actions   First try ok   Most common failure   Steps   Tokens a step   Calls a step',
      'p-3f9a1c (to 09-28)                7            67%   no-match (2)              5          7,974*            1.6',
      'p-7b20e4 (from 09-28)             14            58%   no-match (2)             10           4,072            1.3',
      '(imported, no fingerprint)         2            50%   no-match (1)              1           8,250            2.0',
      '(not the step prompt)              0              —                             1           2,560            1.0',
      RETRIES,
    ]);
    expect(out).toContain('* some of these tokens were estimated');
  });

  it('--by site: a step counts under its own site, else the one its actions ran on', async () => {
    writeFixture();
    expect(await stats({ by: 'site' })).toBe(0);
    expect(out.slice(2, 6)).toEqual([
      'Site             Actions   First try ok   Most common failure   Steps   Tokens a step   Calls a step',
      'www.super.test        14            50%   no-match (5)             11          6,235*            1.5',
      'localhost:8787         8            71%   blocked (1)               5           4,152            1.4',
      'example.org            1           100%                             1           2,050            1.0',
    ]);
  });

  it('--costly: the steps that used the most tokens, with their reports', async () => {
    const { reportA, reportB, reportC, reportF } = writeFixture();
    expect(await stats({ costly: true, limit: 4 })).toBe(0);
    const title = 'Select "{{title}}" from the Title Select list on the About …';
    expect(out.slice(0, 18)).toEqual([
      'Last 30 days · your runs · all sites · steps by tokens, most first',
      '',
      `2026-09-28 07:13  tests/recording.md  step 11  ${title}`,
      '  20,500 tokens (20,000 in, 500 out; some estimated) · 3 calls · 2 attempts · failed',
      `  report: ${reportB} (report deleted)`,
      '',
      `2026-09-20 09:16  tests/recording.md  step 11  ${title}`,
      '  9,300 tokens (9,000 in, 300 out) · 2 calls · 1 attempt · passed after a failed action',
      link(reportA, 'step-11'),
      '',
      `2026-09-10 11:01  tests/recording.md  step 11  ${title}`,
      '  8,250 tokens (8,000 in, 250 out) · 2 calls · 1 attempt · passed after a failed action',
      link(reportF, 'step-11'),
      '',
      '2026-09-28 09:33  tests/signup-rows.md  row 2, step 2  Click Create account',
      '  7,600 tokens (7,400 in, 200 out) · 2 calls · 2 attempts · failed',
      link(reportC, 'row-2-step-2'),
      '',
    ]);
    expect(out).toContain('Showing 4 of 17. --limit 17 shows them all.');
  });

  it('--json: the same result, structured, with the report path and anchor kept apart', async () => {
    const { reportC } = writeFixture();
    expect(await stats({ json: true, by: 'site' })).toBe(0);
    expect(out).toHaveLength(1);
    const result = JSON.parse(out[0]!);
    expect(result).toMatchObject({
      view: 'summary',
      window: { since: '2026-08-30T10:00:00.000Z', until: null, timeZone: 'UTC' },
      filters: { suites: ['user'], sources: ['ai'], site: null, model: null, test: null },
      dir: statsDir(),
      recording: true,
      lines: {
        skipped: 1,
        inWindow: { actions: 24, steps: 19 },
        matched: { actions: 23, steps: 17 },
        leftOut: {
          suites: { live: { actions: 1, steps: 1 } },
          sources: { code: { actions: 0, steps: 1 } },
          filters: { actions: 0, steps: 0 },
        },
      },
      pruned: [path.join(statsDir(), 'actions-2026-01.jsonl')],
      warnings: [],
      summary: { by: 'site', steps: { executed: 17, firstTry: 9, afterRetry: 1, afterFailedAction: 3, failed: 4, estimated: true } },
    });
    expect(result.summary.groups.map((group: { key: string }) => group.key)).toEqual(['www.super.test', 'localhost:8787', 'example.org']);
    expect(result).not.toHaveProperty('modelsInWindow');

    out = [];
    expect(await stats({ json: true, failures: true, limit: 5 })).toBe(0);
    const failures = JSON.parse(out.join('\n'));
    expect(failures.view).toBe('failures');
    expect(failures.failures.total).toBe(10);
    expect(failures.failures.entries.map((entry: { report: { state: string } }) => entry.report.state)).toEqual([
      'pending',
      'linked',
      'linked',
      'linked',
      'linked',
    ]);
    expect(failures.failures.entries[2]).toMatchObject({
      row: 2,
      step: 2,
      attempt: 2,
      outcome: 'timeout',
      report: { state: 'linked', path: reportC, anchor: 'row-2-step-2', href: `${pathToFileURL(reportC).href}#row-2-step-2` },
    });
    // A hook step says which line of its scope it is.
    expect(failures.failures.entries[4]).toMatchObject({
      step: 0,
      row: 1,
      hook: 'before',
      hookIndex: 2,
      report: { anchor: 'row-1-hook-before-2-step-0' },
    });

    out = [];
    expect(await stats({ json: true, costly: true, limit: 1 })).toBe(0);
    expect(JSON.parse(out.join('\n')).costly).toMatchObject({ total: 17, entries: [{ tokens: 20500, estimated: true, report: { state: 'deleted' } }] });
  });

  it('--suite, --source, --since and --until change what counts, and the heading says so', async () => {
    writeFixture();
    expect(await stats({ suite: 'live' })).toBe(0);
    expect(out[0]).toBe('Last 30 days · live suite · all sites');
    expect(out).toContain('Steps: 1 run · 100% passed first try · 0% after a retry · 0% failed');

    out = [];
    expect(await stats({ source: 'code' })).toBe(0);
    expect(out.slice(0, 5)).toEqual([
      'Last 30 days · your runs · code-behind replays · all sites',
      '',
      'No actions: these steps chose none.',
      '',
      'Steps: 1 run · 100% passed first try · 0% after a retry · 0% failed',
    ]);

    out = [];
    expect(await stats({ since: '2026-09-28', until: '2026-09-28', suite: 'user,live,bench,compile', source: 'ai,code', site: 'super', by: 'outcome' })).toBe(0);
    expect(out.slice(0, 6)).toEqual([
      'On 2026-09-28 · all runs · AI and code-behind · sites matching super',
      '',
      'Outcome    Actions   Share',
      'no-match         3     75%',
      'ok               1     25%',
      '',
    ]);

    out = [];
    expect(await stats({ since: '60d', test: 'recording' })).toBe(0);
    expect(out[0]).toBe('Last 60 days · your runs · all sites · tests matching recording');
    // The line from 40 days ago is in a 60-day window.
    expect(out).toContain('#id                        1           100%');

    out = [];
    expect(await stats({ model: 'OpenAI/GPT-6-Luna', costly: true })).toBe(0);
    expect(out[0]).toBe('Last 30 days · your runs · all sites · model OpenAI/GPT-6-Luna · steps by tokens, most first');
  });

  it('a failure whose run line came after --until still links to its report', async () => {
    const { reportC } = writeFixture();
    // C's step 2 failed at 09:32; its run ended, and wrote its run line, at 09:33:30.
    expect(await stats({ failures: true, since: '2026-09-28 09:31', until: '2026-09-28 09:33' })).toBe(0);
    expect(out.filter((line) => line.startsWith('  report:'))).toEqual([
      link(reportC, 'row-2-step-2'),
      link(reportC, 'row-2-step-2'),
    ]);
  });

  it('nothing recorded yet: where the lines live, and that recording is on', async () => {
    expect(await stats()).toBe(0);
    expect(out).toEqual([
      'Last 30 days · your runs · all sites',
      '',
      'Nothing recorded yet.',
      `Every run keeps a line per AI action and step in ${statsDir()}, one file a month.`,
      `Recording is on. STEPTIX_STATS=off in ${path.join(tmp, 'steptix', '.env')} turns it off for the whole machine.`,
    ]);
    expect(err).toEqual([]);
  });

  it('--json with nothing recorded is still JSON', async () => {
    expect(await stats({ json: true })).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({
      view: 'summary',
      dir: statsDir(),
      recording: true,
      lines: { read: 0, skipped: 0, inWindow: { actions: 0, steps: 0 } },
      summary: { groups: [], steps: { executed: 0, tokensPerStep: null } },
    });
  });

  it('a stats folder that cannot be read is an error, not an empty month', async () => {
    fs.mkdirSync(path.join(tmp, 'steptix'), { recursive: true });
    fs.writeFileSync(statsDir(), 'a file where the folder should be');
    expect(await stats()).toBe(1);
    expect(err.join('\n')).toContain(`could not read ${statsDir()}`);
    expect(out).toEqual([]);
  });

  it('nothing in the default window: says the window is the default, and where older months are', async () => {
    writeMonth('2026-08', jsonl([{ v: 1, kind: 'run', t: '2026-08-01T00:00:00.000Z', run: 'r', project: tmp, test: null, suite: 'user', status: 'passed', steps: 0, firstTry: 0, failed: 0, report: null }]));
    machineEnv('STEPTIX_STATS=off\n');
    expect(await stats()).toBe(0);
    expect(out.slice(2)).toEqual([
      'Nothing recorded in the last 30 days, the default window.',
      'Earlier months are on disk, the latest 2026-08: --since 2026-08-01 reaches it.',
      `Every run keeps a line per AI action and step in ${statsDir()}, one file a month.`,
      `Recording is off on this machine: STEPTIX_STATS=off in ${path.join(tmp, 'steptix', '.env')}.`,
    ]);

    // A window the user typed is theirs: no advice about the default.
    out = [];
    expect(await stats({ since: '7d' })).toBe(0);
    expect(out[2]).toBe('Nothing recorded in this window.');
  });

  it('recording is judged by the machine .env; this shell’s own STEPTIX_STATS=off is said apart', async () => {
    writeMonth('2026-08', '');
    expect(await stats({}, { STEPTIX_STATS: 'off' })).toBe(0);
    expect(out[out.length - 1]).toBe(
      'Recording is on for this machine, but STEPTIX_STATS=off in this shell’s environment: runs started from here record nothing.',
    );
    out = [];
    expect(await stats({ json: true }, { STEPTIX_STATS: 'off' })).toBe(0);
    expect(JSON.parse(out.join('\n')).recording).toBe(true);
    machineEnv('STEPTIX_STATS=0\n');
    out = [];
    expect(await stats({ json: true })).toBe(0);
    expect(JSON.parse(out.join('\n')).recording).toBe(false);
  });

  it('empty only because of the defaults: which default hid what, in words', async () => {
    const base = { v: 1, project: tmp, test: 'tests/a.md', step: 1, stepText: 'Click Go' };
    writeMonth(
      '2026-09',
      jsonl([
        { ...base, kind: 'action', run: 'r-live', exec: 1, t: '2026-09-28T10:00:00.000Z', attempt: 1, turn: 1, action: 'click', selector: '#go', form: 'id', outcome: 'ok', ms: 5, suite: 'live', source: 'ai' },
        { ...base, kind: 'step', run: 'r-live', exec: 1, t: '2026-09-28T10:00:01.000Z', status: 'passed', attempts: 1, turns: 1, firstTry: true, ms: 9, calls: 1, tokensIn: 5, tokensOut: 1, suite: 'live', source: 'ai' },
        { ...base, kind: 'step', run: 'r-code', exec: 1, t: '2026-09-28T11:00:00.000Z', status: 'passed', attempts: 1, turns: 0, firstTry: true, ms: 9, calls: 0, tokensIn: 0, tokensOut: 0, suite: 'user', source: 'code' },
      ]),
    );
    expect(await stats()).toBe(0);
    expect(out).toEqual([
      'Last 30 days · your runs · all sites',
      '',
      'Nothing from your own runs’ AI steps in the last 30 days.',
      'By default only those count, which left out:',
      '  1 action and 1 step from the live suite: --suite live shows them',
      '  1 step replayed by code-behind: --source code shows it',
    ]);
  });

  it('nothing matching the filters: which flag left out how much', async () => {
    writeFixture();
    expect(await stats({ site: 'nowhere.example' })).toBe(0);
    expect(out.slice(0, 4)).toEqual([
      'Last 30 days · your runs · sites matching nowhere.example',
      '',
      'Nothing matches these filters.',
      'Of 24 actions and 19 steps in this window, --site left out 23 actions and 17 steps, '
        + 'the default --suite user left out 1 action and 1 step (live) and the default --source ai left out 1 step (code).',
    ]);
  });

  it('--model that matches nothing lists the model ids the window has', async () => {
    writeFixture();
    expect(await stats({ model: 'gpt-6-luna' })).toBe(0);
    expect(out[2]).toBe('Nothing matches these filters.');
    expect(out).toContain('Models in this window: openai/gpt-6-luna, anthropic/claude-x. --model takes the whole id.');

    out = [];
    expect(await stats({ model: 'gpt-6-luna', json: true })).toBe(0);
    expect(JSON.parse(out.join('\n')).modelsInWindow).toEqual(['openai/gpt-6-luna', 'anthropic/claude-x']);
  });

  it('--limit without --failures or --costly is said to do nothing', async () => {
    writeFixture();
    expect(await stats({ limit: 5 })).toBe(0);
    expect(err).toEqual(['Note: --limit counts --failures or --costly entries; the summary shows every group, so it was ignored.']);
    expect(out[0]).toBe('Last 30 days · your runs · all sites');

    err = [];
    out = [];
    expect(await stats({ limit: 5, json: true })).toBe(0);
    expect(JSON.parse(out.join('\n')).warnings).toEqual([
      '--limit counts --failures or --costly entries; the summary shows every group, so it was ignored.',
    ]);

    err = [];
    expect(await stats({ limit: 5, failures: true })).toBe(0);
    expect(err).toEqual([]);
  });

  it('a step with no card in its report: the report itself, and a note saying so', async () => {
    const report = path.join(tmp, 'reports', 'watch run.html');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, '<html></html>');
    const base = { v: 1, project: tmp, test: 'tests/watch.md', suite: 'user', source: 'ai', card: false };
    writeMonth(
      '2026-09',
      jsonl([
        { ...base, kind: 'action', run: 'r-w', exec: 3, t: '2026-09-28T10:00:00.000Z', step: 4, stepText: 'Close the banner', attempt: 1, turn: 1, action: 'click', selector: '#x', form: 'id', outcome: 'timeout', ms: 5 },
        { ...base, kind: 'step', run: 'r-w', exec: 3, t: '2026-09-28T10:00:01.000Z', step: 4, stepText: 'Close the banner', status: 'failed', attempts: 1, turns: 1, firstTry: false, ms: 9, calls: 1, tokensIn: 5, tokensOut: 1 },
        { v: 1, kind: 'run', run: 'r-w', t: '2026-09-28T10:01:00.000Z', project: tmp, test: 'tests/watch.md', suite: 'user', status: 'failed', steps: 1, firstTry: 0, failed: 1, report },
      ]),
    );
    expect(await stats({ failures: true })).toBe(0);
    expect(out[out.length - 1]).toBe(`  report: ${pathToFileURL(report).href} (no card for this step in the report)`);
  });

  it('the outcomes decided by what the action was read as words', async () => {
    const base = { v: 1, project: tmp, test: 'tests/a.md', suite: 'user', source: 'ai', attempt: 1, turn: 1, action: 'assert', selector: null, form: null, ms: 5 };
    writeMonth(
      '2026-09',
      jsonl([
        { ...base, kind: 'action', run: 'r-a', exec: 1, t: '2026-09-28T10:00:00.000Z', step: 1, stepText: 'The total is $10', outcome: 'assert-failed' },
        { ...base, kind: 'action', run: 'r-a', exec: 2, t: '2026-09-28T10:00:10.000Z', step: 2, stepText: 'Pay with the saved card', outcome: 'conceded' },
      ]),
    );
    expect(await stats({ by: 'outcome' })).toBe(0);
    expect(out.slice(2, 5)).toEqual(['Outcome            Actions   Share', 'assertion failed         1     50%', 'model gave up            1     50%']);
    out = [];
    expect(await stats({ failures: true })).toBe(0);
    expect(out).toContain('  assert    model gave up');
    expect(out).toContain('  assert    assertion failed');
  });

  it('a line that is not the shape §5 describes is skipped and counted, never a crash or an undefined', async () => {
    const good = { v: 1, kind: 'action', run: 'r', exec: 1, project: tmp, test: 'tests/a.md', step: 1, t: '2026-09-28T10:00:00.000Z', attempt: 1, turn: 1, action: 'click', selector: '#go', form: 'id', outcome: 'ok', ms: 5, suite: 'user', source: 'ai' };
    const { outcome: _o, ...noOutcome } = good;
    const { suite: _s, ...noSuite } = good;
    writeMonth('2026-09', jsonl([good, noOutcome, noSuite]));
    expect(await stats({ by: 'outcome' })).toBe(0);
    expect(out.join('\n')).not.toContain('undefined');
    expect(out.slice(2, 4)).toEqual(['Outcome   Actions   Share', 'ok              1    100%']);
    expect(out).toContain('Note: skipped 2 lines that could not be read.');
  });

  it('whatever goes wrong inside is reported with exit 1, never thrown', async () => {
    writeFixture();
    // A zone Intl does not know throws the first time a date is printed —
    // long after the flags were checked.
    await expect(statsCommand({ failures: true }, { deps: deps(), now: NOW, timeZone: 'Nowhere/Invalid' })).resolves.toBe(1);
    expect(err.join('\n')).toMatch(/^Error: .*Nowhere\/Invalid/);
  });

  it('refuses a bad flag with exit 1 and prints nothing else', async () => {
    const cases: Array<[StatsOptions, RegExp]> = [
      [{ by: 'colour' }, /--by colour: expected one of form, site, model, prompt, test, outcome/],
      [{ by: 'site', failures: true }, /--by and --failures each choose what to show; pick one/],
      [{ failures: true, costly: true }, /--failures and --costly/],
      [{ since: 'yesterday' }, /--since yesterday: not a time/],
      [{ since: '2026-02-30' }, /--since 2026-02-30: there is no such date/],
      [{ since: '2d', until: '3d' }, /--until 3 days ago is not after --since 2 days ago/],
      [{ since: '0d' }, /--since 0d: a span is at least 1 day/],
      [{ until: '0h' }, /--until 0h: a span is at least 1 hour/],
      [{ since: '200000000d', json: true }, /--since 200000000d: that is further back than a date can go/],
      [{ until: '99999999w' }, /--until 99999999w: that is further back than a date can go/],
      [{ suite: 'user,nightly' }, /--suite nightly: expected one or more of user, live, bench, compile/],
      [{ source: ' , ' }, /--source names nothing/],
      [{ limit: 0 }, /--limit/],
    ];
    for (const [opts, message] of cases) {
      err = [];
      out = [];
      expect(await stats(opts), JSON.stringify(opts)).toBe(1);
      expect(err.join('\n'), JSON.stringify(opts)).toMatch(message);
      expect(out, JSON.stringify(opts)).toEqual([]);
    }
  });
});

describe('retention, from steptix stats (§6.3)', () => {
  const monthFiles = () => fs.readdirSync(statsDir()).filter((name) => name.endsWith('.jsonl')).sort();

  it('a bad flag prunes nothing: the flags are checked before anything is touched', async () => {
    writeFixture();
    expect(await stats({ since: 'yesterday' })).toBe(1);
    expect(monthFiles()).toContain('actions-2026-01.jsonl');
  });

  it('a read that fails prunes nothing: the read comes first', async () => {
    writeMonth('2026-01', '');
    // A folder where September's file should be: listing works, reading fails.
    fs.mkdirSync(path.join(statsDir(), 'actions-2026-09.jsonl'));
    expect(await stats()).toBe(1);
    expect(err.join('\n')).toContain('could not read');
    expect(monthFiles()).toContain('actions-2026-01.jsonl');
  });

  it('asking about an old month shows it and does not delete it', async () => {
    const base = { v: 1, project: tmp, test: 'tests/a.md', suite: 'user', source: 'ai', attempt: 1, turn: 1, action: 'click', selector: '#go', form: 'id', ms: 5, step: 1, stepText: 'Click Go' };
    writeMonth('2025-12', jsonl([{ ...base, kind: 'action', run: 'r-dec', exec: 1, t: '2025-12-15T10:00:00.000Z', outcome: 'ok' }]));
    writeMonth('2026-01', jsonl([{ ...base, kind: 'action', run: 'r-jan', exec: 1, t: '2026-01-15T10:00:00.000Z', outcome: 'no-match' }]));
    writeMonth('2026-02', jsonl([{ ...base, kind: 'action', run: 'r-feb', exec: 1, t: '2026-02-15T10:00:00.000Z', outcome: 'ok' }]));
    expect(await stats({ since: '2026-01-01', until: '2026-01-31' })).toBe(0);
    expect(out[0]).toBe('2026-01-01 to 2026-01-31 · your runs · all sites');
    expect(out).toContain('#id                   1             0%   no-match (1)');
    // January is the window and February comes after it: both kept, though
    // both are older than six months. December goes.
    expect(monthFiles()).toEqual(['actions-2026-01.jsonl', 'actions-2026-02.jsonl']);
    expect(out[out.length - 1]).toBe('Note: removed 1 month file older than 6 months.');
  });

  it('keeps as many months as the machine .env says, whatever this shell says', async () => {
    writeFixture();
    // This shell asks for one month: ignored, or it would delete August.
    expect(await stats({}, { STEPTIX_STATS_RETAIN_MONTHS: '1' })).toBe(0);
    expect(monthFiles()).toEqual(['actions-2026-08.jsonl', 'actions-2026-09.jsonl']);
    // The machine asks for twelve: January stays.
    writeMonth('2026-01', '');
    machineEnv('STEPTIX_STATS_RETAIN_MONTHS=12\n');
    out = [];
    expect(await stats()).toBe(0);
    expect(monthFiles()).toEqual(['actions-2026-01.jsonl', 'actions-2026-08.jsonl', 'actions-2026-09.jsonl']);
  });
});

describe('parseWhen: --since and --until', () => {
  it('a span back from now', () => {
    expect(parseWhen('24h', '--since', NOW, 'UTC')).toEqual({ at: new Date('2026-09-28T10:00:00.000Z'), text: '24 hours ago', span: '24 hours' });
    expect(parseWhen('1d', '--since', NOW, 'UTC')).toMatchObject({ text: '1 day ago', span: '1 day' });
    expect(parseWhen(' 2W ', '--since', NOW, 'UTC').at).toEqual(new Date('2026-09-15T10:00:00.000Z'));
  });

  it('a span is at least 1, and never runs off the calendar', () => {
    expect(() => parseWhen('0d', '--since', NOW, 'UTC')).toThrow(/--since 0d: a span is at least 1 day/);
    expect(() => parseWhen('000w', '--until', NOW, 'UTC')).toThrow(/--until 000w: a span is at least 1 week/);
    expect(() => parseWhen('200000000d', '--since', NOW, 'UTC')).toThrow(/further back than a date can go/);
    expect(() => parseWhen(`${'9'.repeat(400)}h`, '--since', NOW, 'UTC')).toThrow(/further back than a date can go/);
    // The furthest a span can reach still parses.
    expect(parseWhen('100000000d', '--since', NOW, 'UTC').at.getTime()).toBe(NOW.getTime() - 100000000 * 86400000);
  });

  it('a date is a whole day where you are: --since from its first moment, --until through its last', () => {
    expect(parseWhen('2026-09-01', '--since', NOW, 'UTC')).toEqual({ at: new Date('2026-09-01T00:00:00.000Z'), text: '2026-09-01' });
    expect(parseWhen('2026-09-01', '--until', NOW, 'UTC')).toEqual({ at: new Date('2026-09-02T00:00:00.000Z'), text: '2026-09-01' });
    expect(parseWhen('2026-09-30', '--until', NOW, 'UTC').at).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    // Sydney is UTC+10 in September, and UTC+11 once daylight saving starts
    // (02:00 on 4 October 2026).
    expect(parseWhen('2026-09-01', '--since', NOW, 'Australia/Sydney').at).toEqual(new Date('2026-08-31T14:00:00.000Z'));
    expect(parseWhen('2026-10-04', '--since', NOW, 'Australia/Sydney').at).toEqual(new Date('2026-10-03T14:00:00.000Z'));
    expect(parseWhen('2026-10-05', '--since', NOW, 'Australia/Sydney').at).toEqual(new Date('2026-10-04T13:00:00.000Z'));
  });

  it('a date and time where you are, or an instant with its own offset', () => {
    expect(parseWhen('2026-09-28 07:30', '--since', NOW, 'UTC')).toEqual({ at: new Date('2026-09-28T07:30:00.000Z'), text: '2026-09-28 07:30' });
    expect(parseWhen('2026-09-28T17:30', '--since', NOW, 'Australia/Sydney').at).toEqual(new Date('2026-09-28T07:30:00.000Z'));
    expect(parseWhen('2026-09-28T17:30:00+10:00', '--since', NOW, 'UTC')).toEqual({ at: new Date('2026-09-28T07:30:00.000Z'), text: '2026-09-28 07:30' });
    expect(parseWhen('2026-09-28T07:30:00Z', '--until', NOW, 'UTC').at).toEqual(new Date('2026-09-28T07:30:00.000Z'));
  });

  it('refuses anything else', () => {
    for (const value of ['yesterday', '7', '7x', '2026-9-1', '2026-13-01', '2026-02-29', '2026-09-28 24:00', '']) {
      expect(() => parseWhen(value, '--since', NOW, 'UTC'), value).toThrow(/--since/);
    }
  });
});

describe('the stats command in the CLI', () => {
  /** Point the environment's user root at `tmp` for the length of `body`. */
  async function withUserRoot<T>(body: () => Promise<T>): Promise<T> {
    const saved = { LOCALAPPDATA: process.env['LOCALAPPDATA'], XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'], STEPTIX_STATS: process.env['STEPTIX_STATS'] };
    const exitCode = process.exitCode;
    process.env['LOCALAPPDATA'] = tmp;
    process.env['XDG_CONFIG_HOME'] = tmp;
    delete process.env['STEPTIX_STATS'];
    try {
      return await body();
    } finally {
      process.exitCode = exitCode;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('is registered with its flags, and reads the user root the environment names', async () => {
    await withUserRoot(async () => {
      const { createCli } = await import('../src/cli/index.js');
      const program = createCli();
      const command = program.commands.find((c) => c.name() === 'stats');
      expect(command).toBeDefined();
      expect(command!.options.map((option) => option.long)).toEqual(
        expect.arrayContaining(['--since', '--until', '--site', '--model', '--test', '--suite', '--source', '--by', '--failures', '--costly', '--limit', '--json']),
      );

      const now = new Date();
      const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      const t = new Date(now.getTime() - 60_000).toISOString();
      writeMonth(month, jsonl([{ v: 1, kind: 'action', t, run: 'r-cli', exec: 1, project: tmp, test: 'tests/a.md', step: 1, stepText: 'Click Go', attempt: 1, turn: 1, action: 'click', selector: '#go', form: 'id', outcome: 'no-match', ms: 5, suite: 'user', source: 'ai' }]));

      await program.parseAsync(['stats', '--failures', '--json'], { from: 'user' });
      expect(process.exitCode).toBe(0);
      const result = JSON.parse(out.join('\n'));
      expect(result).toMatchObject({ view: 'failures', dir: statsDir(), failures: { total: 1 } });
      // With no --suite or --source typed, the defaults still apply.
      expect(result.filters).toMatchObject({ suites: ['user'], sources: ['ai'] });
    });
    // The first import of the CLI loads every command's module graph,
    // playwright included: seconds, not milliseconds.
  }, 60_000);

  it('refuses a --limit that is not a whole number of at least 1', async () => {
    await withUserRoot(async () => {
      const { createCli } = await import('../src/cli/index.js');
      const command = createCli().commands.find((c) => c.name() === 'stats')!;
      const written: string[] = [];
      command.exitOverride().configureOutput({ writeErr: (text) => written.push(text), writeOut: () => {} });
      await expect(command.parseAsync(['--limit', '0'], { from: 'user' })).rejects.toThrow();
      expect(written.join('')).toMatch(/--limit.*whole number of at least 1/);
    });
  }, 60_000);

  it('a bad span through the real CLI is exit 1 and a message, not a rejection', async () => {
    await withUserRoot(async () => {
      const { createCli } = await import('../src/cli/index.js');
      await expect(createCli().parseAsync(['stats', '--since', '200000000d', '--json'], { from: 'user' })).resolves.toBeDefined();
      expect(process.exitCode).toBe(1);
      expect(err.join('\n')).toMatch(/further back than a date can go/);
    });
  }, 60_000);
});
