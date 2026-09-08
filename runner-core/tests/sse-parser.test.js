import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SseParser } from '../dist/sse-parser.js';

test('parses a single complete frame', () => {
  const parser = new SseParser();
  const frames = parser.push('event: step:pass\ndata: {"line":1}\n\n');
  assert.deepEqual(frames, [{ event: 'step:pass', data: '{"line":1}' }]);
});

test('joins multi-line data with newline', () => {
  const parser = new SseParser();
  const frames = parser.push('data: line1\ndata: line2\n\n');
  assert.deepEqual(frames, [{ event: 'message', data: 'line1\nline2' }]);
});

test('handles partial chunks across push() calls', () => {
  const parser = new SseParser();
  assert.equal(parser.push('event: done\nda').length, 0);
  assert.equal(parser.push('ta: {"status":').length, 0);
  const frames = parser.push('"passed"}\n\n');
  assert.deepEqual(frames, [{ event: 'done', data: '{"status":"passed"}' }]);
});

test('comments (lines starting with :) are ignored', () => {
  const parser = new SseParser();
  const frames = parser.push(':keepalive\nevent: x\ndata: y\n\n');
  assert.deepEqual(frames, [{ event: 'x', data: 'y' }]);
});

test('handles \\r\\n line endings', () => {
  const parser = new SseParser();
  const frames = parser.push('event: a\r\ndata: b\r\n\r\n');
  assert.deepEqual(frames, [{ event: 'a', data: 'b' }]);
});

test('multiple frames in one chunk', () => {
  const parser = new SseParser();
  const frames = parser.push(
    'event: step:start\ndata: {"line":1}\n\nevent: step:pass\ndata: {"line":1}\n\n',
  );
  assert.equal(frames.length, 2);
  assert.equal(frames[0].event, 'step:start');
  assert.equal(frames[1].event, 'step:pass');
});

test('parses a step:skip frame like any other event type', () => {
  // The parser is deliberately type-agnostic — it has no whitelist of event
  // names — so a wire event added on the server (here `step:skip`, from
  // stories/step-flow-control.md) reaches a client built before it existed.
  // Pinned because the tempting "safety" version of this parser, a switch
  // over known event names, would silently drop every event added after it.
  const p = new SseParser();
  const wire = [
    'event: step:skip',
    'data: {"type":"step:skip","line":9,"reason":"Not run: step 3 returned from x"}',
    '',
    '',
  ].join('\n');
  const frames = p.push(wire);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'step:skip');
  const parsed = JSON.parse(frames[0].data);
  assert.equal(parsed.type, 'step:skip');
  assert.equal(parsed.line, 9);
  assert.equal(parsed.reason, 'Not run: step 3 returned from x');
});
