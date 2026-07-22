/**
 * Goal 4: a test file that defines no sections must classify **exactly** as
 * it did before sections existed.
 *
 * The guard is a reference implementation of the pre-change classifier,
 * checked in below, run against every real Markdown test file in the repo.
 *
 * ## What this proves, and what it does not
 *
 * Be honest about the shape of this suite: **for the commit that introduced
 * it, the per-file rows cannot fail.** The filter predicate
 * (`extractSections(text).length === 0`) is logically equivalent to the
 * property being asserted. `section-heading` is the only new classification;
 * `extractSections` emits an entry for every one of them; and `section-step`
 * is unreachable without a preceding `section-heading`. So "defines no
 * sections" implies every new branch of `classifyLines` falls through to the
 * legacy one, and the corpus partitions itself into "provably identical" and
 * "excluded". An adversarial review confirmed this empirically over 400k
 * generated documents: zero sectionless documents differ, zero sectioned ones
 * agree.
 *
 * That equivalence is a *proof* of the Goal-4 property for this commit, not
 * evidence for it — so do not read 55 green rows as validation that the
 * classification change is correct. The frozen tables in
 * `fixtures/sections/classification.json` are what does that job.
 *
 * What this suite is genuinely for is **future** edits. The equivalence holds
 * only while the new classifier's extra branches are exactly the section
 * ones; any later change to span handling, frontmatter, heading depth or step
 * recognition breaks it and surfaces here as a concrete file and line, on
 * real documents rather than on synthetic ones.
 *
 * The corpus is filtered by **property**, never by path —
 * `fixtures/tests/sections-demo.md` already lives in a directory this walks,
 * and `templates/init/tests/sections-demo.md` lands there later in the
 * feature. Hard-coding `fixtures/sections/` would silently start comparing a
 * sectioned file against a classifier that predates sections.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  classifyLines,
  extractSections,
  extractSteps,
  isTestFile,
  resolveRunLines,
} from '../dist/step-lines.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const CORPUS_ROOTS = [
  'fixtures',
  'templates',
  path.join('testbench-native', 'tests', 'integration', 'fixtures'),
  path.join('testbench-monaco', 'tests', 'integration', 'fixtures'),
];

/**
 * `fixtures/tools/node_modules` is a real installed tree — walking it costs
 * minutes and sweeps in third-party READMEs that happen to carry a `## Steps`
 * heading. Skip it and the other generated directories.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const corpus = CORPUS_ROOTS.flatMap((root) => walk(path.join(REPO, root)))
  .map((file) => ({ file: path.relative(REPO, file), text: readFileSync(file, 'utf-8') }))
  .filter((entry) => isTestFile(entry.text));

const sectionless = corpus.filter((entry) => extractSections(entry.text).length === 0);
const sectioned = corpus.filter((entry) => extractSections(entry.text).length > 0);

// ---------------------------------------------------------------------------
// The pre-change classifier, verbatim from runner-core/src/step-lines.ts at
// commit ce21031 (the last commit before sections entered the line model).
// Do not "improve" this copy — its only job is to be what shipped.
// ---------------------------------------------------------------------------

const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const STEP_LINE_RE = /^\d+\.\s+\S/;

function legacyClassifyLines(text) {
  const lines = text.split(/\r?\n/);
  const out = new Array(lines.length);
  const frontmatterEnd = legacyFindFrontmatterEnd(lines);
  const stepsSpan = legacyFindStepsSection(lines, frontmatterEnd + 1);

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i] ?? '';
    if (i <= frontmatterEnd) {
      out[i] = { line: lineNumber, kind: 'frontmatter' };
      continue;
    }
    if (raw.trim() === '') {
      out[i] = { line: lineNumber, kind: 'blank' };
      continue;
    }
    if (ANY_HEADING_RE.test(raw)) {
      out[i] = { line: lineNumber, kind: 'heading' };
      continue;
    }
    const inSteps = stepsSpan && i >= stepsSpan.start && i <= stepsSpan.end;
    if (inSteps && STEP_LINE_RE.test(raw)) {
      out[i] = { line: lineNumber, kind: 'step' };
      continue;
    }
    out[i] = { line: lineNumber, kind: 'prose' };
  }
  return out;
}

function legacyExtractSteps(text) {
  const lines = text.split(/\r?\n/);
  const classified = legacyClassifyLines(text);
  const out = [];
  for (let i = 0; i < classified.length; i++) {
    if (classified[i]?.kind !== 'step') continue;
    out.push({ line: i + 1, instruction: (lines[i] ?? '').replace(/^\s*\d+\.\s+/, '').trim() });
  }
  return out;
}

function legacyFindFrontmatterEnd(lines) {
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
  if (i >= lines.length || (lines[i] ?? '').trim() !== '---') return -1;
  for (let j = i + 1; j < lines.length; j++) {
    if ((lines[j] ?? '').trim() === '---') return j;
  }
  return -1;
}

function legacyFindStepsSection(lines, from) {
  let headingIndex = -1;
  let headingDepth = 0;
  for (let i = from; i < lines.length; i++) {
    const m = STEPS_HEADING_RE.exec(lines[i] ?? '');
    if (m) {
      headingIndex = i;
      headingDepth = m[1].length;
      break;
    }
  }
  if (headingIndex < 0) return null;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const m = ANY_HEADING_RE.exec(lines[i] ?? '');
    if (m && m[1].length <= headingDepth) return { start: headingIndex + 1, end: i - 1 };
  }
  return { start: headingIndex + 1, end: lines.length - 1 };
}

// ---------------------------------------------------------------------------

test('the corpus is real: enough sectionless files, and at least one sectioned', () => {
  // A silently-empty corpus would make every assertion below vacuous.
  assert.ok(sectionless.length >= 20, `only ${sectionless.length} sectionless files found`);
  // And the filter must actually be excluding something, or it is untested.
  assert.ok(
    sectioned.length >= 1,
    'no sectioned file in the corpus — the by-property filter is unexercised',
  );
});

for (const { file, text } of sectionless) {
  test(`unchanged classification: ${file}`, () => {
    assert.deepEqual(classifyLines(text), legacyClassifyLines(text));
  });

  test(`unchanged steps: ${file}`, () => {
    assert.deepEqual(extractSteps(text), legacyExtractSteps(text));
    assert.deepEqual(
      resolveRunLines(text, []),
      legacyExtractSteps(text).map((s) => s.line),
    );
  });

  test(`no section kinds appear: ${file}`, () => {
    const kinds = new Set(classifyLines(text).map((l) => l.kind));
    assert.equal(kinds.has('section-heading'), false);
    assert.equal(kinds.has('section-step'), false);
  });
}

test('the reference classifier really can disagree', () => {
  // Without this, a bug that made `legacyClassifyLines` identical to the new
  // one would turn every assertion above into a tautology.
  const sectionedText = ['## Steps', '1. Login', '', '### Login', '1. Body'].join('\n');
  assert.notDeepEqual(classifyLines(sectionedText), legacyClassifyLines(sectionedText));
  assert.deepEqual(legacyExtractSteps(sectionedText).length, 2);
  assert.deepEqual(extractSteps(sectionedText).length, 1);
});
