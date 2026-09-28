/**
 * Every place a step can finish hands the scoreboard its run
 * (docs/specs/SPEC-scoreboard.md §7 and §15, "Source pin").
 *
 * A step records its lines at the end of the function that ran it —
 * `executeStep`, `executeComputerStep`, `runUseAiStep` — from the `stats` on
 * its options. A call site that forgets `stats` compiles, runs and records
 * nothing, silently: exactly the loop the spec says must not be able to
 * appear. So this reads the source of every call site under `src/` and fails
 * on one that does not pass it, or forward the options of a call that did.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * The index of the bracket that closes the one at `open` — a small lexer, not
 * a parser: it skips comments (an apostrophe in a comment is not a string),
 * quoted strings and template literals, `${…}` holes included.
 */
function closingIndex(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = text.indexOf('*/', i + 2) + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      i++;
      continue;
    }
    if (ch === '`') {
      for (i++; i < text.length && text[i] !== '`'; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '$' && text[i + 1] === '{') i = closingIndex(text, i + 1);
      }
      i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error(`unbalanced bracket at offset ${open}`);
}

/** The text between the bracket at `open` and the one that closes it. */
function argumentsAt(text: string, open: number): string {
  return text.slice(open + 1, closingIndex(text, open));
}

interface CallSite {
  file: string;
  line: number;
  callee: string;
  args: string;
  text: string;
  offset: number;
}

/** Calls of `callees` in code — not in a comment, not the definition. */
function callSites(callees: readonly string[]): CallSite[] {
  const sites: CallSite[] = [];
  const pattern = new RegExp(`\\b(${callees.join('|')})\\(`, 'g');
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf-8');
    for (const match of text.matchAll(pattern)) {
      const offset = match.index!;
      const lineStart = text.lastIndexOf('\n', offset) + 1;
      const before = text.slice(lineStart, offset);
      if (/\/\/|^\s*\*|\/\*/.test(before)) continue; // a comment mentions it
      if (/\bfunction\s*$/.test(before)) continue; // the definition
      sites.push({
        file: path.relative(SRC, file).replaceAll('\\', '/'),
        line: text.slice(0, offset).split('\n').length,
        callee: match[1]!,
        args: argumentsAt(text, offset + match[0].length - 1),
        text,
        offset,
      });
    }
  }
  return sites;
}

const where = (site: CallSite): string => `${site.file}:${site.line} ${site.callee}(…)`;

/**
 * An options object that forwards ANOTHER step's own options wholesale, so
 * `stats` rides along with everything else. Named per file: a forwarder is a
 * decision about one call site, not a pattern anyone may use.
 */
const FORWARDERS: ReadonlyArray<{ file: string; carries: RegExp; why: string }> = [
  {
    file: 'runner/step-executor.ts',
    carries: /\.\.\.opts\b/,
    why: "a watch group's matched and continuation steps, and the clarification REPL, run on the enclosing step's options",
  },
  {
    file: 'runner/step-executor.ts',
    carries: /executorOptions:\s*ctx\.executorOptions\b/,
    why: 'promptUserWithReplEscape hands the REPL the options its caller passed',
  },
];

function passesStats(site: CallSite): boolean {
  if (/\bstats\s*:/.test(site.args)) return true;
  if (FORWARDERS.some((f) => f.file === site.file && f.carries.test(site.args))) return true;
  // `{ …, executorOptions, … }` shorthand: the object was built above, so read
  // the nearest declaration of it before the call.
  if (/\bexecutorOptions\s*[,}]/.test(site.args) || /\bexecutorOptions\s*$/.test(site.args.trim())) {
    const declared = site.text.lastIndexOf('const executorOptions', site.offset);
    if (declared >= 0) {
      return /\bstats\s*:/.test(argumentsAt(site.text, site.text.indexOf('{', declared)));
    }
  }
  return false;
}

describe('every call site that runs a step passes the scoreboard its run', () => {
  const STEP_RUNNERS = ['executeStep', 'executeComputerStep', 'executeBranchedStep', 'runUseAiStep'] as const;

  it('finds the call sites it is guarding (a scan that finds none proves nothing)', () => {
    const sites = callSites(STEP_RUNNERS);
    const count = (callee: string) => sites.filter((s) => s.callee === callee).length;
    // Today: the CLI runner (main flow, [output:], hooks), the Sessions API, the
    // errand runner, the REPL, the Runner UI (run + steer) and the watch group's
    // two nested calls.
    expect(count('executeStep')).toBeGreaterThanOrEqual(10);
    expect(count('executeComputerStep')).toBeGreaterThanOrEqual(2);
    expect(count('executeBranchedStep')).toBeGreaterThanOrEqual(2);
    expect(count('runUseAiStep')).toBeGreaterThanOrEqual(5);
    for (const file of ['runner/test-runner.ts', 'server/session-manager.ts', 'server/errand-runner.ts', 'runner/interactive-repl.ts', 'ui/main/runner-adapter.ts']) {
      expect(sites.some((s) => s.file === file), file).toBe(true);
    }
  });

  it.each(STEP_RUNNERS)('%s: every call passes `stats` (or forwards options that carry it)', (callee) => {
    const missing = callSites([callee]).filter((site) => !passesStats(site)).map(where);
    expect(missing).toEqual([]);
  });

  it('the REPL entries hand their ad hoc steps options that carry `stats`', () => {
    const missing = callSites(['runInteractiveRepl', 'promptUserWithReplEscape'])
      .filter((site) => !passesStats(site))
      .map(where);
    expect(missing).toEqual([]);
  });
});

describe('each kind of step records once, where it finishes', () => {
  /** The body of `export async function <name>(` up to its closing brace. */
  function bodyOf(file: string, name: string): string {
    const text = fs.readFileSync(path.join(SRC, file), 'utf-8');
    const at = text.indexOf(`export async function ${name}(`);
    expect(at, `${name} in ${file}`).toBeGreaterThanOrEqual(0);
    const brace = text.indexOf('{', text.indexOf(')', text.indexOf('): Promise<', at)));
    return argumentsAt(text, brace);
  }

  it.each([
    ['runner/step-executor.ts', 'executeStep'],
    ['runner/computer-step.ts', 'executeComputerStep'],
    ['runner/use-ai-step-runner.ts', 'runUseAiStep'],
  ])('%s: %s records its result exactly once', (file, name) => {
    const body = bodyOf(file, name);
    expect(body.match(/\brecordExecutedStep\(/g)).toHaveLength(1);
  });

  it('nothing else in src/ records a step — the loops pass `stats`, they do not record', () => {
    const recorders = callSites(['recordExecutedStep']).map((s) => s.file).sort();
    expect(recorders).toEqual(['runner/computer-step.ts', 'runner/step-executor.ts', 'runner/use-ai-step-runner.ts']);
  });
});
