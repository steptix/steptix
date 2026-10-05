import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseTestContent, parseTestFile, scanStepSpans } from '../src/parser/markdown.js';

/**
 * Nothing under a `####` heading may run
 * (stories/test-script-sections-contract.md §5, rule 4a).
 *
 * A depth-≥4 heading with text inside a depth-2 `## Steps` span used to be
 * "inert prose": it neither opened a section nor closed the body it sat in.
 * The consequence was not inertness at all — the numbered items beneath it
 * were silently ABSORBED, into the main flow when no section was open and
 * into whichever section body was, and they ran. Both are reproduced below as
 * they were found, then pinned to the rule that replaced them: the items are
 * inert, and nothing runs them.
 */

const NO_SECTION = [
  '---', 'type: test', '---', '',
  '# Case 1 — no section anywhere', '',
  '## Steps',
  '1. Open the dashboard',
  '2. Check the header',
  '',
  '#### Cleanup',
  '1. Sign out',
  '2. Close the browser',
  '',
].join('\n');

const AFTER_A_SECTION = [
  '---', 'type: test', '---', '',
  '# Case 2 — a real section, then a #### heading', '',
  '## Steps',
  '1. Open the dashboard',
  '2. Login',
  '',
  '### Login',
  '1. Type the username',
  '2. Click Sign in',
  '',
  '#### Cleanup',
  '1. Sign out',
  '',
].join('\n');

describe('items under a depth-≥4 heading never run', () => {
  it('does not absorb them into the main flow when no section is open', () => {
    // Found running as main-flow steps 3 and 4.
    const parsed = parseTestContent(NO_SECTION, 'case1.md');
    expect(parsed.steps).toEqual(['Open the dashboard', 'Check the header']);
  });

  it('does not absorb them into the section body that precedes them', () => {
    // Found running as the third step of `Login`, i.e. on every call of it.
    const parsed = parseTestContent(AFTER_A_SECTION, 'case2.md');
    const login = Object.values(parsed.sections ?? {}).find((s) => s.name === 'Login');
    expect(login?.steps).toEqual(['Type the username', 'Click Sign in']);
    expect(parsed.steps).toEqual(['Open the dashboard', 'Login']);
  });

  it('keeps them out of the line scan, so nothing can address them', () => {
    const scan = scanStepSpans(AFTER_A_SECTION, 'case2.md');
    expect(scan.entries.map((e) => e.raw)).toEqual([
      'Open the dashboard',
      'Login',
      'Type the username',
      'Click Sign in',
    ]);
  });

  it('a second depth-≥4 heading renews the ignored region rather than ending it', () => {
    const text = [
      '---', 'type: test', '---', '',
      '# Renewal', '',
      '## Steps',
      '1. Open the dashboard',
      '',
      '#### Notes',
      '1. Inert one',
      '',
      '##### Deeper notes',
      '2. Inert two',
      '',
    ].join('\n');
    expect(parseTestContent(text, 'renew.md').steps).toEqual(['Open the dashboard']);
  });

  it('a `###` with text ends the ignored region — that is a real section', () => {
    const text = [
      '---', 'type: test', '---', '',
      '# Recovery', '',
      '## Steps',
      '1. Open the dashboard',
      '2. Cleanup',
      '',
      '#### Notes',
      '1. Inert',
      '',
      '### Cleanup',
      '1. Sign out',
      '',
    ].join('\n');
    const parsed = parseTestContent(text, 'recover.md');
    expect(parsed.steps).toEqual(['Open the dashboard', 'Cleanup']);
    const cleanup = Object.values(parsed.sections ?? {}).find((s) => s.name === 'Cleanup');
    expect(cleanup?.steps).toEqual(['Sign out']);
  });

  it('a #### heading followed by prose still makes later items inert', () => {
    const text = [
      '---', 'type: test', '---', '',
      '# Harmless', '',
      '## Steps',
      '1. Open the dashboard',
      '',
      '#### A note about the dashboard',
      '',
      'Just prose.',
      '',
      '2. Check the header',
      '',
    ].join('\n');
    // The heading opens an ignored region, so the item after it is inert too —
    // the region runs to the next `###` or the end of the span, not to the
    // next blank line.
    expect(parseTestContent(text, 'harmless.md').steps).toEqual(['Open the dashboard']);
  });

  it('is scoped to a depth-2 Steps span: under `### Steps` nothing changes', () => {
    const text = [
      '---', 'type: test', '---', '',
      '# Deep host', '',
      '### Steps',
      '1. Open the dashboard',
      '',
      '#### Cleanup',
      '1. Sign out',
      '',
    ].join('\n');
    // `### Steps` hosts no sections at all — and the marked walk only
    // dispatches `## Steps` at depth 2, so it yields no steps either way.
    // Pinned as it is: this rule must not reach outside a depth-2 span.
    expect(parseTestContent(text, 'deephost.md').steps).toEqual([]);
    expect(scanStepSpans(text, 'deephost.md').entries.map((e) => e.raw)).toEqual([
      'Open the dashboard',
      'Sign out',
    ]);
  });
});

/**
 * The seam that decides what actually RUNS: parse, then expand. A run
 * executes the expansion, so an item that survives to here is an item that
 * executes — which is how both absorption cases were found in the first place.
 */
describe('what a run would execute', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inert-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const write = async (name: string, text: string): Promise<string> => {
    const file = path.join(dir, name);
    await fs.writeFile(file, text, 'utf-8');
    return file;
  };

  it('never executes items under a `####` heading, with or without a section', async () => {
    // `parseTestFile` returns the EXPANDED step list — the one a run walks —
    // so this is the question "would it run?" asked directly.
    for (const [name, text, expected] of [
      ['case1.md', NO_SECTION, ['Open the dashboard', 'Check the header']],
      ['case2.md', AFTER_A_SECTION, ['Open the dashboard', 'Type the username', 'Click Sign in']],
    ] as const) {
      const parsed = await parseTestFile(await write(name, text));
      expect(parsed.steps, name).toEqual(expected);
      // …and the section body a later call would run is clean too.
      const bodies = Object.values(parsed.sections ?? {}).map((sec) => sec.steps);
      expect(bodies.flat(), name).not.toContain('Sign out');
    }

  });
});
