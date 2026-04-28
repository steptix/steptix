import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyLines,
  classifySelectedSteps,
  extractSteps,
  isStepLine,
  isTestFile,
  nearestStepAtOrAbove,
  nearestStepAtOrBelow,
} from '../dist/step-lines.js';

test('isTestFile: detects ## Steps', () => {
  assert.equal(isTestFile('## Steps'), true);
});

test('isTestFile: case-insensitive, ###+ allowed', () => {
  assert.equal(isTestFile('### steps'), true);
  assert.equal(isTestFile('#### STEPS'), true);
});

test('isTestFile: rejects when no Steps heading', () => {
  assert.equal(isTestFile('# Title\n\nSome prose.'), false);
});

test('isTestFile: rejects # Steps (level 1)', () => {
  assert.equal(isTestFile('# Steps'), false);
});

test('classifyLines: marks numbered items under ## Steps as steps', () => {
  const text = ['## Steps', '1. First', '2. Second', '3. Third'].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[0].kind, 'heading');
  assert.equal(lines[1].kind, 'step');
  assert.equal(lines[2].kind, 'step');
  assert.equal(lines[3].kind, 'step');
});

test('classifyLines: numbered items outside Steps section are prose', () => {
  const text = ['# Title', '1. Not a step', '## Steps', '1. Yes a step'].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[1].kind, 'prose');
  assert.equal(lines[3].kind, 'step');
});

test('classifyLines: indented numbered items are not steps', () => {
  const text = ['## Steps', '1. Outer', '  1. Sub', '2. Outer two'].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[1].kind, 'step');
  assert.equal(lines[2].kind, 'prose');
  assert.equal(lines[3].kind, 'step');
});

test('classifyLines: Steps section ends at next same-or-shallower heading', () => {
  const text = [
    '## Steps',
    '1. In section',
    '## Notes',
    '1. Not in section',
  ].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[1].kind, 'step');
  assert.equal(lines[3].kind, 'prose');
});

test('classifyLines: deeper headings inside Steps do not end the section', () => {
  const text = [
    '## Steps',
    '1. Outer',
    '### Subsection',
    '2. Still in steps',
  ].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[1].kind, 'step');
  assert.equal(lines[3].kind, 'step');
});

test('classifyLines: handles YAML frontmatter', () => {
  const text = [
    '---',
    'title: foo',
    '---',
    '## Steps',
    '1. Hi',
  ].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[0].kind, 'frontmatter');
  assert.equal(lines[2].kind, 'frontmatter');
  assert.equal(lines[3].kind, 'heading');
  assert.equal(lines[4].kind, 'step');
});

test('classifyLines: 1) style is not a step (documented limitation)', () => {
  const text = ['## Steps', '1) Not a step', '1. Yes a step'].join('\n');
  const lines = classifyLines(text);
  assert.equal(lines[1].kind, 'prose');
  assert.equal(lines[2].kind, 'step');
});

test('isStepLine + nearest helpers', () => {
  const text = ['# T', '## Steps', '1. one', '2. two', '', '3. three'].join('\n');
  assert.equal(isStepLine(text, 3), true);
  assert.equal(isStepLine(text, 5), false);
  assert.equal(nearestStepAtOrBelow(text, 5), 6);
  assert.equal(nearestStepAtOrBelow(text, 7), null);
  assert.equal(nearestStepAtOrAbove(text, 5), 4);
  assert.equal(nearestStepAtOrAbove(text, 1), null);
});

test('extractSteps: returns instructions with line numbers', () => {
  const text = ['## Steps', '1. Click button', '2. Wait for page'].join('\n');
  const steps = extractSteps(text);
  assert.deepEqual(steps, [
    { line: 2, instruction: 'Click button' },
    { line: 3, instruction: 'Wait for page' },
  ]);
});

// ---------------------------------------------------------------------------
// classifySelectedSteps — recognises [input:] / [interactive] markers
// ---------------------------------------------------------------------------

test('classifySelectedSteps: empty requestedLines runs every step', () => {
  const text = ['## Steps', '1. one', '2. two'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.deepEqual(got, [
    { kind: 'step', line: 2, instruction: 'one' },
    { kind: 'step', line: 3, instruction: 'two' },
  ]);
});

test('classifySelectedSteps: filters by requestedLines and preserves order', () => {
  const text = ['## Steps', '1. one', '2. two', '3. three'].join('\n');
  const got = classifySelectedSteps(text, [4, 2]); // out-of-order input
  assert.deepEqual(got, [
    { kind: 'step', line: 2, instruction: 'one' },
    { kind: 'step', line: 4, instruction: 'three' },
  ]);
});

test('classifySelectedSteps: tags [input: var] with prompt text', () => {
  const text = ['## Steps', '1. [input: username] Enter your username'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.deepEqual(got, [
    { kind: 'input', line: 2, varName: 'username', prompt: 'Enter your username' },
  ]);
});

test('classifySelectedSteps: [input: var] without prompt text uses default', () => {
  const text = ['## Steps', '1. [input: code]'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.equal(got[0].kind, 'input');
  assert.equal(got[0].varName, 'code');
  assert.equal(got[0].prompt, 'Enter value for {{code}}');
});

test('classifySelectedSteps: [interactive] tags with hint', () => {
  const text = ['## Steps', '1. [interactive] explore the page'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.deepEqual(got, [
    { kind: 'interactive', line: 2, hint: 'explore the page' },
  ]);
});

test('classifySelectedSteps: [interactive] without hint uses default', () => {
  const text = ['## Steps', '1. [interactive]'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.equal(got[0].kind, 'interactive');
  assert.match(got[0].hint, /done.*continue/i);
});

test('classifySelectedSteps: [input:] is case-insensitive', () => {
  const text = ['## Steps', '1. [INPUT: token] paste here', '2. [Interactive] poke'].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.equal(got[0].kind, 'input');
  assert.equal(got[0].varName, 'token');
  assert.equal(got[1].kind, 'interactive');
});

test('classifySelectedSteps: mixes step / input / interactive in order', () => {
  const text = [
    '## Steps',
    '1. open homepage',
    '2. [input: user] username?',
    '3. login as {{user}}',
    '4. [interactive] verify the dashboard',
    '5. logout',
  ].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.equal(got.length, 5);
  assert.equal(got[0].kind, 'step');
  assert.equal(got[1].kind, 'input');
  assert.equal(got[2].kind, 'step');
  assert.equal(got[3].kind, 'interactive');
  assert.equal(got[4].kind, 'step');
});

test('classifySelectedSteps: ignores [input:]-shaped text outside Steps section', () => {
  const text = [
    '# Notes',
    '1. [input: foo] not a step',
    '## Steps',
    '1. real step',
  ].join('\n');
  const got = classifySelectedSteps(text, []);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'step');
  assert.equal(got[0].instruction, 'real step');
});
