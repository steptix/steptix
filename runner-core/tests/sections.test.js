/**
 * Inline sections in the line model.
 *
 * The frozen tables in `fixtures/sections/` are the specification — see
 * stories/test-script-sections-contract.md §5 and §6. The same bytes are
 * asserted by the root vitest suite (against the server's hand-mirrored
 * scanner) and by both extensions' copy-parity tests, so a disagreement
 * between any two implementations surfaces here as a failing row rather than
 * as a test file that executes differently depending on how it was launched.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  classifyLines,
  classifySelectedSteps,
  extractSections,
  extractSteps,
  inertRegionHeading,
} from '../dist/step-lines.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'sections',
);
const read = (name) => readFileSync(path.join(FIXTURES, name), 'utf-8');
const frozen = JSON.parse(read('classification.json'));

/** Blank lines are omitted from the frozen table on purpose (contract §6). */
const nonBlank = (text) => classifyLines(text).filter((l) => l.kind !== 'blank');

// ---------------------------------------------------------------------------
// The frozen classification table
// ---------------------------------------------------------------------------

for (const [fixture, expected] of Object.entries(frozen.files)) {
  test(`classifyLines: reproduces the frozen table for ${fixture}`, () => {
    assert.deepEqual(nonBlank(read(fixture)), expected.lines);
  });

  test(`extractSections: reproduces the frozen sections for ${fixture}`, () => {
    assert.deepEqual(extractSections(read(fixture)), expected.expectedSections);
  });
}

test('extractSteps: main flow only, per the frozen table', () => {
  const expected = frozen.files['classification.md'].expectedMainFlow;
  assert.deepEqual(extractSteps(read('classification.md')), expected);
});

// ---------------------------------------------------------------------------
// The consumer split (contract §5): main-flow only vs main + body. What a
// line selection resolves to, body lines included, is run-selection.test.js's.
// ---------------------------------------------------------------------------

test('classifySelectedSteps: Run All classifies main-flow steps only', () => {
  // Without this, "run everything" would execute each body inline AND again
  // at its call site — the double execution the feature exists to prevent.
  const classified = classifySelectedSteps(read('classification.md'), []);
  assert.deepEqual(
    classified.map((s) => s.line),
    [13, 17, 18],
  );
});

// ---------------------------------------------------------------------------
// Section boundaries
// ---------------------------------------------------------------------------

test('a depth-4 heading with text opens an ignored region without closing the body', () => {
  // classification.md line 27 is `#### Notes with heading text`. It still does
  // not CLOSE `### Login` — a later `###` would be the thing that did — but
  // line 29 beneath it is inert and is no longer one of Login's steps.
  // Contract §5 rule 4a and the body-attribution paragraph.
  const text = read('classification.md');
  const login = extractSections(text)[0];
  assert.equal(login.name, 'Login');
  assert.deepEqual(
    login.steps.map((s) => s.line),
    [24, 25],
  );
  assert.equal(classifyLines(text)[28].kind, 'inert-step');
  // The body did not close: line 31's `### Cleanup` is still what opens the
  // next section, and nothing between 27 and 31 opened one.
  assert.equal(extractSections(text)[1].headingLine, 31);
});

test('a hashes-only heading DOES close the body and open a new section', () => {
  // The contrast with the row above: `####` bare is a section heading at any
  // depth ≥ 3, so classification-hashes.md yields three single-step sections
  // rather than one with a merged body.
  const sections = extractSections(read('classification-hashes.md'));
  assert.equal(sections.length, 3);
  assert.deepEqual(
    sections.map((s) => s.headingLine),
    [10, 14, 18],
  );
  for (const section of sections) {
    assert.equal(section.name, '');
    assert.equal(section.steps.length, 1);
  }
});

test('a bare ### is a section heading, not prose', () => {
  // ANY_HEADING_RE demands a non-space after the hashes and cannot see this.
  // Left as prose, Steptix would run the body below it as a main-flow step
  // while the CLI refused the file — the exact divergence sections exist to
  // remove.
  const classified = classifyLines(read('classification-hashes.md'));
  assert.equal(classified[9].kind, 'section-heading');
  assert.equal(classified[11].kind, 'section-step');
  assert.deepEqual(extractSteps(read('classification-hashes.md')), [
    { line: 8, instruction: 'Open the page' },
  ]);
});

test('the main flow ends at the first section and never resumes', () => {
  const text = ['## Steps', '1. One', '', '### S', '1. Body', '', '2. Still body'].join('\n');
  assert.deepEqual(extractSteps(text), [{ line: 2, instruction: 'One' }]);
  assert.deepEqual(
    extractSections(text)[0].steps.map((s) => s.instruction),
    ['Body', 'Still body'],
  );
});

test('a ### outside the Steps span defines nothing', () => {
  const text = ['## Steps', '1. One', '', '## Notes', '', '### Not a section', '', '1. Prose'].join(
    '\n',
  );
  assert.deepEqual(extractSections(text), []);
  assert.deepEqual(extractSteps(text), [{ line: 2, instruction: 'One' }]);
});

test('sections are recognised only under a depth-2 Steps heading', () => {
  // Under `### Steps` a `###` line closes the span rather than landing in it,
  // so no section can be defined. The CLI agrees: its token walk dispatches
  // on depth 1-2 only. Contract §5 precondition.
  const text = ['### Steps', '1. One', '', '### S', '1. Body'].join('\n');
  assert.deepEqual(extractSections(text), []);
  assert.deepEqual(extractSteps(text), [{ line: 2, instruction: 'One' }]);
});

test('a bare ### under a deeper Steps heading stays prose', () => {
  // The gate has to cover the hashes-only rule too: a bare ### is invisible
  // to the span scanner, so without the depth check it would land in-span and
  // open a section under `### Steps`, where the CLI recognises none.
  const text = ['### Steps', '1. One', '', '###', '', '1. Body'].join('\n');
  assert.deepEqual(extractSections(text), []);
  assert.equal(classifyLines(text)[3].kind, 'prose');
  assert.deepEqual(
    extractSteps(text).map((s) => s.line),
    [2, 6],
  );
});

// ---------------------------------------------------------------------------
// The cull rule (contract §3.1) and its deliberate asymmetry
// ---------------------------------------------------------------------------

test('extractSections culls a marker-only body item', () => {
  // classification-edge.md line 17 is `5. [no-hooks]`. It carries no
  // instruction, so it must never reach the wire.
  //
  // It still classifies as a `section-step`, and `extractStepLineIds` still
  // returns it, so the editor paints a step decoration there. Note this is
  // NOT the same as a main-flow marker-only line, which paints *and* runs:
  // this one paints and can never run. That is a cosmetic wart, chosen over
  // making the painting path disagree with the span scan.
  const text = read('classification-edge.md');
  assert.equal(classifyLines(text)[16].kind, 'section-step');
  const lines = extractSections(text)[0].steps.map((s) => s.line);
  assert.ok(!lines.includes(17), 'marker-only body item must be culled');
  assert.deepEqual(lines, [13, 14, 15, 20, 23]);
});

test('extractSteps does NOT cull — the asymmetry is deliberate', () => {
  // Pre-existing behaviour the run paths rely on. Pinned so a well-meaning
  // "make these consistent" change has to argue with a test.
  const text = ['## Steps', '1. Real', '2. [no-hooks]'].join('\n');
  assert.deepEqual(extractSteps(text), [
    { line: 2, instruction: 'Real' },
    { line: 3, instruction: '[no-hooks]' },
  ]);
});

test('body steps keep their [no-hooks] marker verbatim', () => {
  // The wire shape carries the marker; the expander strips it when inlining.
  // Stripping here would hide a body step's opt-out from the server.
  const steps = extractSections(read('classification-edge.md'))[0].steps;
  assert.equal(steps[1].instruction, '[no-hooks] Click Sign in');
});

test('a bare ordinal in a body is absent from every pass', () => {
  // classification-edge.md line 16 is `4.` — no content after the dot, so it
  // matches neither STEP_LINE_RE nor the prefix strip. Assert all three
  // passes, not just the classifier: the test used to be named for a claim
  // it did not check.
  const text = read('classification-edge.md');
  assert.equal(classifyLines(text)[15].kind, 'prose');
  assert.ok(!extractSteps(text).some((s) => s.line === 16));
  assert.ok(
    !extractSections(text).some((section) => section.steps.some((s) => s.line === 16)),
  );
});

test('extractSections: no Steps heading yields no sections', () => {
  assert.deepEqual(extractSections('# Title\n\n### Login\n\n1. A\n'), []);
});

// ---------------------------------------------------------------------------
// Ignored regions — nothing under a `####` runs (contract §5 rule 4a)
// ---------------------------------------------------------------------------

const IGNORED = [
  '## Steps',
  '1. Main one',
  '',
  '#### Notes',
  '2. Inert one',
  '',
  '##### Deeper',
  '3. Inert two',
  '',
  '### Login',
  '4. Body one',
  '',
  '#### More notes',
  '5. Inert three',
].join('\n');

test('numbered items under a depth-4 heading are inert, not steps', () => {
  const kinds = classifyLines(IGNORED).map((c) => c.kind);
  //          ## Steps  1.      blank   #### Notes  2.
  assert.deepEqual(kinds.slice(0, 5), ['heading', 'step', 'blank', 'heading', 'inert-step']);
});

test('a deeper heading renews the region rather than ending it', () => {
  const kinds = classifyLines(IGNORED).map((c) => c.kind);
  assert.equal(kinds[6], 'heading', '##### Deeper');
  assert.equal(kinds[7], 'inert-step', 'the item under it is still inert');
});

test('a `###` with text ends the region — it opens a real section', () => {
  const kinds = classifyLines(IGNORED).map((c) => c.kind);
  assert.equal(kinds[9], 'section-heading', '### Login');
  assert.equal(kinds[10], 'section-step', 'its body runs');
  // …and a later `####` opens a fresh region inside that body.
  assert.equal(kinds[13], 'inert-step');
});

test('no consumer treats an inert item as runnable or as a section member', () => {
  assert.deepEqual(extractSteps(IGNORED).map((s) => s.instruction), ['Main one']);
  const login = extractSections(IGNORED)[0];
  assert.equal(login.name, 'Login');
  assert.deepEqual(login.steps.map((s) => s.instruction), ['Body one']);
});

test('inertRegionHeading names the heading that stopped the item', () => {
  assert.deepEqual(inertRegionHeading(IGNORED, 5), { line: 4, name: 'Notes' });
  assert.deepEqual(inertRegionHeading(IGNORED, 14), { line: 13, name: 'More notes' });
  assert.equal(inertRegionHeading(IGNORED, 2), null, 'a real step owns no region');
  assert.equal(inertRegionHeading(IGNORED, 11), null, 'nor does a body step');
});

test('hashes-only headings keep their pinned semantics inside a region', () => {
  // A bare `####` opens an EMPTY-NAME section, so it ends the ignored region
  // the way a `###` with text does — contract §5 rule 3 is untouched.
  const text = ['## Steps', '1. Main', '', '#### Notes', '2. Inert', '', '####', '3. Body'].join('\n');
  const kinds = classifyLines(text).map((c) => c.kind);
  assert.equal(kinds[4], 'inert-step');
  assert.equal(kinds[6], 'section-heading', 'bare #### is still a section heading');
  assert.equal(kinds[7], 'section-step', 'and its items still run');
});

test('the rule is scoped to a depth-2 Steps span', () => {
  // Under `### Steps` no section can be defined, so the old grammar stands and
  // the items below a `####` remain ordinary steps.
  const text = ['### Steps', '1. Main', '', '#### Notes', '2. Still a step'].join('\n');
  const kinds = classifyLines(text).map((c) => c.kind);
  assert.equal(kinds[4], 'step');
});
