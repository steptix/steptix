import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTestContent, scanStepSpans } from '../src/parser/markdown.js';
import { createStepLineReader } from '../src/parser/line-grammar.js';
import {
  // runner-core's SOURCE, not its `dist/` — the root `npm test` does not
  // build runner-core, so the compiled copy could be stale.
  createStepLineReader as coreCreateStepLineReader,
  extractSteps as coreExtractSteps,
} from '../runner-core/src/step-lines.ts';

/**
 * Cross-package parity: the server-side span scanner vs the frozen
 * classification table that runner-core and both extensions assert against.
 *
 * The server does not import runner-core — it hand-mirrors the `## Steps`
 * span scan in `src/parser/markdown.ts` (steptix/steptix#49, contract §1). Nothing in
 * the type system links the two, so this file is the link: both sides are
 * held to `fixtures/sections/classification.json`, and a divergence surfaces
 * as a failing row here instead of as a test file that executes one way from
 * the CLI and another way through Steptix.
 *
 * This is step 6 of the consolidation plan in steptix/steptix#49, banked early because sections are the first
 * feature where the two scanners disagreeing changes *what runs* rather than
 * merely how a line is painted.
 */

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sections',
);
const read = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf-8');

interface FrozenStep {
  line: number;
  instruction: string;
}
interface FrozenFile {
  lines: { line: number; kind: string }[];
  expectedSections: { name: string; headingLine: number; steps: FrozenStep[] }[];
  expectedMainFlow?: FrozenStep[];
  expectsCliParseError?: string;
}
const frozen = JSON.parse(read('classification.json')) as { files: Record<string, FrozenFile> };

/**
 * The main-flow step lines, taken from the per-line `kind` table.
 *
 * `expectedMainFlow` is only frozen for classification.md, but `lines` is
 * frozen for every fixture — and deriving from it ties the server scanner to
 * the same per-line classification runner-core asserts, rather than to a
 * second hand-written list that could drift from it. Where both exist they
 * are cross-checked against each other.
 */
const mainFlowLines = (file: FrozenFile): number[] =>
  file.lines.filter((l) => l.kind === 'step').map((l) => l.line);

/** Every fixture the scanner returns a table for (see the hashes-only note). */
const SCANNABLE = [
  'classification.md',
  'classification-edge.md',
  // steptix/steptix#49: indented and nested numbered lines.
  'classification-indented.md',
  'classification-nested.md',
];

describe('server span scanner vs the frozen classification table', () => {
  // classification-hashes.md is excluded: every one of its headings is
  // hashes-only, so the scanner raises the empty-name error before it can
  // return a table. That refusal is asserted below instead.
  for (const fixture of SCANNABLE) {
    const expected = frozen.files[fixture]!;

    it(`reproduces the section headings for ${fixture}`, () => {
      const scan = scanStepSpans(read(fixture), fixture);
      expect(scan.heads).toEqual(
        expected.expectedSections.map((s) => ({ name: s.name, headingLine: s.headingLine })),
      );
    });

    it(`reproduces the main flow for ${fixture}`, () => {
      const scan = scanStepSpans(read(fixture), fixture);
      const mainFlow = scan.entries.filter((e) => e.sectionIndex === null);
      expect(mainFlow.map((e) => e.line)).toEqual(mainFlowLines(expected));

      // Where the table also froze the instruction text, hold the scanner to
      // it — and hold the two frozen views to each other.
      if (expected.expectedMainFlow) {
        expect(mainFlow.map((e) => ({ line: e.line, instruction: e.raw }))).toEqual(
          expected.expectedMainFlow,
        );
        expect(expected.expectedMainFlow.map((s) => s.line)).toEqual(mainFlowLines(expected));
      }
    });

    it(`reproduces each section body for ${fixture}`, () => {
      const scan = scanStepSpans(read(fixture), fixture);
      const bodies = expected.expectedSections.map((_, index) =>
        scan.entries
          .filter((e) => e.sectionIndex === index)
          .map((e) => ({ line: e.line, instruction: e.raw })),
      );
      expect(bodies).toEqual(expected.expectedSections.map((s) => s.steps));
    });

    it(`attributes every entry to exactly one bucket for ${fixture}`, () => {
      // A scan that dropped an entry, or double-counted one into both the
      // main flow and a body, would still pass the three tests above.
      const scan = scanStepSpans(read(fixture), fixture);
      const expectedTotal =
        mainFlowLines(expected).length +
        expected.expectedSections.reduce((n, s) => n + s.steps.length, 0);
      expect(scan.entries).toHaveLength(expectedTotal);
      expect(new Set(scan.entries.map((e) => e.line)).size).toBe(expectedTotal);
    });
  }

  it('refuses the hashes-only fixture rather than returning a table', () => {
    // The whole reason the dedicated hashes-only rule exists: left as prose,
    // this file would run its bodies as main-flow steps client-side while the
    // CLI refused it.
    expect(() => scanStepSpans(read('classification-hashes.md'), 'classification-hashes.md')).toThrow(
      /empty name/i,
    );
  });

  it('the raw match side is what the frozen table records', () => {
    // The table's `instruction` values are the RAW line minus the ordinal —
    // `[no-hooks]` markers preserved, inline markdown not resolved. If a
    // future change made the scanner emit `extractPlainText` output instead,
    // the match side would stop being decidable from the file alone and this
    // row is where that shows up.
    const scan = scanStepSpans(read('classification-edge.md'), 'classification-edge.md');
    const byLine = new Map(scan.entries.map((e) => [e.line, e.raw]));
    expect(byLine.get(14)).toBe('[no-hooks] Click Sign in');
    expect(byLine.get(15)).toBe('**[no-hooks]** Bold marker is not stripped by the marker regex');
  });
});

/**
 * steptix/steptix#49. The CLI takes its steps from `marked` and their line
 * numbers from the scanner above, and pairs the two by index. When the two
 * passes disagreed about an indented step, a file without sections ran every
 * step but cited the wrong lines — 15, 16, then 0 for the rest — and a file
 * with sections was refused outright.
 *
 * So these rows hold the PARSER's output, not just the scanner's, to the
 * frozen table: the steps `marked` found, on the lines the scanner found,
 * which is only right when both passes chose the same lines.
 */
describe('the CLI parser vs the frozen classification table', () => {
  it('still refuses classification-edge.md, for its fenced line', () => {
    // Its one divergence is a numbered line inside a fence, which the scanner
    // counts and `marked` does not. Indentation must not have added another.
    expect(() =>
      parseTestContent(read('classification-edge.md'), 'classification-edge.md'),
    ).toThrow(/markdown parser found 6 step\(s\) in `## Steps` but the line scanner found 7/);
  });

  for (const fixture of SCANNABLE.filter((f) => !frozen.files[f]!.expectsCliParseError)) {
    const expected = frozen.files[fixture]!;

    it(`numbers every main-flow step of ${fixture} on its own line`, () => {
      const parsed = parseTestContent(read(fixture), fixture);
      expect(parsed.stepLines).toEqual(mainFlowLines(expected));
      expect(parsed.steps).toHaveLength(mainFlowLines(expected).length);
      expect(parsed.stepLines).not.toContain(0);
    });

    it(`finds the section bodies of ${fixture} on their own lines`, () => {
      const parsed = parseTestContent(read(fixture), fixture);
      expect(
        Object.values(parsed.sections ?? {}).map((s) => ({
          name: s.name,
          headingLine: s.headingLine,
          stepLines: s.stepLines,
        })),
      ).toEqual(
        expected.expectedSections.map((s) => ({
          name: s.name,
          headingLine: s.headingLine,
          stepLines: s.steps.map((step) => step.line),
        })),
      );
    });
  }

  it("runs the issue's example in order, from line 10", () => {
    const parsed = parseTestContent(read('classification-indented.md'), 'classification-indented.md');
    expect(parsed.steps[0]).toBe('Navigate to the baseUrl');
    expect(parsed.stepLines).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });
});

/**
 * The step-line rule is implemented twice — runner-core's
 * `createStepLineReader` and its mirror in src/parser/line-grammar.ts — and
 * both are meant to say what `marked` says. Each shape below is run through
 * all three: the two readers line by line, and the CLI parser for the steps it
 * actually produced. A `marked` upgrade that changes an answer fails here.
 *
 * Bullets are left out on purpose: the CLI runs a bullet list under
 * `## Steps` as steps of its own, which no line scanner does — a separate gap
 * from this one.
 */
const SHAPES: Record<string, string[]> = {
  'two spaces in, then the margin': ['  1. A', '  2. B', '3. C', '4. D'],
  'one space in': [' 1. A', ' 2. B'],
  'three spaces in at the start': ['   1. A', '   2. B', '3. C'],
  'three spaces under `1. `: nested': ['1. A', '   1. a1', '   2. a2', '2. B'],
  'two spaces under `1. `: a sibling': ['1. A', '  1. a1', '  2. a2', '2. B'],
  'three spaces under `10. `: a sibling': ['10. A', '   11. B', '12. C'],
  'two spaces after the dot': ['1.  A', '   2. B', '3. C'],
  'deeper item, then back out': ['  1. A', '     1. sub', '  2. B'],
  'nested after a blank line': ['1. A', '', '   2. B', '3. C'],
  'a tab at the top level': ['\t1. A', '\t2. B'],
  'a tab under an item': ['1. A', '\t2. B', '3. C'],
  'four spaces at the top level': ['    1. A', '    2. B'],
  'prose after a blank closes the list': ['1. A', '', 'Prose here.', '', '   1. B', '   2. C'],
  'prose directly below continues the item': ['1. A', 'lazy', '  2. B'],
  'prose before an indented list': ['Intro', '  1. A', '  2. B'],
  'a thematic break closes the list': ['1. A', '', '***', '   1. B'],
  'a fence directly under a step closes the list': ['1. A', '```', 'x', '```', '   2. B'],
  'a fence inside an item keeps it open': ['1. A', '   ```', '   x', '   ```', '   2. B', '2. C'],
};

describe('server step-line reader vs runner-core vs marked', () => {
  for (const [name, body] of Object.entries(SHAPES)) {
    it(name, () => {
      const serverRead = createStepLineReader();
      const coreRead = coreCreateStepLineReader();
      expect(body.map((line) => serverRead(line))).toEqual(body.map((line) => coreRead(line)));

      const text = ['# T', '', '## Steps', '', ...body, ''].join('\n');
      const coreLines = coreExtractSteps(text).map((s: { line: number }) => s.line);
      const parsed = parseTestContent(text, 'shape.md');
      expect(parsed.steps).toHaveLength(coreLines.length);
      expect(parsed.stepLines).toEqual(coreLines);
    });
  }
});
