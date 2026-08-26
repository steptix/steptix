/**
 * Where tool step-into attaches its debugger (story server-lifecycle §7).
 *
 * This is the fix for a silent failure: the extension used to attach to a
 * hardcoded `inspectorPort`, so if another node process held 9229 the attach
 * landed on THAT process, the ack released the server, its `debugger;` was a
 * no-op, and the user's breakpoint never hit with nothing to explain why.
 *
 * The decision is tested here rather than through the extension host because
 * `vscode.debug.startDebugging` cannot be exercised in the harness — a real
 * attach attempt to a port with no inspector hangs for ~10s.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveInspectorTarget,
  parseInspectorUrl,
  shouldReuseDebugSession,
} from '../src/extension/inspector-target.ts';

const SETTINGS = { host: '10.0.0.5', port: 9229 };
/** The attach target under test, for the session-reuse cases. */
const T = { host: '127.0.0.1', port: 53012 };

test('a ws URL from /health wins over the settings', () => {
  const target = resolveInspectorTarget('ws://127.0.0.1:53012/9f3a-abc', SETTINGS);
  assert.deepEqual(target, { kind: 'attach', host: '127.0.0.1', port: 53012, source: 'health' });
});

test('inspector: null means do NOT attach — the server has no inspector', () => {
  // The whole point: attaching to the settings port here is exactly the
  // wrong-process bug. "No inspector" is a fact, not a missing value.
  assert.deepEqual(resolveInspectorTarget(null, SETTINGS), { kind: 'none' });
});

test('undefined (no health data) falls back to the settings — the legacy path', () => {
  const target = resolveInspectorTarget(undefined, SETTINGS);
  assert.deepEqual(target, { kind: 'attach', host: '10.0.0.5', port: 9229, source: 'settings' });
});

test('an unparseable inspector URL falls back rather than refusing', () => {
  // Garbage is not evidence the server lacks an inspector, so `none` would be
  // the wrong answer — it would disable step-into on a server that has one.
  const target = resolveInspectorTarget('not a url', SETTINGS);
  assert.equal(target.kind, 'attach');
  assert.equal(target.source, 'settings');
});

test('0.0.0.0 and :: normalize to 127.0.0.1', () => {
  // A server started with --inspect=0.0.0.0:x reports the BIND address, which
  // Windows cannot dial. Without this the attach fails with a confusing error
  // on exactly the setup most likely to be used in a container/VM.
  assert.deepEqual(parseInspectorUrl('ws://0.0.0.0:9229/id'), { host: '127.0.0.1', port: 9229 });
  assert.deepEqual(parseInspectorUrl('ws://[::]:9229/id'), { host: '127.0.0.1', port: 9229 });
});

test('loopback spellings are all accepted', () => {
  assert.deepEqual(parseInspectorUrl('ws://localhost:1234/id'), { host: 'localhost', port: 1234 });
  assert.deepEqual(parseInspectorUrl('ws://[::1]:1234/id'), { host: '[::1]', port: 1234 });
});

test('a non-loopback inspector host is refused, not dialled', () => {
  // `inspector` arrives in an UNAUTHENTICATED /health body, and `service` is
  // a self-declared string — not proof of anything. A responder that named a
  // remote host would otherwise have VS Code's debug adapter connect out and
  // speak CDP to it. Tool step-into already requires a loopback SERVER_URL,
  // and a real Node inspector reports a local address, so nothing legitimate
  // is refused here.
  assert.equal(parseInspectorUrl('ws://attacker.example.com:9229/id'), null);
  assert.equal(parseInspectorUrl('ws://192.168.1.9:1234/id'), null);
});

test('a non-ws scheme is refused', () => {
  assert.equal(parseInspectorUrl('http://127.0.0.1:9229/id'), null);
  assert.equal(parseInspectorUrl('file:///etc/passwd'), null);
  // wss is legitimate, if unusual for a local inspector.
  assert.deepEqual(parseInspectorUrl('wss://127.0.0.1:9229/id'), { host: '127.0.0.1', port: 9229 });
});

test('a refused inspector URL falls back to the settings, not to "none"', () => {
  // Refusing to attach entirely would disable step-into; the settings are the
  // documented fallback and the user chose them.
  const target = resolveInspectorTarget('ws://attacker.example.com:9229/id', SETTINGS);
  assert.equal(target.kind, 'attach');
  assert.equal(target.source, 'settings');
});

test('a URL with no port is not a usable target', () => {
  assert.equal(parseInspectorUrl('ws://127.0.0.1/id'), null);
  assert.equal(parseInspectorUrl('nonsense'), null);
});

test('a session on our port but a different address is not reused', () => {
  assert.equal(
    shouldReuseDebugSession(
      { type: 'pwa-node', configuration: { port: 53012, address: '10.0.0.5' } },
      T,
    ),
    false,
  );
  assert.equal(
    shouldReuseDebugSession(
      { type: 'pwa-node', configuration: { port: 53012, address: '127.0.0.1' } },
      T,
    ),
    true,
  );
});

test('an existing pwa-node session is reused only when it is on OUR port', () => {
  assert.equal(shouldReuseDebugSession({ type: 'pwa-node', configuration: { port: 53012 } }, T), true);
  // The whole point of comparing ports: someone debugging an unrelated node
  // process must not suppress our attach, or we would ack the server against
  // a debugger pointed somewhere else.
  assert.equal(shouldReuseDebugSession({ type: 'pwa-node', configuration: { port: 9229 } }, T), false);
});

test('a non-pwa-node session is never reused', () => {
  // A Chrome devtools session is not the inspector we want.
  assert.equal(shouldReuseDebugSession({ type: 'pwa-chrome', configuration: { port: 53012 } }, T), false);
  assert.equal(shouldReuseDebugSession(undefined, T), false);
  assert.equal(shouldReuseDebugSession({ type: 'pwa-node' }, T), false);
});

test('a string port from the debug configuration still matches', () => {
  // Debug configurations round-trip through JSON, so the port can arrive as
  // a string; a strict === would silently re-attach every time.
  assert.equal(shouldReuseDebugSession({ type: 'pwa-node', configuration: { port: '53012' } }, T), true);
});

// ── stepsFileBreakpoints (stories/codebehind-debugging.md §Flow 1) ─────────

test('stepsFileBreakpoints: keeps only .steps.ts paths', async () => {
  const { stepsFileBreakpoints } = await import('../src/extension/inspector-target.ts');
  assert.deepEqual(
    stepsFileBreakpoints([
      String.raw`C:\p\tests\login.steps.ts`,
      '/p/tests/login.md',
      '/p/skills/auth.steps.ts',
      '/p/src/steps.ts', // not a .steps.ts — no dot before "steps"
      '/p/tests/LOGIN.STEPS.TS', // case-insensitive (Windows paths)
    ]),
    [
      String.raw`C:\p\tests\login.steps.ts`,
      '/p/skills/auth.steps.ts',
      '/p/tests/LOGIN.STEPS.TS',
    ],
  );
});

test('stepsFileBreakpoints: empty in, empty out', async () => {
  const { stepsFileBreakpoints } = await import('../src/extension/inspector-target.ts');
  assert.deepEqual(stepsFileBreakpoints([]), []);
});
