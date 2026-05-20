/**
 * Phase 5 manual e2e step 2 of 2: drive the full SSE protocol against a REAL
 * api-server child process running with --inspect=9229.
 *
 * What this proves:
 *   - The server boots cleanly with `node --inspect=9229 dist/index.js serve`
 *     (no parse errors from the new `debugger;` statement, no startup regressions
 *     from Phase 5 wiring).
 *   - The inspector port is live and accepting CDP traffic.
 *   - The full POST /sessions/:id/steps + tool:awaiting-debugger + POST
 *     /sessions/:id/tool-debugger-ack flow works against a real Node process
 *     with no vitest mocks anywhere.
 *   - The tool's `setVar` writes round-trip as `capture` events.
 *
 * What this does NOT prove:
 *   - VS Code's `vscode.debug.startDebugging` actually attaches to the
 *     inspector. The self-test (phase5-debugger-self-test.mjs) proves the
 *     `debugger;` statement IS observable to an attached CDP client; the
 *     specific VS Code → server attach is a Node debugger config issue that
 *     can't be verified outside a real keyboard-driven VS Code session.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const SERVER_PORT = 3100;
const INSPECTOR_PORT = 9229;
const API_KEY = '00000000-0000-0000-0000-000000000000';
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;

let serverProc = null;
let exitCode = 0;

function fail(msg) {
  console.error('FAIL:', msg);
  exitCode = 1;
}

async function pollUntil(url, label, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await delay(250);
  }
  throw new Error(`${label} not reachable within ${timeoutMs}ms`);
}

async function* sseEvents(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error('no response body');
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

try {
  console.log('[1/6] spawning server: node --inspect=' + INSPECTOR_PORT + ' dist/index.js serve');
  serverProc = spawn(
    'node',
    [`--inspect=${INSPECTOR_PORT}`, 'dist/index.js', 'serve'],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  );

  let serverStdout = '';
  serverProc.stdout.on('data', (d) => { serverStdout += d.toString(); });
  serverProc.stderr.on('data', (d) => { serverStdout += d.toString(); });

  // Wait for the inspector to be listening — Node prints "Debugger listening
  // on ws://..." to stderr at startup. Polling /json/version is the formal check.
  console.log('[2/6] waiting for inspector port', INSPECTOR_PORT);
  await pollUntil(
    `http://127.0.0.1:${INSPECTOR_PORT}/json/version`,
    'inspector',
    15_000,
  );
  const versionRes = await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/version`);
  const version = await versionRes.json();
  console.log('       inspector V8 version =', version['V8-Version']);

  console.log('[3/6] waiting for api-server port', SERVER_PORT);
  await pollUntil(`${BASE_URL}/sessions/anything`, 'api-server', 20_000).catch(async () => {
    // 401 on unauth GET still means the server is listening.
    const res = await fetch(`${BASE_URL}/sessions/anything`);
    if (res.status === 401) return true;
    throw new Error('api-server not reachable');
  });

  // Confirm the inspector still lists a script for our running process.
  const listRes = await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/list`);
  const listJson = await listRes.json();
  if (!Array.isArray(listJson) || listJson.length === 0) {
    fail('inspector /json/list returned empty — debugger client could not target the server process');
  } else {
    console.log('       inspector targets:', listJson.map((t) => t.title || t.id).join(', '));
  }

  console.log('[4/6] POST a tool step with pauseAtNextTool=true');
  const sessionId = 'phase5-e2e-' + Date.now();
  const url = `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
  const events = [];
  let sawAwaiting = false;
  let ackStatus = null;

  for await (const ev of sseEvents(url, {
    steps: ['[tool: uuid]'],
    sourceLines: [1],
    // toolsDir comes from the project's aiui.config.json via the server's
    // own resolution path — we don't need to send it explicitly.
    toolsDir: process.cwd() + '/fixtures/tools/src',
    pauseAtNextTool: true,
  })) {
    events.push(ev);
    if (ev.type === 'output') {
      // log lines from the server are noisy; skip
      continue;
    }
    console.log('       event:', ev.type, ev.line ?? '', ev.toolName ?? '');
    if (ev.type === 'tool:awaiting-debugger') {
      sawAwaiting = true;
      console.log('[5/6] ack the awaiting-debugger pause');
      const ackRes = await fetch(
        `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/tool-debugger-ack`,
        { method: 'POST', headers: { 'x-api-key': API_KEY } },
      );
      ackStatus = ackRes.status;
      console.log('       ack response:', ackStatus);
    }
    if (ev.type === 'done') break;
  }

  if (!sawAwaiting) fail('no tool:awaiting-debugger event from the real server');
  if (ackStatus !== 200) fail('ack returned ' + ackStatus + ' (expected 200)');

  const captures = events.filter((e) => e.type === 'capture');
  if (captures.length !== 1) {
    fail(`expected 1 capture event, got ${captures.length}`);
  } else if (!captures[0].value) {
    fail('capture event missing value');
  } else {
    console.log('       captured', captures[0].name, '=', captures[0].value);
  }

  const done = events.find((e) => e.type === 'done');
  console.log('[6/6] done event status =', done?.status);
  if (done?.status !== 'passed') fail('done status not passed: ' + done?.status);

  if (exitCode === 0) {
    console.log('\n✅ PASS: real server + Phase 5 wire protocol works end-to-end');
    console.log('   - inspector listens at ws://127.0.0.1:' + INSPECTOR_PORT);
    console.log('   - api-server boots with --inspect, no Phase 5 regressions');
    console.log('   - tool:awaiting-debugger / tool-debugger-ack / capture / done flow correct');
  } else {
    console.error('\n❌ at least one assertion failed — server stdout/stderr above');
  }
} catch (err) {
  console.error('harness threw:', err);
  exitCode = 1;
} finally {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
    await new Promise((r) => serverProc.once('exit', r));
  }
  process.exit(exitCode);
}
