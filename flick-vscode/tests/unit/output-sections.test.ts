// Unit coverage for buildOutputSections — the pure logic behind the webview's
// source-tagged outputs panel (Captures / Tool Outputs / Parameters), including
// the delta filter and the older-server fallback. See
// stories/output-source-tagging.md test plan item 9.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutputSections } from '../../src/webview/output-sections';

test('empty outputs yields no sections', () => {
  assert.deepEqual(buildOutputSections({}, {}, undefined), []);
});

test('sections render in order Captures -> Tool Outputs -> Parameters', () => {
  const sections = buildOutputSections(
    { p: '1', c: '2', t: '3' },
    { p: 'parameter', c: 'capture', t: 'toolOutput' },
    undefined,
  );
  assert.deepEqual(
    sections.map((s) => s.kind),
    ['capture', 'toolOutput', 'parameter'],
  );
  assert.deepEqual(
    sections.map((s) => s.label),
    ['Captures', 'Tool Outputs', 'Parameters'],
  );
});

test('Parameters section is collapsed by default; others are not', () => {
  const sections = buildOutputSections(
    { p: '1', c: '2', t: '3' },
    { p: 'parameter', c: 'capture', t: 'toolOutput' },
    undefined,
  );
  const byKind = Object.fromEntries(sections.map((s) => [s.kind, s.collapsed]));
  assert.equal(byKind.capture, false);
  assert.equal(byKind.toolOutput, false);
  assert.equal(byKind.parameter, true);
});

test('a section is omitted when it has no entries', () => {
  const sections = buildOutputSections(
    { c: '2' },
    { c: 'capture' },
    undefined,
  );
  assert.deepEqual(
    sections.map((s) => s.kind),
    ['capture'],
  );
});

test('delta filter hides unchanged capture/toolOutput keys vs the previous batch', () => {
  const sections = buildOutputSections(
    { keep: 'new', same: 'unchanged', changed: 'v2', tool: 'tnew', toolSame: 'ts' },
    {
      keep: 'capture',
      same: 'capture',
      changed: 'capture',
      tool: 'toolOutput',
      toolSame: 'toolOutput',
    },
    { same: 'unchanged', changed: 'v1', toolSame: 'ts' },
  );
  const captures = sections.find((s) => s.kind === 'capture');
  const tools = sections.find((s) => s.kind === 'toolOutput');
  // `same` and `toolSame` are unchanged → filtered out. `changed` differs,
  // `keep`/`tool` are new → kept.
  assert.deepEqual(captures?.entries.map(([k]) => k).sort(), ['changed', 'keep']);
  assert.deepEqual(tools?.entries.map(([k]) => k), ['tool']);
});

test('parameters are NOT delta-filtered (stable for the session)', () => {
  const sections = buildOutputSections(
    { user: 'alice' },
    { user: 'parameter' },
    { user: 'alice' }, // identical to previous — still shown
  );
  const params = sections.find((s) => s.kind === 'parameter');
  assert.deepEqual(params?.entries, [['user', 'alice']]);
});

test('absent outputSources falls back to a single un-labelled Outputs block', () => {
  const sections = buildOutputSections(
    { a: '1', b: '2' },
    undefined,
    { a: '0' }, // delta is ignored in fallback mode
  );
  assert.equal(sections.length, 1);
  assert.equal(sections[0].kind, 'unknown');
  assert.equal(sections[0].label, 'Outputs');
  assert.equal(sections[0].collapsed, false);
  assert.deepEqual(sections[0].entries, [['a', '1'], ['b', '2']]);
});

test('a key present in outputs but missing from outputSources defaults to capture', () => {
  const sections = buildOutputSections(
    { mystery: 'v' },
    {}, // source map present but key absent
    undefined,
  );
  assert.equal(sections.length, 1);
  assert.equal(sections[0].kind, 'capture');
  assert.deepEqual(sections[0].entries, [['mystery', 'v']]);
});
