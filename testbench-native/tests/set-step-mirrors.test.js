/**
 * The two editor mirrors of the `Set {{name}} to "…"` grammar
 * (stories/variable-assignment.md §What the scanners learn).
 *
 * The runtime reads that grammar in src/parser/set-step.ts; the extension's
 * completion/F12 scanner and the webview's Variables panel each re-state it,
 * for the reasons issue 035 documents. The FIXTURES table below is the same
 * set of authored lines the root suite's `tests/set-step.test.ts` pins the
 * runtime against — kept in step by hand, and checked here so a mirror that
 * drifts fails a test rather than an author.
 *
 * Each mirror sees less than the runtime does: they answer only "which name
 * does this line write", so `target` is null wherever the runtime would
 * refuse or ignore the line.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { captureNamesBefore } from '../src/extension/env-data-completion-core.ts';
import { collectVariables, classifyCaptureSource } from '../src/webview/lib/variables-panel.js';

/** authored instruction → the name it writes, or null. */
const FIXTURES = [
  { line: 'Set {{a}} to "b"', target: 'a' },
  { line: 'set {{a}} to "{{b}} and {{c}}"', target: 'a' },
  { line: 'SET {{a_1}} to ""', target: 'a_1' },
  { line: 'Set {{a}} to "say "hi""', target: null },
  { line: 'Set {{a}} to "x" and click "Save"', target: null },
  // The prefix the runtime strips before it reads the line at all.
  { line: '[no-hooks] Set {{a}} to "b"', target: 'a' },
  // Claims the form but does not parse — the runtime refuses the file, so the
  // editors must not offer a name for it either.
  { line: 'Set {{a}} to unquoted', target: null },
  { line: 'Set {{ a }} to "b"', target: null },
  { line: 'Set {{a}} to "b" trailing', target: null },
  // Never claims: prose the model handles.
  { line: 'Set the filter to Recent', target: null },
  { line: 'Set {{a}} using the dropdown', target: null },
  { line: 'Click Save', target: null },
];

test('extension scanner: writes match the runtime on every fixture row', () => {
  for (const { line, target } of FIXTURES) {
    const text = ['## Steps', `1. ${line}`, '2. done'].join('\n');
    // Read from the END of the file, so the write is in scope either way.
    const names = captureNamesBefore(text, 99).map((c) => c.name);
    if (target === null) {
      assert.deepEqual(names, [], `expected no write for: ${line}`);
    } else {
      assert.deepEqual(names, [target], `wrong write for: ${line}`);
    }
  }
});

test('extension scanner: a Set write is marked `set` and located on its line', () => {
  const text = ['## Steps', '1. Click Save', '2. Set {{summary}} to "x"'].join('\n');
  const [write] = captureNamesBefore(text, 99);
  assert.equal(write.name, 'summary');
  assert.equal(write.marker, 'set');
  assert.equal(write.line, 3);
});

test('extension scanner: a Set later in the run is not in scope earlier', () => {
  const text = ['## Steps', '1. Type "{{later}}"', '2. Set {{later}} to "x"'].join('\n');
  // Line index 1 is step 1 — the assignment on step 2 has not run yet.
  assert.deepEqual(captureNamesBefore(text, 1).map((c) => c.name), []);
});

test('variables panel: rows match the runtime on every fixture row', () => {
  for (const { line, target } of FIXTURES) {
    const text = ['## Steps', `1. ${line}`].join('\n');
    const names = collectVariables(text, {}, {}).map((r) => r.name);
    if (target === null) {
      assert.deepEqual(names, [], `expected no row for: ${line}`);
    } else {
      assert.deepEqual(names, [target], `wrong row for: ${line}`);
    }
  }
});

test('variables panel: a Set row appears before the run and fills in after', () => {
  const text = ['## Steps', '1. Set {{summary}} to "hello"'].join('\n');
  assert.deepEqual(collectVariables(text, {}, {}), [
    { name: 'summary', source: 'set', line: 2, value: undefined },
  ]);
  const filled = collectVariables(text, {}, { summary: 'hello' }, { summary: 'assignment' });
  assert.deepEqual(filled, [
    {
      name: 'summary',
      source: 'set',
      line: 2,
      value: 'hello',
      captureSource: 'assignment',
    },
  ]);
});

test('variables panel: a declared parameter still wins over a later Set row', () => {
  const text = [
    '## Parameters',
    '- summary: seed',
    '## Steps',
    '1. Set {{summary}} to "hello"',
  ].join('\n');
  const got = collectVariables(text, { summary: 'seed' }, {});
  assert.equal(got.length, 1);
  assert.equal(got[0].source, 'param');
});

test('classifyCaptureSource: knows assignment, and still collapses the unknown', () => {
  assert.equal(classifyCaptureSource('assignment'), 'assignment');
  assert.equal(classifyCaptureSource('toolOutput'), 'toolOutput');
  assert.equal(classifyCaptureSource('capture'), 'capture');
  // The back-compat rule the wire type mandates, and what makes adding a
  // third value safe for a client that predates it.
  assert.equal(classifyCaptureSource(undefined), 'capture');
  assert.equal(classifyCaptureSource('somethingNew'), 'capture');
});

test('extension scanner: locates the name exactly, even when it collides with `to`', () => {
  // `writesIn` used to find the name with `m[0].lastIndexOf(m[1])`, assuming
  // it is the match's last name-shaped token. The Set pattern's match ends
  // with the keyword ` to `, so `{{to}}`, `{{t}}` and `{{o}}` all located the
  // keyword instead — F12 and completion pointed at the wrong span. The `d`
  // flag's group indices are exact and need no assumption.
  for (const name of ['to', 't', 'o', 'name']) {
    const raw = `1. Set {{${name}}} to "x"`;
    const [write] = captureNamesBefore(['## Steps', raw].join('\n'), 99);
    assert.equal(write.name, name);
    assert.equal(write.column, raw.indexOf(`{{${name}}}`) + 2, `column for {{${name}}}`);
    assert.equal(write.length, name.length);
  }
});
