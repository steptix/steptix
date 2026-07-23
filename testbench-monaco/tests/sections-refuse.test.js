/**
 * The refusal predicate behind testbench-monaco's sectioned-file guard.
 *
 * Monaco has no sections support, so a sectioned file is REFUSED (TB026)
 * rather than mis-run. `usesInlineSections` is that decision, and it delegates
 * to the shared `extractSections`, so the refusal fires on exactly the files
 * the CLI and testbench-native would expand — no more, no less.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { usesInlineSections } from '../src/extension/sections.ts';

const doc = (...lines) => lines.join('\n');
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'sections',
);
const readFixture = (name) => readFileSync(path.join(FIXTURES, name), 'utf-8');

test('refuses a file that defines a section', () => {
  assert.equal(
    usesInlineSections(doc('## Steps', '1. Login', '', '### Login', '1. Type the username')),
    true,
  );
});

test('runs a plain sectionless file (no refusal)', () => {
  assert.equal(usesInlineSections(doc('## Steps', '1. One', '2. Two')), false);
  assert.equal(usesInlineSections(''), false);
});

test('a ### OUTSIDE the Steps span is not a section — do not refuse', () => {
  // A subheading under prose is ordinary markdown, not a section, so a normal
  // test with documentation headings still runs.
  const text = doc('## Steps', '1. One', '', '## Notes', '', '### Not a section', '', '1. Prose');
  assert.equal(usesInlineSections(text), false);
});

test('refuses the duplicate-name case (unrunnable everywhere)', () => {
  const text = doc(
    '## Steps', '1. Login', '',
    '### Login', '1. A', '',
    '### LOGIN', '1. B',
  );
  assert.equal(usesInlineSections(text), true);
});

test('refuses a hashes-only (empty-name) section', () => {
  // A bare `###` is a section heading (empty name) per the line model, and is
  // unrunnable — monaco must refuse it rather than run the body below.
  assert.equal(usesInlineSections(readFixture('classification-hashes.md')), true);
});

test('agrees with the shared fixtures', () => {
  // The refusal must fire on exactly the fixtures that define sections.
  assert.equal(usesInlineSections(readFixture('classification.md')), true);
  assert.equal(usesInlineSections(readFixture('classification-edge.md')), true);
});
