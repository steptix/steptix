import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scanStepSpans } from '../src/parser/markdown.js';

/**
 * Cross-package parity: the server-side span scanner vs the frozen
 * classification table that runner-core and both extensions assert against.
 *
 * The server does not import runner-core — it hand-mirrors the `## Steps`
 * span scan in `src/parser/markdown.ts` (issues/035, contract §1). Nothing in
 * the type system links the two, so this file is the link: both sides are
 * held to `fixtures/sections/classification.json`, and a divergence surfaces
 * as a failing row here instead of as a test file that executes one way from
 * the CLI and another way through TestBench.
 *
 * This is step 6 of issues/035, banked early because sections are the first
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

describe('server span scanner vs the frozen classification table', () => {
  // classification-hashes.md is excluded: every one of its headings is
  // hashes-only, so the scanner raises the empty-name error before it can
  // return a table. That refusal is asserted below instead.
  for (const fixture of ['classification.md', 'classification-edge.md']) {
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
