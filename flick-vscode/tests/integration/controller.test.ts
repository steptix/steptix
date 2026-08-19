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
import { FakeApiServer, failedBatch, passedBatch } from '../fakes/fake-api-server';
import { FakeBrowserServer } from '../fakes/fake-browser-server';
import { FakeWebview, delay } from '../fakes/fake-webview';
import {
  __reset,
  __setConfig,
  __setWarningResponse,
  __setWorkspaceFolder,
} from '../fakes/vscode';

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
    // Order matters. `dispose()` stops new work being started; `drain()` waits
    // for work already in flight. Without the drain, a handler still inside
    // saveHistory()'s writeFile/rename pair lands after `rmSync` has taken the
    // directory away — and that rejection surfaces against the NEXT test, not
    // this one. Drain before `server.stop()` so in-flight API calls can finish.
    controller?.dispose();
    await controller?.drain();
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

  test('outputSources from the server are passed through onto the batch', async () => {
    const fw = await boot();
    const sessionId = await createSession(fw);
    server.stepsResponse = (id, body) => ({
      json: passedBatch(
        id,
        body.steps,
        { user: 'alice', pageTitle: 'Home', token: 'abc' },
        { user: 'parameter', pageTitle: 'capture', token: 'toolOutput' },
      ),
    });
    fw.drain();

    fw.send({ type: 'submitSteps', sessionId, rawText: 'Do a thing' });
    const replace = await wait(fw, 'historyReplace');

    const entry = replace.entry;
    if (entry.kind !== 'result') throw new Error('unreachable');
    assert.deepEqual(entry.batch.outputs, { user: 'alice', pageTitle: 'Home', token: 'abc' });
    assert.deepEqual(entry.batch.outputSources, {
      user: 'parameter',
      pageTitle: 'capture',
      token: 'toolOutput',
    });
  });

  test('a server that omits outputSources leaves the field undefined (back-compat)', async () => {
    const fw = await boot();
    const sessionId = await createSession(fw);
    // passedBatch with no `outputSources` arg omits the field from the payload,
    // mirroring an older server.
    server.stepsResponse = (id, body) => ({
      json: passedBatch(id, body.steps, { pageTitle: 'Home' }),
    });
    fw.drain();

    fw.send({ type: 'submitSteps', sessionId, rawText: 'Do a thing' });
    const replace = await wait(fw, 'historyReplace');

    const entry = replace.entry;
    if (entry.kind !== 'result') throw new Error('unreachable');
    assert.deepEqual(entry.batch.outputs, { pageTitle: 'Home' });
    assert.equal(entry.batch.outputSources, undefined);
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

  // --- CDP attach (W6) -----------------------------------------------------

  describe('CDP attach', () => {
    let chromeBrowser: FakeBrowserServer;
    let edgeBrowser: FakeBrowserServer;

    beforeEach(async () => {
      chromeBrowser = new FakeBrowserServer();
      chromeBrowser.browserField = 'Chrome/120.0.6099.130';
      chromeBrowser.tabs = [
        { id: 'tab-a', type: 'page', url: 'https://example.com/foo', title: 'Hello' },
        { id: 'tab-b', type: 'page', url: 'https://localhost:3000/', title: 'Dashboard' },
      ];
      await chromeBrowser.start();

      edgeBrowser = new FakeBrowserServer();
      edgeBrowser.browserField = 'Edg/151.0.4129.78'; // what a real Edge sends
      edgeBrowser.tabs = [
        { id: 'edge-1', type: 'page', url: 'https://outlook.office.com/', title: 'Inbox' },
      ];
      await edgeBrowser.start();
    });

    afterEach(async () => {
      await chromeBrowser.stop();
      await edgeBrowser.stop();
    });

    /** Boot a controller, override its CDP port list to point at the two
     *  fake browsers, and complete the webview handshake. */
    async function bootCdp(opts?: {
      detectInstalled?: () => { chrome: string | null; edge: string | null };
      launchBrowserWithCdp?: (
        o: { engine: 'chrome' | 'edge'; port: number; profileDir: string },
      ) => Promise<{ ok: boolean; pid?: number; error?: string }>;
      ports?: number[];
    }): Promise<FakeWebview> {
      controller = new FlickController(new Store(dir), {
        ports: opts?.ports ?? [chromeBrowser.port, edgeBrowser.port],
        detectInstalled:
          opts?.detectInstalled ?? (() => ({ chrome: '/fake/chrome', edge: '/fake/edge' })),
        launchBrowserWithCdp: opts?.launchBrowserWithCdp,
      });
      await controller.start();
      const fw = new FakeWebview();
      controller.attachWebview(fw as never);
      fw.send({ type: 'ready' });
      await fw.waitFor((m) => m.type === 'init');
      return fw;
    }

    test('discoverCdp lists fake browser tabs with the right engine', async () => {
      const fw = await bootCdp();
      fw.drain();

      fw.send({ type: 'discoverCdp' });
      const reply = await wait(fw, 'cdpDiscovery');

      assert.equal(reply.ports.length, 2);
      const chromePort = reply.ports.find((p) => p.port === chromeBrowser.port);
      const edgePort = reply.ports.find((p) => p.port === edgeBrowser.port);
      assert.ok(chromePort, 'chrome port present');
      assert.ok(edgePort, 'edge port present');
      assert.equal(chromePort!.engine, 'chrome');
      assert.equal(chromePort!.reachable, true);
      assert.equal(chromePort!.tabs?.length, 2);
      assert.equal(edgePort!.engine, 'edge');
      assert.equal(edgePort!.reachable, true);
      assert.equal(edgePort!.tabs?.length, 1);
      assert.equal(edgePort!.tabs?.[0].targetId, 'edge-1');
    });

    test('cdpDiscovery includes installed booleans + lastLaunched from the store', async () => {
      // Pre-seed the store so the post-construction load picks it up.
      const seed = new Store(dir);
      await seed.init();
      await seed.saveCdpLastLaunched('chrome');

      const fw = await bootCdp({
        detectInstalled: () => ({ chrome: '/fake/chrome', edge: null }),
      });
      fw.drain();

      fw.send({ type: 'discoverCdp' });
      const reply = await wait(fw, 'cdpDiscovery');

      assert.deepEqual(reply.installed, {
        chrome: true,
        edge: false,
        lastLaunched: 'chrome',
      });
    });

    test('discoverCdp against an unreachable port reports the per-port error', async () => {
      // Stop the chrome server BEFORE boot — its port will refuse connections.
      await chromeBrowser.stop();
      const fw = await bootCdp();
      fw.drain();

      fw.send({ type: 'discoverCdp' });
      const reply = await wait(fw, 'cdpDiscovery');

      const dead = reply.ports.find((p) => p.port === chromeBrowser.port);
      assert.ok(dead);
      assert.equal(dead!.reachable, false);
      assert.equal(dead!.engine, 'unknown');
      assert.equal(dead!.tabs, null);
      assert.ok(dead!.error, 'expected an error string');
    });

    test('adoptCdpTab creates a SessionMeta with cdp set and used:false', async () => {
      const fw = await bootCdp();
      fw.drain();

      fw.send({
        type: 'adoptCdpTab',
        port: chromeBrowser.port,
        targetId: 'tab-a',
        title: 'Hello',
        url: 'https://example.com/foo',
      });
      const sessions = await wait(fw, 'sessions');
      assert.equal(sessions.sessions.length, 1);
      const s = sessions.sessions[0];
      assert.equal(s.name, 'Hello');
      assert.equal(s.used, false);
      assert.deepEqual(s.cdp, { port: chromeBrowser.port, tab: 'targetId:tab-a' });
    });

    test('adoptCdpTab dedupes — re-adopting the same port+targetId just activates', async () => {
      const fw = await bootCdp();
      // First adopt, then create a second local session and switch away.
      fw.send({
        type: 'adoptCdpTab',
        port: chromeBrowser.port,
        targetId: 'tab-a',
        title: 'Hello',
      });
      await wait(fw, 'sessions');
      fw.send({ type: 'newSession' });
      const after = await fw.waitFor<Msg<'sessions'>>(
        (m) => m.type === 'sessions' && m.sessions.length === 2,
      );
      const otherId = after.sessions.find((s) => !s.cdp)!.id;
      fw.send({ type: 'switchSession', sessionId: otherId });
      await wait(fw, 'sessions');
      fw.drain();

      // Re-adopt the same tab — should just re-activate, not duplicate.
      fw.send({
        type: 'adoptCdpTab',
        port: chromeBrowser.port,
        targetId: 'tab-a',
        title: 'Hello',
      });
      const second = await wait(fw, 'sessions');
      assert.equal(second.sessions.length, 2, 'no duplicate');
      const cdpSession = second.sessions.find((s) => s.cdp);
      assert.equal(second.activeSessionId, cdpSession!.id);
      // The dedupe path re-sends history for the re-activated session; assert
      // that it does. (Teardown safety is afterEach's drain(), not this await
      // — waiting on the broadcast never covered the write behind it.)
      await wait(fw, 'history');
    });

    test('first submitSteps on a CDP session includes cdp in config; subsequent do not', async () => {
      const fw = await bootCdp();
      fw.drain();

      fw.send({
        type: 'adoptCdpTab',
        port: chromeBrowser.port,
        targetId: 'tab-a',
        title: 'Hello',
      });
      const sessions = await wait(fw, 'sessions');
      const sessionId = sessions.sessions[0].id;

      fw.send({ type: 'submitSteps', sessionId, rawText: 'First step' });
      await wait(fw, 'historyReplace');
      fw.drain();
      fw.send({ type: 'submitSteps', sessionId, rawText: 'Second step' });
      await wait(fw, 'historyReplace');

      const reqs = server.requests.filter((r) => /\/steps$/.test(r.path));
      assert.equal(reqs.length, 2);
      const firstConfig = (reqs[0].body as { config?: { cdp?: unknown } }).config;
      assert.ok(firstConfig, 'first request must carry a config');
      assert.deepEqual(firstConfig!.cdp, {
        port: chromeBrowser.port,
        tab: 'targetId:tab-a',
      });
      assert.equal(
        (reqs[1].body as { config?: unknown }).config,
        undefined,
        'second request must omit config — CDP hint is first-only',
      );
    });

    test('newTabInCdp creates a session with tab="new"', async () => {
      const fw = await bootCdp();
      fw.drain();

      fw.send({ type: 'newTabInCdp', port: edgeBrowser.port });
      const sessions = await wait(fw, 'sessions');
      assert.equal(sessions.sessions.length, 1);
      assert.deepEqual(sessions.sessions[0].cdp, {
        port: edgeBrowser.port,
        tab: 'new',
      });
      assert.equal(sessions.sessions[0].used, false);
    });

    test('launchBrowserCdp invokes the injected launcher, persists lastLaunched, re-broadcasts discovery', async () => {
      __setWorkspaceFolder('C:/fake/workspace');
      const launches: Array<{ engine: string; port: number; profileDir: string }> = [];
      const fw = await bootCdp({
        launchBrowserWithCdp: async (opts) => {
          launches.push({
            engine: opts.engine,
            port: opts.port,
            profileDir: opts.profileDir,
          });
          return { ok: true, pid: 1234 };
        },
      });
      fw.drain();

      fw.send({ type: 'launchBrowserCdp', engine: 'edge', port: 9222 });
      const result = await wait(fw, 'cdpLaunchResult');
      assert.equal(result.ok, true);
      assert.equal(result.engine, 'edge');
      assert.equal(result.port, 9222);

      assert.equal(launches.length, 1);
      assert.equal(launches[0].engine, 'edge');
      assert.equal(launches[0].port, 9222);
      assert.match(
        launches[0].profileDir.replace(/\\/g, '/'),
        /\.flick\/edge-profile$/,
      );

      // lastLaunched persisted.
      const persisted = await new Store(dir).loadCdpLastLaunched();
      assert.equal(persisted, 'edge');

      // A cdpDiscovery message is also broadcast after the success path. The
      // controller posts it only after awaiting the rediscover, so it lands
      // strictly AFTER cdpLaunchResult — sampling allOf() here races that
      // broadcast. Await it instead; waitFor throws if it never arrives.
      await wait(fw, 'cdpDiscovery');
    });

    test('launchBrowserCdp failure surfaces via cdpLaunchResult and skips persistence + rediscover', async () => {
      const fw = await bootCdp({
        launchBrowserWithCdp: async () => ({ ok: false, error: 'Edge not found' }),
      });
      fw.drain();

      fw.send({ type: 'launchBrowserCdp', engine: 'edge', port: 9222 });
      const result = await wait(fw, 'cdpLaunchResult');
      assert.equal(result.ok, false);
      assert.equal(result.engine, 'edge');
      assert.equal(result.error, 'Edge not found');

      // No lastLaunched write.
      const persisted = await new Store(dir).loadCdpLastLaunched();
      assert.equal(persisted, null);

      // Brief settle; no cdpDiscovery should have been broadcast.
      await delay(50);
      const discoveries = fw.allOf<Msg<'cdpDiscovery'>>('cdpDiscovery');
      assert.equal(discoveries.length, 0, 'no rediscover on failure');
    });

    test('SessionMeta.cdp survives a controller restart', async () => {
      const fw = await bootCdp();
      fw.send({
        type: 'adoptCdpTab',
        port: chromeBrowser.port,
        targetId: 'tab-a',
        title: 'Persisted',
      });
      await wait(fw, 'sessions');
      controller!.dispose();
      controller = undefined;

      const persisted = await new Store(dir).loadSessions();
      assert.equal(persisted.length, 1);
      assert.deepEqual(persisted[0].cdp, {
        port: chromeBrowser.port,
        tab: 'targetId:tab-a',
      });

      // And the second controller boots them straight back into memory.
      controller = new FlickController(new Store(dir), {
        ports: [chromeBrowser.port, edgeBrowser.port],
        detectInstalled: () => ({ chrome: null, edge: null }),
      });
      await controller.start();
      const fw2 = new FakeWebview();
      controller.attachWebview(fw2 as never);
      fw2.send({ type: 'ready' });
      const init = await wait(fw2, 'init');
      assert.equal(init.sessions.length, 1);
      assert.deepEqual(init.sessions[0].cdp, {
        port: chromeBrowser.port,
        tab: 'targetId:tab-a',
      });
    });
  });
});
