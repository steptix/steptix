/**
 * The two editor mirrors of the `Set {{name}} to "…"` grammar must agree with
 * the RUNTIME — checked by calling it, not against hand-copied rows
 * (stories/variable-assignment.md §What the scanners learn).
 *
 * The hand-copied version of this file is why the `[no-hooks]` gap sat in both
 * mirrors at once, and by the time a reviewer counted them the two tables had
 * already drifted — 11 rows here, 12 there. So this now imports
 * `parseSetStep` itself (it has no imports of its own, so it loads cleanly
 * under Node's type stripping) and derives every expectation from it. The
 * shared line list lives in `fixtures/set-step/grammar-lines.json`; the root
 * suite pins what the runtime DOES with each line, and this file pins that
 * the editors agree. Same split, and same reasoning, as
 * `tests/invocation-mirror-parity.test.ts`.
 *
 * Each mirror sees less than the runtime: they answer only "which name does
 * this line write", so a line the runtime refuses must yield no name here.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseSetStep } from '../../src/parser/set-step.ts';
import { captureNamesBefore } from '../src/extension/env-data-completion-core.ts';
import { collectVariables, classifyCaptureSource } from '../src/webview/lib/variables-panel.js';

const here = dirname(fileURLToPath(import.meta.url));
const LINES = JSON.parse(
  readFileSync(resolve(here, '../../fixtures/set-step/grammar-lines.json'), 'utf8'),
).lines;

/** The runtime's own answer, with the `[no-hooks]` marker stripped the way
 *  `extractSteps` strips it before a step ever reaches the parser. */
function runtimeTarget(line) {
  return parseSetStep(line.replace(/^\[no-hooks\]\s*/i, ''))?.name ?? null;
}

test('the fixture list actually exercises both outcomes', () => {
  // A parity check over rows that all answer the same way proves nothing.
  const targets = LINES.map(runtimeTarget);
  assert.ok(targets.some((t) => t !== null), 'no row the runtime accepts');
  assert.ok(targets.some((t) => t === null), 'no row the runtime refuses');
});

test('extension scanner agrees with the runtime on every fixture line', () => {
  for (const line of LINES) {
    const text = ['## Steps', `1. ${line}`, '2. done'].join('\n');
    const names = captureNamesBefore(text, 99).map((c) => c.name);
    const expected = runtimeTarget(line);
    assert.deepEqual(
      names,
      expected === null ? [] : [expected],
      `extension scanner disagrees with the runtime on: ${line}`,
    );
  }
});

test('variables panel agrees with the runtime on every fixture line', () => {
  for (const line of LINES) {
    const text = ['## Steps', `1. ${line}`].join('\n');
    const names = collectVariables(text, {}, {}).map((r) => r.name);
    const expected = runtimeTarget(line);
    assert.deepEqual(
      names,
      expected === null ? [] : [expected],
      `variables panel disagrees with the runtime on: ${line}`,
    );
  }
});

test('extension scanner: a Set write is marked `set` and located on its line', () => {
  const text = ['## Steps', '1. Click Save', '2. Set {{summary}} to "x"'].join('\n');
  const [write] = captureNamesBefore(text, 99);
  assert.equal(write.name, 'summary');
  assert.equal(write.marker, 'set');
  assert.equal(write.line, 3);
});

test('extension scanner: locates the name exactly, even when it collides with `to`', () => {
  // `writesIn` used to find the name with `m[0].lastIndexOf(m[1])`, assuming
  // it is the match's last name-shaped token. The Set pattern's match ends
  // with the keyword ` to `, so `{{to}}`, `{{t}}` and `{{o}}` all located the
  // keyword instead — F12 and completion pointed at the wrong span.
  for (const name of ['to', 't', 'o', 'name']) {
    const raw = `1. Set {{${name}}} to "x"`;
    const [write] = captureNamesBefore(['## Steps', raw].join('\n'), 99);
    assert.equal(write.name, name);
    assert.equal(write.column, raw.indexOf(`{{${name}}}`) + 2, `column for {{${name}}}`);
    assert.equal(write.length, name.length);
  }
});

test('extension scanner: a Set later in the run is not in scope earlier', () => {
  const text = ['## Steps', '1. Type "{{later}}"', '2. Set {{later}} to "x"'].join('\n');
  assert.deepEqual(captureNamesBefore(text, 1).map((c) => c.name), []);
});

test('variables panel: a Set row appears before the run and fills in after', () => {
  const text = ['## Steps', '1. Set {{summary}} to "hello"'].join('\n');
  assert.deepEqual(collectVariables(text, {}, {}), [
    { name: 'summary', source: 'set', line: 2, value: undefined },
  ]);
  const filled = collectVariables(text, {}, { summary: 'hello' }, { summary: 'assignment' });
  assert.deepEqual(filled, [
    { name: 'summary', source: 'set', line: 2, value: 'hello', captureSource: 'assignment' },
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
