/**
 * Code-behind debugging live e2e (stories/codebehind-debugging.md §Test plan).
 *
 * Drives the WHOLE flow against a REAL server child process — no vitest
 * mocks, real browser session, real esbuild code-behind load — and, unlike
 * the vitest suite, proves the two claims only a live inspector can prove:
 *
 *   1. the cooperative `debugger;` before `entry.run()` actually traps: a raw
 *      CDP client attached to the server's inspector observes a
 *      `Debugger.paused` with reason "debuggerStatement" right after the ack,
 *      and the run completes after `Debugger.resume`;
 *   2. the bundled temp module the pause lands in carries an inline sourcemap
 *      whose `sources` resolve to the CANONICAL `.steps.ts` on disk — the
 *      exact contract vscode-js-debug uses to bind user breakpoints in that
 *      file.
 *
 * What this still does not prove: VS Code's own `startDebugging` attach.
 * That half is a config already shipped and manually verified by tool
 * step-into; the story's manual checklist covers the F9/F11 hand check.
 *
 * Usage:  node scripts/codebehind-debugger-e2e.mjs
 * (from the checkout root; uses port 3199 for the server, 9231 for the
 * inspector, and a scratch project under the OS temp dir.)
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

// Overridable, because a fixed port is exactly what CLAUDE.md warns about for
// worktrees: "nothing else may be listening on 3100, or the suite silently
// tests the OTHER checkout's src/". The readiness probe below cannot tell our
// server from a stranger's, so a collision would assert against a different
// checkout's dist/ and still print PASS.
const SERVER_PORT = Number(process.env.CB_E2E_SERVER_PORT ?? 3199);
const INSPECTOR_PORT = Number(process.env.CB_E2E_INSPECTOR_PORT ?? 9231);
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;

let serverProc = null;
let exitCode = 0;
let scratchDir = null;

function fail(msg) {
  console.error('FAIL:', msg);
  exitCode = 1;
}

/** AIUI_SERVER_API_KEY from the checkout's .env (seeded by init-worktree). */
async function readApiKey() {
  const envText = await fs.readFile(path.join(process.cwd(), '.env'), 'utf-8');
  const line = envText.split(/\r?\n/).find((l) => l.startsWith('AIUI_SERVER_API_KEY='));
  if (!line) throw new Error('AIUI_SERVER_API_KEY not found in .env');
  return line.slice('AIUI_SERVER_API_KEY='.length).trim();
}

async function pollUntil(probe, label, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await probe()) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`${label} not ready within ${timeoutMs}ms`);
}

async function* sseEvents(url, body, apiKey) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error(`no response body (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        yield JSON.parse(dataLine.slice(6));
      } catch {}
    }
  }
}

/**
 * Minimal CDP client over Node's built-in WebSocket. Collects scriptParsed
 * notifications and lets the caller await the next Debugger.paused.
 */
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.scripts = new Map(); // scriptId -> { url, sourceMapURL }
    this.pausedWaiters = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Debugger.scriptParsed') {
        this.scripts.set(msg.params.scriptId, {
          url: msg.params.url,
          sourceMapURL: msg.params.sourceMapURL,
        });
      }
      if (msg.method === 'Debugger.paused') {
        for (const w of this.pausedWaiters.splice(0)) w(msg.params);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
    });
    return new CdpClient(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  nextPaused(timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no Debugger.paused within ' + timeoutMs + 'ms')), timeoutMs);
      this.pausedWaiters.push((params) => {
        clearTimeout(t);
        resolve(params);
      });
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

const BOUND_STEP = 'Set the bound marker variable';

try {
  const apiKey = await readApiKey();

  // ── Scratch project: a test path + sibling .steps.ts, nothing else. ──────
  // No node_modules on purpose: the entry imports 'ai-ui-automation/codebehind'
  // and must resolve through the server's self-resolving loader (PR #78).
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-debug-e2e-'));
  const testFilePath = path.join(scratchDir, 'debugme.md');
  const stepsFilePath = path.join(scratchDir, 'debugme.steps.ts');
  await fs.writeFile(
    stepsFilePath,
    `import { defineSteps } from 'ai-ui-automation/codebehind';

export default defineSteps([
  {
    source: ${JSON.stringify(BOUND_STEP)},
    async run({ step }) {
      step.setVar('bound', 'ran');
    },
  },
]);
`,
  );

  console.log('[1/7] spawning server: node --inspect=%d dist/index.js serve -p %d', INSPECTOR_PORT, SERVER_PORT);
  serverProc = spawn(
    'node',
    [`--inspect=${INSPECTOR_PORT}`, 'dist/index.js', 'serve', '-p', String(SERVER_PORT)],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  );
  let serverOut = '';
  serverProc.stdout.on('data', (d) => { serverOut += d.toString(); });
  serverProc.stderr.on('data', (d) => { serverOut += d.toString(); });

  console.log('[2/7] waiting for inspector + api-server');
  await pollUntil(async () => (await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/version`)).ok, 'inspector', 15_000);
  await pollUntil(async () => {
    const res = await fetch(`${BASE_URL}/health`).catch(() => null);
    return res !== null && res.ok;
  }, 'api-server', 30_000);

  const health = await (await fetch(`${BASE_URL}/health`)).json();
  // Is this OUR server? The probe above only proves SOMETHING answers on the
  // port. Another checkout's server (or a stale one) would be asserted
  // against instead, reporting PASS for a `dist/` this run never built — the
  // silent-wrong-checkout failure CLAUDE.md calls out for worktrees.
  if (serverProc.exitCode !== null) {
    fail(
      `server exited before readiness (code ${serverProc.exitCode}) — ` +
        `something else is serving :${SERVER_PORT}. Set CB_E2E_SERVER_PORT.`,
    );
  }
  if (health.pid !== serverProc.pid) {
    fail(
      `:${SERVER_PORT} is served by pid ${health.pid}, not the server this run ` +
        `spawned (pid ${serverProc.pid}). Set CB_E2E_SERVER_PORT to a free port.`,
    );
  }
  console.log('       /health inspector =', health.inspector);
  if (typeof health.inspector !== 'string' || !health.inspector.startsWith('ws://')) {
    fail('/health did not report a ws:// inspector URL');
  }

  console.log('[3/7] attaching raw CDP client to the inspector');
  const list = await (await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/list`)).json();
  const target = Array.isArray(list) && list[0]?.webSocketDebuggerUrl;
  if (!target) throw new Error('no webSocketDebuggerUrl in /json/list');
  const cdp = await CdpClient.connect(target);
  await cdp.send('Debugger.enable');

  console.log('[4/7] POST the bound step with pauseAtNextCodeBehind=true');
  const sessionId = 'cb-e2e-' + Date.now();
  const url = `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
  const events = [];
  let awaitingEvent = null;
  let pausedParams = null;

  for await (const ev of sseEvents(url, {
    steps: [BOUND_STEP],
    sourceLines: [7],
    testFilePath,
    pauseAtNextCodeBehind: true,
  }, apiKey)) {
    events.push(ev);
    if (ev.type === 'output') continue;
    console.log('       event:', ev.type, ev.line ?? '', ev.file ?? '');
    if (ev.type === 'codebehind:awaiting-debugger') {
      awaitingEvent = ev;
      // Arm the paused-waiter BEFORE acking, then release the server.
      const pausedPromise = cdp.nextPaused(15_000);
      console.log('[5/7] ack — expecting Debugger.paused at the cooperative debugger;');
      const ackRes = await fetch(
        `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/tool-debugger-ack`,
        { method: 'POST', headers: { 'x-api-key': apiKey } },
      );
      if (ackRes.status !== 200) fail(`ack returned ${ackRes.status}`);
      pausedParams = await pausedPromise;
      console.log('       paused, reason =', pausedParams.reason);
      await cdp.send('Debugger.resume');
    }
    if (ev.type === 'done') break;
  }

  console.log('[6/7] checking the wire + pause facts');
  if (!awaitingEvent) {
    fail('no codebehind:awaiting-debugger event from the real server');
  } else {
    if (awaitingEvent.file !== stepsFilePath) {
      fail(`awaiting event file = ${awaitingEvent.file}, expected ${stepsFilePath}`);
    }
    if (awaitingEvent.line !== 7) fail(`awaiting event line = ${awaitingEvent.line}, expected 7`);
  }
  if (!pausedParams) {
    fail('CDP client never saw Debugger.paused');
  } else {
    if (pausedParams.reason !== 'debuggerStatement' && pausedParams.reason !== 'other') {
      fail(`pause reason = ${pausedParams.reason} (expected debuggerStatement)`);
    }
    // The pause lands in execute.ts (where the `debugger;` lives). The claim
    // that matters for F9 breakpoints is one frame over: the freshly-bundled
    // temp module for OUR steps file was parsed with an inline sourcemap
    // whose sources resolve back to the canonical .steps.ts.
    const cacheDirName = '.aiui-codebehind-cache';
    const bundled = [...cdp.scripts.values()].filter(
      (s) => s.url.includes(cacheDirName) && s.url.endsWith('.mjs'),
    );
    if (bundled.length === 0) {
      fail('no bundled code-behind temp module appeared in scriptParsed');
    } else {
      const script = bundled[bundled.length - 1];
      if (!script.sourceMapURL?.startsWith('data:')) {
        fail(`bundled module has no inline sourceMapURL (got: ${String(script.sourceMapURL).slice(0, 60)})`);
      } else {
        const b64 = script.sourceMapURL.slice(script.sourceMapURL.indexOf('base64,') + 'base64,'.length);
        const map = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
        const resolved = new URL(map.sources[0], script.url);
        const expected = pathToFileURL(stepsFilePath);
        if (resolved.href.toLowerCase() !== expected.href.toLowerCase()) {
          fail(`sourcemap sources[0] resolves to ${resolved.href}, expected ${expected.href}`);
        } else {
          console.log('       sourcemap sources[0] →', resolved.href, '(canonical .steps.ts ✓)');
        }
        if (!Array.isArray(map.sourcesContent) || !map.sourcesContent[0]) {
          fail('sourcemap has no sourcesContent (js-debug uses it when the file moves)');
        }
      }
    }
  }

  // The entry-ran proof: the step passed AS CODE (`fromCodeBehind`), and its
  // `setVar('bound','ran')` landed in the session scope (code-behind outputs
  // surface via `frame:scope`, not `capture` — that event is tool/[output:]
  // provenance).
  const pass = events.find((e) => e.type === 'step:pass');
  if (pass?.fromCodeBehind !== true) {
    fail(`step:pass lacks fromCodeBehind — the entry did not run as code (got ${JSON.stringify(pass)})`);
  }
  const scoped = events.some(
    (e) => e.type === 'frame:scope' && e.scope && e.scope.bound === 'ran',
  );
  if (!scoped) fail("entry's setVar('bound') never appeared in a frame:scope");
  const done = events.find((e) => e.type === 'done');
  console.log('[7/7] done status =', done?.status);
  if (done?.status !== 'passed') fail('done status not passed: ' + done?.status);

  cdp.close();

  if (exitCode === 0) {
    console.log('\n✅ PASS: code-behind debugging works end-to-end on a real server');
    console.log('   - /health publishes the inspector URL the extension attaches to');
    console.log('   - codebehind:awaiting-debugger names the canonical .steps.ts + line');
    console.log('   - ack → real Debugger.paused at the cooperative debugger; → resume → entry ran');
    console.log('   - bundled module carries an inline sourcemap resolving to the .steps.ts (F9 contract)');
  } else {
    console.error('\n❌ at least one assertion failed');
    console.error('server output tail:\n' + serverOut.split('\n').slice(-25).join('\n'));
  }
} catch (err) {
  console.error('harness threw:', err);
  exitCode = 1;
} finally {
  // `exitCode === null` means still running. `killed` is NOT that test: it
  // only records whether a signal was ever delivered, so a server that died
  // on its own (EADDRINUSE, no dist/) left `killed === false`, the kill a
  // no-op on a dead pid, and `once('exit')` waiting for an event that had
  // already fired — the script hung instead of reporting the failure, on
  // exactly the case the fixed port makes likely.
  if (serverProc && serverProc.exitCode === null && serverProc.signalCode === null) {
    const exited = new Promise((r) => serverProc.once('exit', r));
    serverProc.kill('SIGTERM');
    // SIGTERM is TerminateProcess on Windows, so the server's own shutdown
    // handler does not run; don't wait on it forever either.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
}
