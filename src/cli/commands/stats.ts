import fs from 'node:fs';
import chalk from 'chalk';
import { InvalidArgumentError, type Command } from 'commander';
import { parseBoolEnv } from '../../env/loader.js';
import { userRootEnvPath, type UserRootDeps } from '../../env/user-root.js';
import {
  DEFAULT_WINDOW_DAYS,
  listCostly,
  listFailures,
  selectStatsLines,
  STATS_GROUP_BYS,
  STATS_SOURCES,
  STATS_SUITES,
  STEP_GROUP_BYS,
  summarizeStats,
  wholePercents,
  type CostlyEntry,
  type FailureEntry,
  type LineCounts,
  type ReportExists,
  type ReportLink,
  type StatsGroup,
  type StatsGroupBy,
  type StatsList,
  type StatsQuery,
  type StatsSelection,
  type StatsSummary,
  type StepStats,
} from '../../stats/aggregate.js';
import {
  listStatsMonths,
  pruneStatsFiles,
  readStatsLines,
  statsDir,
  statsSettings,
  type StatsMonthFile,
} from '../../stats/store.js';
import type { SelectorForm, StatsSource, StatsSuite } from '../../stats/types.js';

/**
 * `steptix stats`: the scoreboard, read (docs/specs/SPEC-scoreboard.md §9).
 *
 * Reads `<user root>/stats/`, prints one table and the steps and cost lines,
 * or one of two lists — failed actions, costly steps — each entry linked to
 * the report that shows why. The arithmetic is `src/stats/aggregate.ts`; this
 * file parses the flags, reads the files and lays the numbers out.
 */

export interface StatsOptions {
  since?: string | undefined;
  until?: string | undefined;
  site?: string | undefined;
  model?: string | undefined;
  test?: string | undefined;
  suite?: string | undefined;
  source?: string | undefined;
  by?: string | undefined;
  failures?: boolean | undefined;
  costly?: boolean | undefined;
  limit?: number | undefined;
  json?: boolean | undefined;
}

/** What a test swaps out. The command itself passes none of these. */
export interface StatsSeams {
  /** The user root, so a test never reads the real one. */
  deps?: UserRootDeps | undefined;
  now?: Date | undefined;
  /** The zone dates are read and shown in; the system's by default. */
  timeZone?: string | undefined;
  /** Whether a report is still on disk; `fs.existsSync` by default. */
  reportExists?: ReportExists | undefined;
}

/** Entries `--failures` and `--costly` show when `--limit` is not given. */
export const DEFAULT_LIST_LIMIT = 20;

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('Expected a whole number of at least 1.');
  }
  return parsed;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('How often each AI action worked the first time, from this machine’s scoreboard')
    .option('--since <when>', `Start of the window: 24h, 7d, 2w or a date such as 2026-09-01 (default: ${DEFAULT_WINDOW_DAYS}d)`)
    .option('--until <when>', 'End of the window, in the same forms; a date includes that whole day')
    .option('--site <host>', 'Only actions on pages whose host contains this')
    .option('--model <id>', 'Only actions this model chose (the whole id, any case)')
    .option('--test <path>', 'Only tests whose path contains this')
    // No commander defaults on these three: the command tells a value the user
    // typed from its default, to say which default hid what.
    .option('--suite <list>', 'Which runs count, comma-separated: user, live, bench, compile (default: user)')
    .option('--source <list>', 'What drove the steps, comma-separated: ai, code (default: ai)')
    .option('--by <what>', `Group by ${STATS_GROUP_BYS.join(', ')} (default: form)`)
    .option('--failures', 'List the failed actions, newest first, with a link to each report')
    .option('--costly', 'List the steps that used the most tokens, with a link to each report')
    .option('--limit <n>', `How many --failures or --costly entries to show (default: ${DEFAULT_LIST_LIMIT})`, positiveInt)
    .option('--json', 'Print the result as JSON')
    .action(async (opts: StatsOptions) => {
      // `createCli().parse()` does not await an action (src/index.ts), so a
      // rejection here would surface as an unhandled one with a stack trace.
      // statsCommand catches its own; this is the last net.
      try {
        // Not `process.exit()`: a long table or JSON document written to a
        // pipe is still draining when this returns, and exiting would cut it
        // off.
        process.exitCode = await statsCommand(opts);
      } catch (err) {
        console.error(chalk.red(`Error: ${messageOf(err)}`));
        process.exitCode = 1;
      }
    });
}

// ── Time ─────────────────────────────────────────────────────────────────────
//
// The lines are stamped in UTC. People think in their own days, so a date on
// the command line is midnight where they are, and a time printed back is in
// the same zone. Tests pin the zone; the command uses the system's.

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(ms: number, timeZone: string): ZonedParts {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  const value: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of format.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') value[part.type] = Number(part.value);
  }
  return {
    year: value.year ?? 1970,
    month: value.month ?? 1,
    day: value.day ?? 1,
    hour: (value.hour ?? 0) % 24,
    minute: value.minute ?? 0,
    second: value.second ?? 0,
  };
}

/** How far `timeZone`'s clock is ahead of UTC at the instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const p = partsIn(ms, timeZone);
  const wholeSecond = ms - (((ms % 1000) + 1000) % 1000);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSecond;
}

/** The instant a wall clock in `timeZone` shows this time. Asked twice, so a
 *  time near a daylight-saving change settles on the offset in force then. */
function zonedTime(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = wall - offsetAt(wall, timeZone);
  return new Date(wall - offsetAt(first, timeZone));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDate(ms: number, timeZone: string): string {
  const p = partsIn(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function formatDateTime(ms: number, timeZone: string): string {
  const p = partsIn(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** A date alone when the moment is midnight, else the date and the time. */
function formatMoment(ms: number, timeZone: string): string {
  const p = partsIn(ms, timeZone);
  return p.hour === 0 && p.minute === 0 && p.second === 0 && ms % 1000 === 0
    ? formatDate(ms, timeZone)
    : formatDateTime(ms, timeZone);
}

/** `09-28`, with the year only when it is not this one. */
function formatMonthDay(ms: number, timeZone: string, now: Date): string {
  const p = partsIn(ms, timeZone);
  const md = `${pad(p.month)}-${pad(p.day)}`;
  return p.year === partsIn(now.getTime(), timeZone).year ? md : `${p.year}-${md}`;
}

/** One end of the window, and how the header names it. */
export interface When {
  at: Date;
  /** `2026-09-01`, `7 days ago`. */
  text: string;
  /** For a relative moment, the span back from now: `7 days`. */
  span?: string;
}

const UNITS: Record<string, readonly [string, number]> = {
  h: ['hour', 60 * 60 * 1000],
  d: ['day', 24 * 60 * 60 * 1000],
  w: ['week', 7 * 24 * 60 * 60 * 1000],
};

/** The instant `ms`, or an error naming the flag when it is not one a `Date`
 *  can hold (a span so long it runs off the calendar). */
function instant(ms: number, flag: string, value: string): Date {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`${flag} ${value}: that is further back than a date can go. Use a shorter span, or a date such as 2026-09-01.`);
  }
  return at;
}

/**
 * `--since` / `--until`: a span back from now (`24h`, `7d`, `2w`), a date
 * (`2026-09-01`), a date and time (`2026-09-01 07:30`), all read in
 * `timeZone`, or an ISO instant that names its own offset.
 *
 * A span is at least 1 of its unit. A bare date is a whole day: `--since`
 * starts at its first moment and `--until` ends after its last, so
 * `--since 2026-09-01 --until 2026-09-28` includes the 28th.
 */
export function parseWhen(value: string, flag: '--since' | '--until', now: Date, timeZone: string): When {
  const text = value.trim();
  const relative = /^(\d+)\s*([hdw])$/i.exec(text);
  if (relative) {
    const n = Number(relative[1]);
    const [unit, ms] = UNITS[relative[2]!.toLowerCase()]!;
    if (!(n >= 1)) throw new Error(`${flag} ${value}: a span is at least 1 ${unit}.`);
    const span = `${n} ${unit}${n === 1 ? '' : 's'}`;
    return { at: instant(now.getTime() - n * ms, flag, value), text: `${span} ago`, span };
  }

  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (local) {
    const [y, mo, d] = [Number(local[1]), Number(local[2]), Number(local[3])];
    const [h, mi, s] = [Number(local[4] ?? 0), Number(local[5] ?? 0), Number(local[6] ?? 0)];
    const real =
      mo >= 1 && mo <= 12
      && new Date(Date.UTC(y, mo - 1, d)).getUTCDate() === d
      && h <= 23 && mi <= 59 && s <= 59;
    if (!real) throw new Error(`${flag} ${value}: there is no such date.`);
    const date = `${local[1]}-${local[2]}-${local[3]}`;
    if (local[4] === undefined) {
      return { at: zonedTime(y, mo, flag === '--until' ? d + 1 : d, 0, 0, 0, timeZone), text: date };
    }
    return { at: zonedTime(y, mo, d, h, mi, s, timeZone), text: `${date} ${local[4]}:${local[5]}` };
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) return { at: new Date(ms), text: formatMoment(ms, timeZone) };
  }

  throw new Error(`${flag} ${value}: not a time. Use 24h, 7d, 2w, or a date such as 2026-09-01.`);
}

function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ── Flags ────────────────────────────────────────────────────────────────────

type StatsView = 'summary' | 'failures' | 'costly';

/** The filter flags the user typed. Anything not typed is its default, and a
 *  view left empty by defaults alone is explained differently (§9). */
interface Typed {
  window: boolean;
  suite: boolean;
  source: boolean;
  site: boolean;
  model: boolean;
  test: boolean;
}

interface Plan {
  view: StatsView;
  by: StatsGroupBy;
  limit: number;
  query: StatsQuery;
  since: When;
  until: When | undefined;
  typed: Typed;
  /** Said on stderr, and kept in `--json`: nothing is wrong, but a flag did
   *  nothing. */
  warnings: string[];
}

function parseList<T extends string>(value: string | undefined, allowed: readonly T[], flag: string, fallback: T[]): T[] {
  if (value === undefined) return fallback;
  const picked: T[] = [];
  for (const raw of value.split(',')) {
    const item = raw.trim().toLowerCase();
    if (item === '') continue;
    if (!(allowed as readonly string[]).includes(item)) {
      throw new Error(`${flag} ${raw.trim()}: expected one or more of ${allowed.join(', ')}, separated by commas.`);
    }
    if (!picked.includes(item as T)) picked.push(item as T);
  }
  if (picked.length === 0) throw new Error(`${flag} names nothing: expected one or more of ${allowed.join(', ')}.`);
  return picked;
}

function filterValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function planFrom(opts: StatsOptions, now: Date, timeZone: string): Plan {
  const views = [
    opts.by !== undefined ? '--by' : undefined,
    opts.failures === true ? '--failures' : undefined,
    opts.costly === true ? '--costly' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (views.length > 1) throw new Error(`${views.join(' and ')} each choose what to show; pick one.`);
  const view: StatsView = opts.failures === true ? 'failures' : opts.costly === true ? 'costly' : 'summary';

  let by: StatsGroupBy = 'form';
  if (opts.by !== undefined) {
    const wanted = opts.by.trim().toLowerCase();
    if (!(STATS_GROUP_BYS as readonly string[]).includes(wanted)) {
      throw new Error(`--by ${opts.by}: expected one of ${STATS_GROUP_BYS.join(', ')}.`);
    }
    by = wanted as StatsGroupBy;
  }

  const until = opts.until === undefined ? undefined : parseWhen(opts.until, '--until', now, timeZone);
  let since: When;
  if (opts.since !== undefined) {
    since = parseWhen(opts.since, '--since', now, timeZone);
  } else if (until === undefined) {
    const span = `${DEFAULT_WINDOW_DAYS} days`;
    since = { at: new Date(now.getTime() - DEFAULT_WINDOW_DAYS * UNITS['d']![1]), text: `${span} ago`, span };
  } else {
    // The same 30 days, ending where the window was asked to end.
    const at = instant(until.at.getTime() - DEFAULT_WINDOW_DAYS * UNITS['d']![1], '--until', opts.until!);
    since = { at, text: formatMoment(at.getTime(), timeZone) };
  }
  if (until !== undefined && until.at.getTime() <= since.at.getTime()) {
    throw new Error(`--until ${until.text} is not after --since ${since.text}.`);
  }

  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit: expected a whole number of at least 1.');
  const warnings: string[] = [];
  if (opts.limit !== undefined && view === 'summary') {
    warnings.push('--limit counts --failures or --costly entries; the summary shows every group, so it was ignored.');
  }

  const query: StatsQuery = {
    since: since.at,
    until: until?.at,
    suites: parseList<StatsSuite>(opts.suite, STATS_SUITES, '--suite', ['user']),
    sources: parseList<StatsSource>(opts.source, STATS_SOURCES, '--source', ['ai']),
    site: filterValue(opts.site),
    model: filterValue(opts.model),
    test: filterValue(opts.test),
  };
  return {
    view,
    by,
    limit,
    since,
    until,
    query,
    typed: {
      window: opts.since !== undefined || opts.until !== undefined,
      suite: opts.suite !== undefined,
      source: opts.source !== undefined,
      site: query.site !== undefined,
      model: query.model !== undefined,
      test: query.test !== undefined,
    },
    warnings,
  };
}

// ── The command ──────────────────────────────────────────────────────────────

/** Whether recording is on, as far as this command can tell (§6.4). */
interface Recording {
  /** From the machine `.env`, the one switch every process on the machine
   *  reads — a server started elsewhere does not see this shell. */
  machine: boolean;
  /** `STEPTIX_STATS=off` in this shell's environment: runs started from here do
   *  not record, whatever the machine says. */
  offInThisShell: boolean;
  /** Months kept (§6.3), from the machine `.env`. */
  retainMonths: number;
}

function recordingFor(deps: UserRootDeps | undefined): Recording {
  const machine = statsSettings({ env: {}, deps });
  const shell = deps?.env ?? process.env;
  return {
    machine: machine.enabled,
    offInThisShell: parseBoolEnv(shell['STEPTIX_STATS']) === false,
    retainMonths: machine.retainMonths,
  };
}

/**
 * Prints the scoreboard and returns the exit code: 0, or 1 for a bad flag, a
 * stats folder that exists and cannot be read, or anything else that went
 * wrong — which is reported, never thrown. Nothing recorded yet is not an
 * error; it prints where the lines would be.
 */
export async function statsCommand(opts: StatsOptions, seams: StatsSeams = {}): Promise<number> {
  try {
    return await runStats(opts, seams);
  } catch (err) {
    console.error(chalk.red(`Error: ${messageOf(err)}`));
    return 1;
  }
}

async function runStats(opts: StatsOptions, seams: StatsSeams): Promise<number> {
  const now = seams.now ?? new Date();
  const timeZone = seams.timeZone ?? systemTimeZone();
  const deps = seams.deps;

  let plan: Plan;
  try {
    plan = planFrom(opts, now, timeZone);
  } catch (err) {
    console.error(chalk.red(`Error: ${messageOf(err)}`));
    return 1;
  }
  for (const warning of plan.warnings) console.error(chalk.yellow(`Note: ${warning}`));

  const dir = statsDir(deps);
  let read: Awaited<ReturnType<typeof readStatsLines>>;
  try {
    // `until` bounds the action and step lines only: a run's line comes when
    // it ends, which can be after the window, and failures link through it.
    read = await readStatsLines({ since: plan.query.since, until: plan.query.until, deps });
  } catch (err) {
    console.error(chalk.red(`Error: could not read ${dir}: ${messageOf(err)}`));
    return 1;
  }

  const selection = selectStatsLines(read.lines, plan.query);
  const exists = seams.reportExists ?? ((file: string) => fs.existsSync(file));
  const listOptions = { limit: plan.limit, reportExists: exists, now };
  const summary = plan.view === 'summary' ? summarizeStats(selection, plan.by) : undefined;
  const failures = plan.view === 'failures' ? listFailures(selection, listOptions) : undefined;
  const costly = plan.view === 'costly' ? listCostly(selection, listOptions) : undefined;

  const recording = recordingFor(deps);
  // §6.3: old months go at every start of `steptix stats`, as at the server's —
  // but only once the read is done, and never a month from the start of the
  // window on, so asking about an old month is not what deletes it.
  const pruned = await pruneStatsFiles({ retainMonths: recording.retainMonths, now, deps, keepFrom: plan.query.since });

  if (opts.json === true) {
    console.log(
      JSON.stringify(
        {
          view: plan.view,
          window: { since: plan.query.since.toISOString(), until: plan.query.until?.toISOString() ?? null, timeZone },
          filters: {
            suites: plan.query.suites,
            sources: plan.query.sources,
            site: plan.query.site ?? null,
            model: plan.query.model ?? null,
            test: plan.query.test ?? null,
          },
          dir,
          recording: recording.machine,
          lines: {
            read: read.lines.length,
            skipped: read.skipped,
            inWindow: selection.inWindow,
            matched: { actions: selection.actions.length, steps: selection.steps.length },
            leftOut: selection.leftOut,
          },
          ...(plan.query.model !== undefined && { modelsInWindow: selection.models.map((entry) => entry.model) }),
          pruned,
          warnings: plan.warnings,
          ...(summary !== undefined && { summary }),
          ...(failures !== undefined && { failures }),
          ...(costly !== undefined && { costly }),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const out: string[] = [];
  if (selection.actions.length === 0 && selection.steps.length === 0) {
    const months = await listStatsMonths(deps).catch((): StatsMonthFile[] => []);
    out.push(...renderNothing({ plan, selection, dir, recording, months, deps }));
  } else if (summary !== undefined) {
    out.push(...renderSummary(summary, plan, timeZone, now));
  } else if (failures !== undefined) {
    out.push(...renderFailures(failures, plan, timeZone));
  } else if (costly !== undefined) {
    out.push(...renderCostly(costly, plan, timeZone));
  }
  out.push(...renderNotes(read.skipped, pruned.length, recording.retainMonths));
  for (const line of out) console.log(line);
  return 0;
}

// ── Laying it out ────────────────────────────────────────────────────────────

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const NONE = '—';
const GAP = '   ';

function num(n: number): string {
  return NUMBER.format(Math.round(n));
}

function pct(rate: number | null): string {
  return rate === null ? NONE : `${Math.round(rate * 100)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

function joinAnd(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `12 actions and 5 steps`, `1 step`. */
function describeLines(counts: LineCounts): string {
  const parts: string[] = [];
  if (counts.actions > 0) parts.push(plural(counts.actions, 'action'));
  if (counts.steps > 0) parts.push(plural(counts.steps, 'step'));
  return parts.length === 0 ? 'nothing' : joinAnd(parts);
}

/** Columns padded to their widest cell, numbers to the right. */
function table(header: string[], rows: string[][], align: Array<'l' | 'r'>): string[] {
  const widths = header.map((title, i) => rows.reduce((width, row) => Math.max(width, (row[i] ?? '').length), title.length));
  const render = (cells: string[]): string =>
    cells
      .map((cell, i) => (align[i] === 'r' ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
      .join(GAP)
      .trimEnd();
  return [render(header), ...rows.map(render)];
}

const SUITE_WORDS: Record<StatsSuite, string> = {
  user: 'your runs',
  live: 'live suite',
  bench: 'bench',
  compile: 'compile runs',
};

/** Where a line the default view hides came from, as a person would say it. */
const SUITE_FROM: Record<string, string> = {
  user: 'from your own runs',
  live: 'from the live suite',
  bench: 'from the bench',
  compile: 'from compile runs',
};

const SOURCE_FROM: Record<string, string> = {
  ai: 'driven by the model',
  code: 'replayed by code-behind',
};

/** `Last 30 days · your runs · all sites`: what the numbers below cover. */
function describeScope(plan: Plan): string {
  const { query, since, until } = plan;
  const window = until === undefined
    ? since.span !== undefined ? `Last ${since.span}` : `Since ${since.text}`
    : since.text === until.text ? `On ${since.text}` : `${since.text} to ${until.text}`;
  const parts = [window.charAt(0).toUpperCase() + window.slice(1)];
  parts.push(
    query.suites.length === STATS_SUITES.length ? 'all runs' : query.suites.map((suite) => SUITE_WORDS[suite]).join(' + '),
  );
  if (!(query.sources.length === 1 && query.sources[0] === 'ai')) {
    parts.push(query.sources.length === 1 ? 'code-behind replays' : 'AI and code-behind');
  }
  parts.push(query.site === undefined ? 'all sites' : `sites matching ${query.site}`);
  if (query.model !== undefined) parts.push(`model ${query.model}`);
  if (query.test !== undefined) parts.push(`tests matching ${query.test}`);
  return parts.join(' · ');
}

const FORM_LABELS: Record<SelectorForm, string> = {
  role: 'role=',
  'css-role-name': '[role][name] (CSS)',
  'text-is': ':text-is',
  'has-text': ':has-text',
  'text-engine': 'text=',
  testid: 'data-testid',
  'aria-label': '[aria-label]',
  id: '#id',
  'name-attr': '[name]',
  href: 'a[href]',
  positional: 'nth (positional)',
  ref: 'snapshot ref',
  'css-other': 'other CSS',
};

/**
 * The two outcomes decided by what the action WAS rather than by Playwright's
 * error text (§5.4) read badly as bare ids; the rest are the ids §1 shows.
 */
const OUTCOME_LABELS: Record<string, string> = {
  'assert-failed': 'assertion failed',
  conceded: 'model gave up',
};

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

const FIRST_COLUMN: Record<StatsGroupBy, string> = {
  form: 'Selector form',
  site: 'Site',
  model: 'Model',
  prompt: 'Rules version',
  test: 'Test',
  outcome: 'Outcome',
};

const NO_KEY: Record<StatsGroupBy, string> = {
  form: '(no selector)',
  site: '(no site)',
  model: '(no model)',
  prompt: '(no fingerprint)',
  test: '(ad hoc steps)',
  outcome: '(none)',
};

function keyLabel(summary: StatsSummary, group: StatsGroup): string {
  if (group.key === null) {
    if (group.keyless === 'imported') return '(imported, no fingerprint)';
    if (group.keyless === 'not-step-prompt') return '(not the step prompt)';
    return NO_KEY[summary.by];
  }
  if (summary.by === 'form') return FORM_LABELS[group.key as SelectorForm] ?? group.key;
  if (summary.by === 'outcome') return outcomeLabel(group.key);
  return group.key;
}

/**
 * Each group's first-column text. A rules version also says when it was in
 * use, so "did the change help" can be read against the date of the change:
 * the first version runs "to" its last day, the current one "from" its first,
 * and any in between shows both.
 */
function groupLabels(summary: StatsSummary, timeZone: string, now: Date): Map<StatsGroup, string> {
  const labels = new Map<StatsGroup, string>();
  for (const group of summary.groups) labels.set(group, keyLabel(summary, group));
  if (summary.by !== 'prompt') return labels;

  const timeline = summary.groups.filter((group) => group.key !== null);
  if (timeline.length < 2) return labels;
  const earliest = timeline[0]!;
  const current = timeline.reduce((a, b) => (Date.parse(b.lastSeen) > Date.parse(a.lastSeen) ? b : a));
  for (const group of timeline) {
    const from = group === earliest ? undefined : formatMonthDay(Date.parse(group.firstSeen), timeZone, now);
    const to = group === current ? undefined : formatMonthDay(Date.parse(group.lastSeen), timeZone, now);
    const when = from !== undefined && to !== undefined ? `${from} to ${to}` : from !== undefined ? `from ${from}` : to !== undefined ? `to ${to}` : undefined;
    if (when !== undefined) labels.set(group, `${group.key} (${when})`);
  }
  return labels;
}

/**
 * `Steps: 14 run · 57% passed first try · 14% after a retry · 7% after a
 * failed action · 21% failed`. The shares add up to 100 (largest remainder),
 * and "after a failed action" — passed on the first attempt, once a later
 * turn recovered from a failed action — shows only when there are any.
 */
function stepsLine(steps: StepStats): string {
  const n = steps.executed;
  if (n === 0) return 'Steps: none ran to an end';
  const parts: Array<{ count: number; label: string; always: boolean }> = [
    { count: steps.firstTry, label: 'passed first try', always: true },
    { count: steps.afterRetry, label: 'after a retry', always: true },
    { count: steps.afterFailedAction, label: 'after a failed action', always: false },
    { count: steps.failed, label: 'failed', always: true },
  ];
  const shares = wholePercents(parts.map((part) => part.count));
  const shown = parts
    .map((part, i) => ({ ...part, share: shares[i]! }))
    .filter((part) => part.always || part.count > 0)
    .map((part) => `${part.share}% ${part.label}`);
  return `Steps: ${num(n)} run · ${shown.join(' · ')}`;
}

function costLine(steps: StepStats): string | undefined {
  if (steps.tokensPerStep === null || steps.callsPerStep === null) return undefined;
  return (
    `Cost:  ${num(steps.tokensPerStep)} tokens a step on average${steps.estimated ? ' (some estimated)' : ''}`
    + ` · ${steps.callsPerStep.toFixed(1)} model calls a step`
  );
}

function renderSummary(summary: StatsSummary, plan: Plan, timeZone: string, now: Date): string[] {
  const labels = groupLabels(summary, timeZone, now);
  const stepColumns = STEP_GROUP_BYS.has(summary.by);
  let estimatedCell = false;
  let rendered: string[];
  const notes: string[] = [];

  if (summary.groups.length === 0) {
    // Steps with no actions: code-behind replays, assertions, `[use ai]`.
    rendered = ['No actions: these steps chose none.'];
  } else if (summary.by === 'outcome') {
    const total = summary.actions.actions;
    rendered = table(
      ['Outcome', 'Actions', 'Share'],
      summary.groups.map((group) => [
        labels.get(group)!,
        num(group.actions.actions),
        pct(total === 0 ? null : group.actions.actions / total),
      ]),
      ['l', 'r', 'r'],
    );
  } else {
    const header = [FIRST_COLUMN[summary.by], 'Actions', 'First try ok', 'Most common failure'];
    const align: Array<'l' | 'r'> = ['l', 'r', 'r', 'l'];
    if (stepColumns) {
      header.push('Steps', 'Tokens a step', 'Calls a step');
      align.push('r', 'r', 'r');
    }
    const rows = summary.groups.map((group) => {
      const { actions, steps } = group;
      const row = [
        labels.get(group)!,
        num(actions.actions),
        pct(actions.firstTryOkRate),
        actions.topFailure === null ? '' : `${outcomeLabel(actions.topFailure.outcome)} (${num(actions.topFailure.count)})`,
      ];
      if (stepColumns && steps !== undefined) {
        if (steps.estimated) estimatedCell = true;
        row.push(
          num(steps.executed),
          steps.tokensPerStep === null ? NONE : `${num(steps.tokensPerStep)}${steps.estimated ? '*' : ''}`,
          steps.callsPerStep === null ? NONE : steps.callsPerStep.toFixed(1),
        );
      }
      return row;
    });
    rendered = table(header, rows, align);
    // "Actions" counts retries; the next two columns do not. Said only when a
    // retry is in the table, which is when the numbers stop lining up.
    if (summary.actions.actions > summary.actions.firstTryActions) {
      notes.push('First try ok and Most common failure count each step’s first attempt; Actions counts retries too.');
    }
  }

  const out = [describeScope(plan), '', ...rendered, ...notes, '', stepsLine(summary.steps)];
  const cost = costLine(summary.steps);
  if (cost !== undefined) out.push(cost);
  if (estimatedCell) out.push('* some of these tokens were estimated');
  return out;
}

/** The step text for one line of a list: whitespace folded, cut to about
 *  `max` characters with an ellipsis, on a word boundary when one is near. */
function cutText(text: string | undefined, max = 60): string {
  if (text === undefined) return '(step text not kept)';
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');
  let cut = chars.slice(0, max - 2).join('');
  const space = cut.lastIndexOf(' ');
  if (chars[max - 2] !== ' ' && space > 0 && space >= cut.length - 15) cut = cut.slice(0, space);
  return `${cut.trimEnd()} …`;
}

/** `step 11`, `row 3, step 11`, `before hook 2`, `beforeEach hook 1, step 5`. */
function stepLabel(entry: { step: number; row?: number | undefined; hook?: string | undefined; hookIndex?: number | undefined }): string {
  const row = entry.row === undefined ? '' : `row ${entry.row}, `;
  const place = entry.hookIndex === undefined ? '' : ` ${entry.hookIndex}`;
  if (entry.hook === 'before' || entry.hook === 'after') return `${row}${entry.hook} hook${place}`;
  if (entry.hook !== undefined) return `${row}${entry.hook} hook${place}, step ${entry.step}`;
  return `${row}step ${entry.step}`;
}

function whereLine(entry: FailureEntry | CostlyEntry, timeZone: string): string {
  return [
    formatDateTime(Date.parse(entry.t), timeZone),
    entry.test ?? '(ad hoc)',
    stepLabel(entry),
    cutText(entry.stepText),
  ].join('  ');
}

function reportLine(link: ReportLink): string {
  switch (link.state) {
    case 'linked': return `  report: ${link.href}`;
    case 'no-card': return `  report: ${link.href} (no card for this step in the report)`;
    case 'deleted': return `  report: ${link.path} (report deleted)`;
    case 'none': return '  report: none (the run wrote no report)';
    case 'pending': return '  report: (not written yet)';
    case 'unfinished': return '  report: (run did not finish)';
  }
}

function moreLine(list: StatsList<unknown>): string[] {
  return list.total > list.entries.length
    ? ['', `Showing ${num(list.entries.length)} of ${num(list.total)}. --limit ${list.total} shows them all.`]
    : [];
}

function renderFailures(list: StatsList<FailureEntry>, plan: Plan, timeZone: string): string[] {
  const scope = describeScope(plan);
  if (list.total === 0) return [scope, '', 'No failed actions.'];
  const out = [`${scope} · ${plural(list.total, 'failed action')}, newest first`];
  for (const entry of list.entries) {
    const selector = entry.selector === null ? '' : `  ${entry.selector}`;
    // A retry's failure would otherwise read as a duplicate of the first's.
    const attempt = entry.attempt > 1 ? ` (attempt ${entry.attempt})` : '';
    out.push(
      '',
      whereLine(entry, timeZone),
      `  ${entry.action}${selector}    ${outcomeLabel(entry.outcome)}${attempt}`,
      reportLine(entry.report),
    );
  }
  return [...out, ...moreLine(list)];
}

function statusText(entry: CostlyEntry): string {
  if (entry.interrupted === true) return 'stopped by the user';
  if (entry.status === 'passed') {
    if (entry.firstTry) return 'passed first try';
    // Not first try within one attempt: an action failed and a later turn
    // recovered.
    return entry.attempts > 1 ? 'passed after a retry' : 'passed after a failed action';
  }
  if (entry.status === 'failed') return entry.tolerated === true ? 'failed, the run continued' : 'failed';
  return entry.status;
}

function renderCostly(list: StatsList<CostlyEntry>, plan: Plan, timeZone: string): string[] {
  const scope = describeScope(plan);
  if (list.total === 0) return [scope, '', 'No steps with a token count.'];
  const out = [`${scope} · steps by tokens, most first`];
  for (const entry of list.entries) {
    const split = `${num(entry.tokensIn)} in, ${num(entry.tokensOut)} out${entry.estimated ? '; some estimated' : ''}`;
    out.push(
      '',
      whereLine(entry, timeZone),
      `  ${num(entry.tokens)} tokens (${split}) · ${plural(entry.calls, 'call')} · ${plural(entry.attempts, 'attempt')} · ${statusText(entry)}`,
      reportLine(entry.report),
    );
  }
  return [...out, ...moreLine(list)];
}

function suiteNames(names: readonly string[]): string {
  return names.map((name) => (name in SUITE_FROM ? name : `"${name}"`)).join(', ');
}

/** The suites or sources `counts` names, in the order the flag lists them. */
function namesIn(counts: Partial<Record<string, LineCounts>>, known: readonly string[]): string[] {
  const named = Object.keys(counts).filter((name) => {
    const found = counts[name];
    return found !== undefined && found.actions + found.steps > 0;
  });
  return [...known.filter((name) => named.includes(name)), ...named.filter((name) => !known.includes(name))];
}

function sumOf(counts: Partial<Record<string, LineCounts>>, names: readonly string[]): LineCounts {
  const total = { actions: 0, steps: 0 };
  for (const name of names) {
    total.actions += counts[name]?.actions ?? 0;
    total.steps += counts[name]?.steps ?? 0;
  }
  return total;
}

/**
 * Which flag hid how much of the window, so the one to change is obvious:
 * "Of 20 actions and 18 steps in this window, --site left out 19 actions and
 * 16 steps, and the default --suite user left out 1 action (live)."
 */
function leftOutHint(selection: StatsSelection, plan: Plan): string | undefined {
  const { leftOut } = selection;
  const parts: string[] = [];
  const filterFlags = [
    plan.typed.site ? '--site' : undefined,
    plan.typed.model ? '--model' : undefined,
    plan.typed.test ? '--test' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (leftOut.filters.actions + leftOut.filters.steps > 0 && filterFlags.length > 0) {
    parts.push(`${filterFlags.join('/')} left out ${describeLines(leftOut.filters)}`);
  }
  const suites = namesIn(leftOut.suites, STATS_SUITES);
  if (suites.length > 0) {
    const who = plan.typed.suite ? '--suite' : `the default --suite ${plan.query.suites.join(',')}`;
    parts.push(`${who} left out ${describeLines(sumOf(leftOut.suites, suites))} (${suiteNames(suites)})`);
  }
  const sources = namesIn(leftOut.sources, STATS_SOURCES);
  if (sources.length > 0) {
    const who = plan.typed.source ? '--source' : `the default --source ${plan.query.sources.join(',')}`;
    parts.push(`${who} left out ${describeLines(sumOf(leftOut.sources, sources))} (${sources.join(', ')})`);
  }
  if (parts.length === 0) return undefined;
  return `Of ${describeLines(selection.inWindow)} in this window, ${joinAnd(parts)}.`;
}

/**
 * The view came up empty with no filter typed: only the defaults — your own
 * runs, AI steps — hid what the window holds. Say which default hid what, and
 * the flag that shows it.
 */
function hiddenByDefaults(selection: StatsSelection): string[] {
  const out = [
    `Nothing from your own runs’ AI steps in the last ${DEFAULT_WINDOW_DAYS} days.`,
    'By default only those count, which left out:',
  ];
  const { leftOut } = selection;
  for (const suite of namesIn(leftOut.suites, STATS_SUITES)) {
    const counts = leftOut.suites[suite]!;
    const from = SUITE_FROM[suite] ?? `from runs tagged "${suite}"`;
    out.push(`  ${describeLines(counts)} ${from}: --suite ${suite} shows ${counts.actions + counts.steps === 1 ? 'it' : 'them'}`);
  }
  for (const source of namesIn(leftOut.sources, STATS_SOURCES)) {
    const counts = leftOut.sources[source]!;
    const from = SOURCE_FROM[source] ?? `from source "${source}"`;
    out.push(`  ${describeLines(counts)} ${from}: --source ${source} shows ${counts.actions + counts.steps === 1 ? 'it' : 'them'}`);
  }
  return out;
}

function recordingLine(recording: Recording, deps: UserRootDeps | undefined): string {
  const file = userRootEnvPath(deps);
  if (!recording.machine) return `Recording is off on this machine: STEPTIX_STATS=off in ${file}.`;
  if (recording.offInThisShell) {
    return 'Recording is on for this machine, but STEPTIX_STATS=off in this shell’s environment: runs started from here record nothing.';
  }
  return `Recording is on. STEPTIX_STATS=off in ${file} turns it off for the whole machine.`;
}

function renderNothing(args: {
  plan: Plan;
  selection: StatsSelection;
  dir: string;
  recording: Recording;
  months: StatsMonthFile[];
  deps: UserRootDeps | undefined;
}): string[] {
  const { plan, selection, dir, recording, months, deps } = args;
  const out = [describeScope(plan), ''];
  const typedAny = Object.values(plan.typed).some(Boolean);

  if (selection.inWindow.actions + selection.inWindow.steps > 0) {
    if (!typedAny) return [...out, ...hiddenByDefaults(selection)];
    out.push('Nothing matches these filters.');
    const hint = leftOutHint(selection, plan);
    if (hint !== undefined) out.push(hint);
    if (plan.typed.model) {
      out.push(
        selection.models.length === 0
          ? 'No line in this window names a model.'
          : `Models in this window: ${selection.models.map((entry) => entry.model).join(', ')}. --model takes the whole id.`,
      );
    }
    return out;
  }

  if (months.length === 0) {
    out.push('Nothing recorded yet.');
  } else if (!plan.typed.window) {
    out.push(`Nothing recorded in the last ${DEFAULT_WINDOW_DAYS} days, the default window.`);
    const earlier = months.filter((month) => month.start < plan.query.since.getTime());
    const latest = earlier[earlier.length - 1];
    if (latest !== undefined) out.push(`Earlier months are on disk, the latest ${latest.month}: --since ${latest.month}-01 reaches it.`);
  } else {
    out.push('Nothing recorded in this window.');
  }
  out.push(
    `Every run keeps a line per AI action and step in ${dir}, one file a month.`,
    recordingLine(recording, deps),
  );
  return out;
}

function renderNotes(skipped: number, pruned: number, retainMonths: number): string[] {
  const notes: string[] = [];
  if (skipped > 0) notes.push(`Note: skipped ${plural(skipped, 'line')} that could not be read.`);
  if (pruned > 0) notes.push(`Note: removed ${plural(pruned, 'month file')} older than ${plural(retainMonths, 'month')}.`);
  return notes.length === 0 ? [] : ['', ...notes];
}
