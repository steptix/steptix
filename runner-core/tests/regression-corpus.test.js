/**
 * Goal 4: a test file that uses none of the new grammar — no sections, no
 * ignored region — must classify **exactly** as it did before sections
 * existed.
 *
 * The guard is a reference implementation of the pre-change classifier,
 * checked in below, run against every real Markdown test file in the repo.
 *
 * ## What this proves, and what it does not
 *
 * Be honest about the shape of this suite: **the per-file rows cannot fail
 * for the classifier as it stands.** The new grammar has three kinds the
 * legacy classifier never emits: `section-heading`; `section-step`, which is
 * unreachable without a preceding `section-heading`; and `inert-step`, a
 * numbered item under a depth->=4 heading inside `## Steps` (contract §5 rule
 * 4a, added after this suite was written) that the legacy classifier called a
 * `step`. The corpus filter excludes exactly the documents that can produce
 * one — any that defines a section (`extractSections` emits an entry for
 * every `section-heading`) or carries an inert item — so the filter predicate
 * is logically equivalent to the property being asserted, and the corpus
 * partitions itself into "provably identical" and "excluded". An adversarial
 * review confirmed the section half empirically over 400k generated
 * documents: zero sectionless documents differ, zero sectioned ones agree.
 *
 * That equivalence is a *proof* of the Goal-4 property, not evidence for it —
 * so do not read the green rows as validation that the classification change
 * is correct. The frozen tables in `fixtures/sections/classification.json`
 * are what does that job.
 *
 * What this suite is genuinely for is **future** edits. The equivalence holds
 * only while the new classifier's extra branches are exactly those three
 * kinds; any later change to span handling, frontmatter, heading depth or step
 * recognition breaks it and surfaces here as a concrete file and line, on
 * real documents rather than on synthetic ones. A change that adds a fourth
 * kind on purpose has to widen the filter below, the way `inert-step` did —
 * otherwise the first corpus document that uses it fails every row for an
 * intended behaviour.
 *
 * The corpus is filtered by **property**, never by path —
 * `fixtures/tests/sections-demo.md` already lives in a directory this walks,
 * and `templates/init/tests/sections-demo.md` lands there later in the
 * feature. Hard-coding `fixtures/sections/` would silently start comparing a
 * sectioned file against a classifier that predates sections.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  classifyLines,
  extractSections,
  extractSteps,
  isTestFile,
  resolveRunSelection,
} from '../dist/step-lines.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const CORPUS_ROOTS = [
  'fixtures',
  'templates',
  path.join('steptix-vscode', 'tests', 'integration', 'fixtures'),
];

/**
 * `fixtures/tools/node_modules` is a real installed tree — walking it costs
 * minutes and sweeps in third-party READMEs that happen to carry a `## Steps`
 * heading. Skip it and the other generated directories.
 *
 * Dot-directories are skipped too: `.steptix/` (CDP browser profiles —
 * thousands of files in a checkout that has run a browser), the
 * `.steptix-codebehind-cache` and `.steptix-tool-cache` dirs. None holds a
 * test document, and a live run or an open browser creates and deletes files
 * in them while this walks.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function walk(dir, out = []) {
  let entries;
  try {
    // Dirents, so there is no per-entry stat for a deleted file to throw on.
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** The file's text, or null when it went away between the walk and the read. */
function readIfPresent(file) {
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const corpus = CORPUS_ROOTS.flatMap((root) => walk(path.join(REPO, root)))
  .map((file) => ({ file: path.relative(REPO, file), text: readIfPresent(file) }))
  .filter((entry) => entry.text !== null && isTestFile(entry.text));

/** Uses grammar the legacy classifier predates: a section, or an ignored region. */
const usesNewGrammar = (text) =>
  extractSections(text).length > 0 || classifyLines(text).some((l) => l.kind === 'inert-step');

const untouched = corpus.filter((entry) => !usesNewGrammar(entry.text));
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

test('the corpus is real: enough untouched files, and at least one sectioned', () => {
  // A silently-empty corpus would make every assertion below vacuous.
  assert.ok(untouched.length >= 20, `only ${untouched.length} files the new grammar leaves untouched`);
  // And the filter must actually be excluding something, or it is untested.
  assert.ok(
    sectioned.length >= 1,
    'no sectioned file in the corpus — the by-property filter is unexercised',
  );
});

for (const { file, text } of untouched) {
  test(`unchanged classification: ${file}`, () => {
    assert.deepEqual(classifyLines(text), legacyClassifyLines(text));
  });

  test(`unchanged steps: ${file}`, () => {
    assert.deepEqual(extractSteps(text), legacyExtractSteps(text));
    // Run All: what an empty selection resolves to.
    assert.deepEqual(resolveRunSelection(text, []), {
      scope: 'main-flow',
      lines: legacyExtractSteps(text).map((s) => s.line),
    });
  });
}

test('the reference classifier really can disagree', () => {
  // Without this, a bug that made `legacyClassifyLines` identical to the new
  // one would turn every assertion above into a tautology.
  const sectionedText = ['## Steps', '1. Login', '', '### Login', '1. Body'].join('\n');
  assert.notDeepEqual(classifyLines(sectionedText), legacyClassifyLines(sectionedText));
  assert.deepEqual(legacyExtractSteps(sectionedText).length, 2);
  assert.deepEqual(extractSteps(sectionedText).length, 1);
  // A sectionless document can disagree too — through an ignored region —
  // which is why the corpus filter has a second half.
  const inertText = ['## Steps', '1. One', '', '#### Notes', '2. Inert'].join('\n');
  assert.equal(extractSections(inertText).length, 0);
  assert.notDeepEqual(classifyLines(inertText), legacyClassifyLines(inertText));
  assert.equal(usesNewGrammar(inertText), true);
});
