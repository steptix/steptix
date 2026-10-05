import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isSkippedPass, isWebviewMsg } from '../dist/protocol.js';

const PROTOCOL_SRC = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'protocol.ts'),
  'utf-8',
);

/**
 * The `type:` literal of every member of `WebviewToHostMsg`, read from the
 * union in src/protocol.ts. The guard is a hand-kept `t === …` chain, so a
 * hand-kept list here could only ever agree with it — the one drift worth
 * catching is a type added to the union and forgotten in the guard, and only
 * the union itself knows about that type.
 */
function webviewMsgTypes() {
  const union = /export type WebviewToHostMsg =([^;]+);/.exec(PROTOCOL_SRC);
  assert.ok(union, 'WebviewToHostMsg union not found in src/protocol.ts');
  const members = union[1].split('|').map((s) => s.trim()).filter(Boolean);
  return members.map((name) => {
    const decl = new RegExp(`export interface ${name}\\s*\\{[^}]*?\\btype:\\s*'([^']+)'`).exec(PROTOCOL_SRC);
    assert.ok(decl, `no \`type: '…'\` literal found on interface ${name}`);
    return decl[1];
  });
}

test('isWebviewMsg: accepts every member of the WebviewToHostMsg union', () => {
  // runner-view.ts drops whatever this guard rejects, so a panel message
  // whose type is missing from it does nothing at all — silently.
  const types = webviewMsgTypes();
  // The parse found the union, not a fragment of it.
  assert.ok(types.length >= 20, `only ${types.length} members parsed`);
  for (const type of types) {
    assert.equal(isWebviewMsg({ type }), true, type);
  }
});

test('isWebviewMsg: rejects garbage', () => {
  assert.equal(isWebviewMsg({}), false);
  assert.equal(isWebviewMsg({ type: 'init' }), false);
  assert.equal(isWebviewMsg(null), false);
  assert.equal(isWebviewMsg('run'), false);
});

test('isSkippedPass: a pass carrying output "skipped" is a step that never ran', () => {
  // The wire has no third verdict, so an untaken branch — and the body of a
  // `While` that never entered — arrives as a PASS with `output: 'skipped'`
  // (stories/control-flow.md). Every surface that derives a glyph or a log
  // line from `step:pass` asks this first; three of six used not to, and
  // painted a step that did nothing green.
  assert.equal(isSkippedPass({ type: 'step:pass', line: 5, output: 'skipped' }), true);
});

test('isSkippedPass: every other pass is a real one', () => {
  assert.equal(isSkippedPass({ type: 'step:pass', line: 5 }), false);
  assert.equal(isSkippedPass({ type: 'step:pass', line: 5, output: '' }), false);
  // The reasoning a guard carries is an ordinary output, not the sentinel.
  assert.equal(
    isSkippedPass({ type: 'step:pass', line: 5, output: 'the Cash checkbox is ticked' }),
    false,
  );
  // Near misses are not the sentinel either — it is one exact string.
  assert.equal(isSkippedPass({ type: 'step:pass', line: 5, output: 'Skipped' }), false);
  assert.equal(isSkippedPass({ type: 'step:pass', line: 5, output: 'skipped: no branch held' }), false);
});
