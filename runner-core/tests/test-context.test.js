// The test's own ## Context (docs/specs/SPEC-web-survey-fixes.md §2.46): free
// text the extension reads from the editor buffer and sends as `testContext`.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseContext } from '../dist/test-meta.js';

test('parseContext: keeps the section as written, selectors, frame ids and subheadings included', () => {
  const text = [
    '# Checkout',
    '',
    '## Context',
    'The form is in the iframe `#card-frame`.',
    '',
    '### After paying',
    'The receipt opens in a new tab.',
    '',
    '## Steps',
    '1. Click Buy',
  ].join('\n');
  assert.equal(
    parseContext(text),
    ['The form is in the iframe `#card-frame`.', '', '### After paying', 'The receipt opens in a new tab.'].join('\n'),
  );
});

test('parseContext: a heading inside a code fence is code, not the end of the section', () => {
  const text = ['## Context', '```', '## not a heading', '```', 'after', '## Steps', '1. x'].join('\n');
  assert.equal(parseContext(text), ['```', '## not a heading', '```', 'after'].join('\n'));
});

test('parseContext: undefined when the section is absent or empty', () => {
  assert.equal(parseContext(['# T', '', '## Steps', '1. x'].join('\n')), undefined);
  assert.equal(parseContext(['# T', '', '## Context', '', '## Steps', '1. x'].join('\n')), undefined);
});
