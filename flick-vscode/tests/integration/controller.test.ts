// Integration tests for FlickController — the heart of the extension host.
//
// These run the controller for real against:
//   * a real HTTP server implementing the Sessions API (FakeApiServer),
//   * a real on-disk Store in a temp directory,
//   * a fake webview that captures posted messages and injects user actions,
//   * a fake `vscode` module (aliased in by esbuild.test.js).
//
// So every layer below the controller — the API client, global fetch, JSON
// handling, screenshot decode/write, and JSON persistence — is exercised end
// to end. Only the VS Code host surface is faked.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FlickController } from '../../src/extension/controller';
import { Store } from '../../src/extension/store';
import type { HostToWebview } from '../../src/shared/protocol';
import { FakeApiServer, failedBatch } from '../fakes/fake-api-server';
import { FakeWebview, delay } from '../fakes/fake-webview';
import { __reset, __setConfig, __setWarningResponse } from '../fakes/vscode';

type Msg<T extends HostToWebview['type']> = Extract<HostToWebview, { type: T }>;

describe('FlickController', () => {
  let server: FakeApiServer;
  let dir: string;
  let controller: FlickController | undefined;

  beforeEach(async () => {
    __reset();
    server = new FakeApiServer();
    await server.start();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flick-test-'));
    __setConfig('flick.apiUrl', server.url);
    __setConfig('flick.apiKey', 'test-key');
  });

  afterEach(async () => {
    controller?.dispose();
    controller = undefined;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Boot a controller, attach a fresh fake webview, and complete the handshake. */
  async function boot(): Promise<FakeWebview> {
    controller = new FlickController(new Store(dir));
    await controller.start();
    const fw = new FakeWebview();
    controller.attachWebview(fw as never);
    fw.send({ type: 'ready' });
    await fw.waitFor((m) => m.type === 'init');
    return fw;
  }

  function wait<T extends HostToWebview['type']>(fw: FakeWebview, type: T): Promise<Msg<T>> {
    return fw.waitFor<Msg<T>>((m) => m.type === type);
  }

  /** Create one session and return its id. Call once per test. */
  async function createSession(fw: FakeWebview): Promise<string> {
    fw.send({ type: 'newSession' });
    const msg = await wait(fw, 'sessions');
    return msg.sessions[msg.sessions.length - 1].id;
  }

  const stepsRequests = () => server.requests.filter((r) => /\/steps$/.test(r.path));

  test('ready handshake yields an init snapshot, then newSession creates an active tab', async () => {
    const fw = await boot();

    const init = fw.last<Msg<'init'>>('init');
    assert.ok(init, 'expected an init message');
    assert.deepEqual(init.sessions, []);
    assert.equal(init.activeSessionId, null);

    fw.drain();
    fw.send({ type: 'newSession' });

    const sessions = await wait(fw, 'sessions');
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].name, 'New Session');
    assert.equal(sessions.activeSessionId, sessions.sessions[0].id);

    const history = await wait(fw, 'history');
    assert.deepEqual(history.entries, []);
  });

  test('submitting steps echoes input, shows a pending card, then a passed result with a saved screenshot', async () => {
    const fw = await boot();
    const sessionId = await createSession(fw);
    fw.drain();

    fw.send({
      type: 'submitSteps',
      sessionId,
      rawText: '1. Navigate to example.com\n2. Click login',
    });
    const replace = await wait(fw, 'historyReplace');

    // The user card is echoed verbatim, then a pending placeholder.
    const appends = fw.allOf<Msg<'historyAppend'>>('historyAppend');
    assert.equal(appends.length, 2);
    const userEntry = appends[0].entry;
    assert.equal(userEntry.kind, 'user');
    if (userEntry.kind === 'user') {
      assert.equal(userEntry.text, '1. Navigate to example.com\n2. Click login');
    }
    assert.equal(appends[1].entry.kind, 'pending');

    // Busy toggled on then off.
    assert.deepEqual(
      fw.allOf<Msg<'busy'>>('busy').map((b) => b.busy),
      [true, false],
    );

    // The result card replaces the pending entry by id.
    assert.equal(replace.entryId, appends[1].entry.id);
    const entry = replace.entry;
    assert.equal(entry.kind, 'result');
    if (entry.kind !== 'result') throw new Error('unreachable');
    assert.equal(entry.batch.status, 'passed');
    assert.equal(entry.batch.stepsTotal, 2);
    assert.equal(entry.batch.results.length, 2);
    // List prefixes were stripped before the steps reached the API.
    assert.equal(entry.batch.results[0].step, 'Navigate to example.com');
    assert.equal(entry.batch.results[1].step, 'Click login');
    // Screenshots come back as webview-resolvable URIs, not raw paths.
    assert.match(entry.batch.results[0].screenshotUri ?? '', /^vscode-webview:\/\/flick/);

    // The screenshots were genuinely decoded and written to disk as PNGs.
    const shotDir = path.join(dir, 'screenshots', sessionId);
    const files = fs.readdirSync(shotDir);
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith('.png')));
    const bytes = fs.readFileSync(path.join(shotDir, files[0]));
    assert.ok(bytes.length > 0);
    assert.equal(bytes[0], 0x89, 'file starts with the PNG signature byte');

    // The server received exactly one steps request, with stripped steps + key.
    const reqs = stepsRequests();
    assert.equal(reqs.length, 1);
    assert.deepEqual((reqs[0].body as { steps: string[] }).steps, [
      'Navigate to example.com',
      'Click login',
    ]);
    assert.equal(reqs[0].apiKey, 'test-key');
  });

  test('config is sent only on the first request for a session', async () => {
    __setConfig('flick.defaultBaseUrl', 'http://localhost:3000');
    __setConfig('flick.defaultTimeout', '45s');

    const fw = await boot();
    const sessionId = await createSession(fw);

    fw.send({ type: 'submitSteps', sessionId, rawText: 'First step' });
    await wait(fw, 'historyReplace');
    fw.drain();
    fw.send({ type: 'submitSteps', sessionId, rawText: 'Second step' });
    await wait(fw, 'historyReplace');

    const reqs = stepsRequests();
    assert.equal(reqs.length, 2);
    assert.deepEqual((reqs[0].body as { config: unknown }).config, {
      baseUrl: 'http://localhost:3000',
      timeout: '45s',
    });
    assert.equal((reqs[1].body as { config?: unknown }).config, undefined);
  });

  test('a failed batch surfaces as a failed result entry with the error detail', async () => {
    const fw = await boot();
    const sessionId = await createSession(fw);
    server.stepsResponse = (id, body) => ({ json: failedBatch(id, body.steps, 1) });
    fw.drain();

    fw.send({ type: 'submitSteps', sessionId, rawText: 'Step one\nStep two\nStep three' });
    const replace = await wait(fw, 'historyReplace');

    const entry = replace.entry;
    if (entry.kind !== 'result') throw new Error('unreachable');
    assert.equal(entry.batch.status, 'failed');
    assert.equal(entry.batch.results.length, 2);
    assert.equal(entry.batch.results[1].status, 'failed');
    assert.equal(entry.batch.error?.step, 1);
    assert.match(entry.batch.error?.message ?? '', /Assertion failed/);
  });

  test('an unreachable server produces an error result entry and an error toast', async () => {
    // Port 1 is reserved and refuses connections — a genuine network failure.
    __setConfig('flick.apiUrl', 'http://127.0.0.1:1');

    const fw = await boot();
    const sessionId = await createSession(fw);
    fw.drain();

    fw.send({ type: 'submitSteps', sessionId, rawText: 'Do something' });
    const replace = await wait(fw, 'historyReplace');

    const entry = replace.entry;
    if (entry.kind !== 'result') throw new Error('unreachable');
    assert.equal(entry.batch.status, 'error');
    assert.equal(entry.batch.results.length, 0);
    assert.ok(entry.batch.error, 'expected an error on the batch');

    const errorToast = fw.allOf<Msg<'toast'>>('toast').find((t) => t.level === 'error');
    assert.ok(errorToast, 'expected an error toast');
  });

  test('switching to a session the server has forgotten flags it as stale', async () => {
    const fw = await boot();
    const sessionId = await createSession(fw);

    // Use the session so the controller treats it as server-backed.
    fw.send({ type: 'submitSteps', sessionId, rawText: 'A step' });
    await wait(fw, 'historyReplace');

    // The server now reports the session as gone.
    server.sessionStateStatus = 404;
    fw.drain();
    fw.send({ type: 'switchSession', sessionId });

    const stale = await fw.waitFor<Msg<'sessions'>>(
      (m) => m.type === 'sessions' && m.sessions.some((s) => s.id === sessionId && s.stale),
    );
    assert.ok(stale.sessions.find((s) => s.id === sessionId)?.stale);
  });

  test('sessions and chat history survive a controller restart', async () => {
    // First controller: create, rename, run a step.
    const first = new FlickController(new Store(dir));
    await first.start();
    const fw1 = new FakeWebview();
    first.attachWebview(fw1 as never);
    fw1.send({ type: 'ready' });
    await fw1.waitFor((m) => m.type === 'init');

    fw1.send({ type: 'newSession' });
    const sessionId = (await wait(fw1, 'sessions')).sessions[0].id;
    fw1.send({ type: 'renameSession', sessionId, name: 'Checkout flow' });
    await fw1.waitFor<Msg<'sessions'>>(
      (m) => m.type === 'sessions' && m.sessions.some((s) => s.name === 'Checkout flow'),
    );
    fw1.send({ type: 'submitSteps', sessionId, rawText: 'A step' });
    await fw1.waitFor((m) => m.type === 'historyReplace');
    first.dispose();

    // Second controller over the same storage directory.
    controller = new FlickController(new Store(dir));
    await controller.start();
    const fw2 = new FakeWebview();
    controller.attachWebview(fw2 as never);
    fw2.send({ type: 'ready' });

    const init = await wait(fw2, 'init');
    assert.equal(init.sessions.length, 1);
    assert.equal(init.sessions[0].id, sessionId);
    assert.equal(init.sessions[0].name, 'Checkout flow');
    assert.equal(init.sessions[0].used, true);

    const history = await fw2.waitFor<Msg<'history'>>(
      (m) => m.type === 'history' && m.sessionId === sessionId,
    );
    assert.deepEqual(
      history.entries.map((e) => e.kind),
      ['user', 'result'],
    );
  });

  test('connectivity polling reports connected, then disconnected when the ping fails', async () => {
    const fw = await boot();

    const connected = await fw.waitFor<Msg<'connection'>>(
      (m) => m.type === 'connection' && m.connection === 'connected',
    );
    assert.equal(connected.connection, 'connected');

    // Break the ping endpoint; a submit triggers an immediate re-ping.
    const sessionId = await createSession(fw);
    server.pingStatus = 500;
    fw.drain();
    fw.send({ type: 'submitSteps', sessionId, rawText: 'Step' });

    // Let the submit fully settle (its trailing saveHistory) before asserting,
    // so no persistence runs after the test tears the temp directory down.
    await wait(fw, 'historyReplace');
    const disconnected = await fw.waitFor<Msg<'connection'>>(
      (m) => m.type === 'connection' && m.connection === 'disconnected',
    );
    assert.equal(disconnected.connection, 'disconnected');
    assert.ok(
      fw.allOf<Msg<'toast'>>('toast').some((t) => t.message === 'Cannot connect to server'),
      'expected a "Cannot connect to server" toast on the transition',
    );
  });

  test('deleting a confirmed session removes its tab, local data, and closes the browser server-side', async () => {
    const fw = await boot();
    const sessionId = await createSession(fw);
    fw.send({ type: 'submitSteps', sessionId, rawText: 'Step' });
    await wait(fw, 'historyReplace');
    assert.ok(fs.existsSync(path.join(dir, 'screenshots', sessionId)));

    __setWarningResponse('Delete');
    fw.drain();
    fw.send({ type: 'deleteSession', sessionId });

    const sessions = await wait(fw, 'sessions');
    assert.equal(sessions.sessions.length, 0);
    assert.equal(sessions.activeSessionId, null);

    assert.ok(!fs.existsSync(path.join(dir, 'screenshots', sessionId)));
    assert.ok(!fs.existsSync(path.join(dir, 'history', `${sessionId}.json`)));

    const closeReq = server.requests.find(
      (r) => /\/steps$/.test(r.path) && JSON.stringify(r.body).includes('Close the browser'),
    );
    assert.ok(closeReq, 'expected a "Close the browser" step sent to the server');
  });

  test('dismissing the delete confirmation leaves the session untouched', async () => {
    const fw = await boot();
    const sessionId = await createSession(fw);

    __setWarningResponse(undefined); // user cancels the modal
    fw.drain();
    fw.send({ type: 'deleteSession', sessionId });
    await delay(100);

    assert.equal(fw.last('sessions'), undefined, 'no sessions update should be posted');
    const persisted = await new Store(dir).loadSessions();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, sessionId);
  });

  // --- adopt server session ------------------------------------------------

  test('listServerSessions forwards the server list back to the webview', async () => {
    server.sessionsList = [
      {
        sessionId: 'server-1',
        status: 'active',
        currentUrl: 'https://example.com/dash',
        pageTitle: 'Dashboard',
        totalStepsExecuted: 4,
      },
      {
        sessionId: 'server-2',
        status: 'executing',
        currentUrl: 'https://other.test/',
        pageTitle: 'Other',
        totalStepsExecuted: 0,
      },
    ];
    const fw = await boot();
    fw.drain();

    fw.send({ type: 'listServerSessions' });
    const reply = await wait(fw, 'serverSessions');
    assert.equal(reply.error, null);
    assert.ok(reply.sessions);
    assert.equal(reply.sessions!.length, 2);
    assert.equal(reply.sessions![0].sessionId, 'server-1');
    assert.equal(reply.sessions![0].pageTitle, 'Dashboard');
  });

  test('listServerSessions surfaces an error when the server is unreachable', async () => {
    // Crash the server before the request fires; the listSessions client
    // method maps the network failure to ApiError with a clear message.
    const fw = await boot();
    await server.stop();
    fw.drain();

    fw.send({ type: 'listServerSessions' });
    const reply = await wait(fw, 'serverSessions');
    assert.equal(reply.sessions, null);
    assert.ok(reply.error, 'error message must be present');
    assert.match(reply.error!, /Cannot reach the API server/);
  });

  test('adoptServerSession creates a new local tab with the supplied id and marks it used', async () => {
    const fw = await boot();
    fw.drain();

    const item = {
      sessionId: 'adopted-abc',
      status: 'active',
      currentUrl: 'https://example.com/path',
      pageTitle: 'Example Page',
      totalStepsExecuted: 3,
    };
    fw.send({ type: 'adoptServerSession', item });

    const sessions = await wait(fw, 'sessions');
    assert.equal(sessions.sessions.length, 1);
    const adopted = sessions.sessions[0];
    assert.equal(adopted.id, 'adopted-abc', 'tab id matches the server session id verbatim');
    assert.equal(adopted.name, 'Example Page', 'name derives from the page title');
    assert.equal(adopted.used, true, 'adopted sessions skip the first-request config send');
    assert.equal(sessions.activeSessionId, 'adopted-abc');

    // The adopted tab survives a controller restart — the id was persisted.
    const persisted = await new Store(dir).loadSessions();
    assert.equal(persisted[0].id, 'adopted-abc');
    assert.equal(persisted[0].used, true);

    // SPEC-FLICK rule: `used: true` means the FIRST request after adoption
    // must NOT include config — the server already initialized this session.
    __setConfig('flick.defaultBaseUrl', 'http://localhost:3000');
    __setConfig('flick.defaultTimeout', '60s');
    controller!.onSettingsChanged();
    fw.drain();
    fw.send({
      type: 'submitSteps',
      sessionId: 'adopted-abc',
      rawText: '1. Click button',
    });
    await wait(fw, 'historyReplace');
    const reqs = stepsRequests();
    assert.equal(reqs.length, 1);
    assert.equal(
      (reqs[0].body as { config?: unknown }).config,
      undefined,
      'adopted session must not send config on its first request',
    );
  });

  test('adoptServerSession dedupes — re-adopting an already-open id just activates the existing tab', async () => {
    const fw = await boot();
    // Create one local session first; we'll keep it active, then adopt a
    // server item with a different id to flip activeSessionId.
    const firstId = await createSession(fw);
    fw.drain();

    const item = {
      sessionId: 'server-only',
      status: 'active',
      currentUrl: '',
      pageTitle: 'Adopted Tab',
      totalStepsExecuted: 0,
    };
    fw.send({ type: 'adoptServerSession', item });
    const afterAdopt = await wait(fw, 'sessions');
    assert.equal(afterAdopt.sessions.length, 2);
    assert.equal(afterAdopt.activeSessionId, 'server-only');

    // Now switch BACK to the first tab, then re-adopt the same server
    // session. The dedupe path must just re-activate it, not create a
    // duplicate.
    fw.send({ type: 'switchSession', sessionId: firstId });
    await wait(fw, 'sessions');
    fw.drain();

    fw.send({ type: 'adoptServerSession', item });
    const afterReadopt = await wait(fw, 'sessions');
    assert.equal(
      afterReadopt.sessions.length,
      2,
      'must NOT duplicate the tab — the local map is keyed by id',
    );
    assert.equal(
      afterReadopt.activeSessionId,
      'server-only',
      'must reactivate the existing tab',
    );
  });

  test('adoptServerSession falls back to the URL host when there is no page title', async () => {
    const fw = await boot();
    fw.drain();

    const item = {
      sessionId: 'no-title',
      status: 'active',
      currentUrl: 'https://www.example.org/page?x=1',
      pageTitle: '',
      totalStepsExecuted: 0,
    };
    fw.send({ type: 'adoptServerSession', item });
    const sessions = await wait(fw, 'sessions');
    assert.equal(sessions.sessions[0].name, 'www.example.org');
  });
});
