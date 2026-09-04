import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { url as inspectorUrl } from 'node:inspector';
import path from 'node:path';
import type { AiMode, CaptureMode, Config, RunSettings } from '../config/types.js';
import { AI_MODES, CAPTURE_MODES, RUN_SETTING_KEYS } from '../config/run-settings.js';
import {
  knownProfilesAcross,
  startCdpBrowser,
  closeCdpTab,
  focusCdpTab,
  UNKNOWN_HOLDER,
  DEFAULT_PROFILE,
  type CdpFailureKind,
  type ScopedRoot,
  type StartResult,
} from '../browser/cdp-registry.js';
import { discoverCdpPorts, listPageTabs } from '../browser/cdp-discovery.js';
import { CdpTabNotFoundError, closeBrowser, launchBrowser } from '../browser/manager.js';
import { userRootDir } from '../env/user-root.js';
import { loadConfig } from '../config/loader.js';
import fs from 'node:fs';
import {
  SessionManager,
  type RunEvent,
  type RunEventListener,
  type StepRequest,
} from './session-manager.js';
import { ErrandRunner, type ErrandRequest } from './errand-runner.js';
import {
  CodeBehindCompiler,
  CompileRefused,
  type CompileEventListener,
  type CompileRequest,
  type CompileWireEvent,
} from './compile-runner.js';
import { compileLock } from './compile-lock.js';
import { recordingDirFor } from '../codebehind/recording.js';
import { ErrandLocks } from './errand-locks.js';
import { ProjectBundleResolver } from './project-bundle.js';
import { capturePageContent, readPageIdentity, type PageContentOptions } from './page-capture.js';
import { captureTabScreenshot } from '../browser/screenshot.js';
import { PageCaptureError } from '../browser/dom-cleaner.js';
import { createLoginBroker, type FieldHint, type LoginBroker } from '../credentials/index.js';
import { IdleMonitor, startIdleReaper } from './idle-monitor.js';
import { HEALTH_SERVICE_ID, type HealthResponse } from './health.js';
import { matchText } from '../parser/section-match.js';
import { logger } from '../utils/logger.js';
import { getPackageVersion } from '../utils/version.js';

/**
 * Default cap on characters returned by `GET /sessions/:id/content`.
 *
 * Much lower than the runner's own `domSnapshotCharLimit` (100 000), and
 * deliberately so: that limit is sized for a snapshot going into a runner
 * prompt, whereas this content lands in an agent host's context, where 100 000
 * characters is roughly 25 000 tokens spent on one call. A caller that needs
 * more can ask; a caller that blows its context window cannot un-spend it.
 */
const DEFAULT_CONTENT_MAX_CHARS = 20_000;

/**
 * How long a `navigate_tab` waits for `domcontentloaded`
 * (stories/navigate-tab.md §Locked).
 *
 * 30s and `domcontentloaded` are not chosen here — they are what every other
 * navigation in this codebase already uses (`browser/actions.ts`,
 * `runner/step-executor.ts`, `runner/test-runner.ts`, `session-manager.ts`,
 * `api/csrf-handler.ts`). A different number would mean this verb and a
 * `go to X` step disagreed about when a page has arrived.
 */
const NAVIGATE_TIMEOUT_MS = 30_000;

/**
 * Playwright's timeouts arrive as a `TimeoutError` whose `name` says so; the
 * class is not exported from the top-level module, so the name is the handle.
 * Load-bearing rather than defensive: a timeout is reported as a warning on a
 * navigation that SUCCEEDED, and every other failure has to keep propagating.
 */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/**
 * The `format` / `selector` / `max_chars` triple both content routes take.
 *
 * Shared rather than copied when the peek route arrived (stories/tab-peek.md):
 * every rule below is a trap that fails SILENTLY if it is dropped, so a second
 * copy is how one route quietly starts widening a read the other narrows.
 * Answers the request and returns null when anything is wrong, so a caller
 * reads it as `if (!opts) return;`.
 */
function readContentQuery(req: Request, res: Response): PageContentOptions | null {
  const rawFormat = req.query['format'];
  const format = rawFormat === undefined ? 'text' : String(rawFormat);
  if (format !== 'text' && format !== 'dom') {
    // Deliberately not a fallback to 'text'. A caller that asked for
    // 'html' and silently received prose has no way to notice.
    res.status(400).json({
      error: `Unknown format "${format}". Valid formats are "text" (visible text, default) and "dom" (cleaned DOM).`,
    });
    return null;
  }

  // Rejected rather than ignored. A repeated `?selector=a&selector=b`
  // arrives as an array, and silently dropping it would widen the read
  // from one element to the entire page — the opposite of what the caller
  // asked for, on the endpoint whose whole size story is "narrow with a
  // selector". `format` and `max_chars` already 400 on the same input.
  const rawSelector = req.query['selector'];
  if (rawSelector !== undefined && typeof rawSelector !== 'string') {
    res.status(400).json({ error: 'selector must be a single string value.' });
    return null;
  }
  // An empty `?selector=` is the same trap in a smaller shape: dropping it
  // silently reads the whole page when the caller asked for one element.
  if (rawSelector === '') {
    res.status(400).json({ error: 'selector must not be empty.' });
    return null;
  }
  const selector = typeof rawSelector === 'string' ? rawSelector : undefined;

  const rawMax = req.query['max_chars'];
  let maxChars = DEFAULT_CONTENT_MAX_CHARS;
  if (rawMax !== undefined) {
    maxChars = Number(String(rawMax));
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      res.status(400).json({
        error: `max_chars must be a positive integer (got "${String(rawMax)}").`,
      });
      return null;
    }
  }

  return { format, selector, maxChars };
}

/**
 * The query a `format: "screenshot"` peek takes, and the two it refuses
 * (stories/cdp-tab-screenshot.md §Locked).
 *
 * Split from `readContentQuery` rather than folded into it, because its other
 * caller — the session content route — has no screenshot to give: widening the
 * shared parser would make `GET /sessions/:id/content?format=screenshot` parse
 * cleanly and then fail somewhere deeper, where the message is worse.
 *
 * Answers on `res` and returns null when the query is bad, exactly as
 * `readContentQuery` does.
 */
function readScreenshotQuery(req: Request, res: Response): { fullPage: boolean } | null {
  // Refused, never ignored — and `selector` is the one that matters. Dropping
  // it would answer a request for ONE ELEMENT with a picture of the whole page:
  // a wrong answer wearing a right one's clothes, which the caller has no way
  // to notice. It is the same trap `readContentQuery` already 400s on for a
  // repeated or empty `?selector=`, in its most convincing shape.
  if (req.query['selector'] !== undefined) {
    res.status(400).json({
      error:
        'selector does not apply to format "screenshot" — a picture is of the ' +
        'whole viewport or the whole page, never of one element. Drop it, or ' +
        'read that element with format "text" or "dom".',
    });
    return null;
  }
  // Less dangerous and refused on the same principle: an image is bounded by
  // the result size cap, not by characters, so honouring this would be
  // impossible and ignoring it would be silent.
  if (req.query['max_chars'] !== undefined) {
    res.status(400).json({
      error:
        'max_chars does not apply to format "screenshot" — an image is bounded ' +
        'by the size cap for a returned picture, not by characters. Drop it, ' +
        'or capture less with full_page: false.',
    });
    return null;
  }

  const raw = req.query['full_page'];
  if (raw === undefined) return { fullPage: false };
  // Strings only, and only these two. A truthiness test would read
  // `full_page=false` as true — the single most likely way to send it.
  if (raw === 'true') return { fullPage: true };
  if (raw === 'false') return { fullPage: false };
  res.status(400).json({
    error: `full_page must be "true" or "false" (got "${String(raw)}").`,
  });
  return null;
}

/** What one peek was asked for: the text/DOM read, or the picture. */
type PeekPlan =
  | { kind: 'content'; opts: PageContentOptions }
  | { kind: 'screenshot'; fullPage: boolean };

/**
 * The gone-tab refusal the peek route answers with, from either of the two
 * places that can discover it (stories/tab-peek.md).
 *
 * One text, built once, because the MCP side reads a JSON-envelope 404 as "the
 * tab is gone" and a BARE 404 as "the server predates this route", and the two
 * remedies are opposites (stories/cdp-tab-focus.md §6). The pre-check and the
 * attach are a moment apart; a second wording for the later one would be a
 * second story for the same event.
 */
function goneTabMessage(port: number, targetId: string): string {
  return (
    `No tab with target id ${targetId} is open in the browser on port ${port}.\n\n` +
    'Either it has already been closed, or the id belongs to a different browser.\n' +
    'Call list_cdp_browsers for the tabs open right now.'
  );
}

/**
 * The `PageCaptureError` → status mapping both content routes answer with.
 *
 * Returns true once it has answered, so a route reads it as
 * `if (respondToPageCaptureError(err, res)) return;` and passes anything else
 * to `next`.
 */
function respondToPageCaptureError(err: unknown, res: Response): boolean {
  // A read that lost to a navigation is the caller's to retry — it says
  // nothing about the session's health, so it must not read as a 500.
  if (err instanceof PageCaptureError && err.kind === 'navigated') {
    res.status(409).json({ error: err.message });
    return true;
  }
  // Everything the CALLER got wrong is a 400. A bad selector answered 500
  // tells an agent the server is broken and to try again later, when the
  // fix is in its own next argument — and `div:has-text(…)` (a Playwright
  // idiom, not CSS) is a mistake agents make constantly.
  if (
    err instanceof PageCaptureError &&
    (err.kind === 'selector-miss' ||
      err.kind === 'bad-selector' ||
      err.kind === 'not-rendered' ||
      err.kind === 'unreadable-element')
  ) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

/** Write a single SSE frame. */
function writeSseEvent(res: Response, event: RunEvent | CompileWireEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** An open SSE stream: where a run's events go, and how it learns the client
 *  left. */
interface SseStream {
  /** Write one frame, unless the client has already gone. */
  emit: RunEventListener & CompileEventListener;
  /** Aborted on client disconnect, so a run can stop instead of burning
   *  through every remaining step. */
  signal: AbortSignal;
  /** True once the client's socket closed. */
  readonly clientGone: boolean;
  /** Stop the keepalive and end the response. */
  close(): void;
}

/**
 * Open an SSE stream on `res`.
 *
 * Shared by the two streaming run routes rather than written twice: every line
 * here is load-bearing in a way that is not obvious from reading it, and two
 * copies is how one of them quietly loses a fix.
 */
function openSseStream(res: Response): SseStream {
  // Headers must be set before any res.write().
  //
  // Note: don't set Connection: keep-alive explicitly — Node's HTTP keep-alive
  // socket pool can hold the connection open after res.end() and keep
  // server.close() blocked. The default is keep-alive anyway, and SSE consumers
  // don't require it.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if any
  res.flushHeaders();

  // `res.on('close')`, not `req.on('close')` — the latter fires when
  // express.json() finishes parsing the body, which would falsely signal a
  // disconnect immediately.
  //
  // Seeded from `res.closed` BEFORE the listener, because a listener cannot
  // hear an event that already fired. The errand route reaches this only after
  // `errandRunner.begin` has awaited its session join, which talks to a browser
  // and can take seconds: a client that gave up inside that window has already
  // had its 'close' emitted, so a bare listener leaves `clientGone` false
  // forever — the run's abort signal never fires and the errand drives the
  // whole thing unwatched, holding the tab lock and the in-flight run counter
  // to the end.
  const abortController = new AbortController();
  let clientGone = res.closed === true;
  if (clientGone) abortController.abort();
  res.on('close', () => {
    clientGone = true;
    abortController.abort();
  });

  // Periodic comment frame so intermediaries don't time the connection out
  // (typical proxy idle window is 30s).
  const keepalive = setInterval(() => {
    if (clientGone) return;
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // socket may be gone
    }
  }, 25_000);

  return {
    emit: (event: RunEvent | CompileWireEvent) => {
      if (clientGone) return;
      writeSseEvent(res, event);
    },
    signal: abortController.signal,
    get clientGone() {
      return clientGone;
    },
    close: () => {
      clearInterval(keepalive);
      if (!clientGone) res.end();
    },
  };
}

/**
 * Teardown callbacks the app needs but cannot own: the HTTP `server` handle
 * and `process.exit` live in `startServer`. The `/admin/shutdown` route does
 * all the validation (including the 409) and then delegates, so tests can
 * drive the real route with a spy instead of stubbing `process.exit`.
 */
export interface ServerHooks {
  requestShutdown(force: boolean): void;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApiServer(
  config: Config,
  hooks?: ServerHooks,
  /** Injectable so tests can drive expiry with a fake clock. */
  idleMonitor: IdleMonitor = new IdleMonitor(config.server.idleTimeoutMinutes),
): {
  app: express.Express;
  sessionManager: SessionManager;
  idleMonitor: IdleMonitor;
  /**
   * The one turn-lock registry this app runs on (stories/errands.md §The
   * wheel).
   *
   * Returned so a test can put a hold on it and watch BOTH readers answer —
   * the errand route's `begin` and the close guard's `errandHolding`. Two
   * registries would pass every unit test either half has and refuse nothing
   * in the app.
   */
  errandLocks: ErrandLocks;
  /** Close the app to new work (§2). Idempotent. */
  beginShutdown: () => void;
} {
  const app = express();
  // One resolver behind both, so an errand and a session running against the
  // same project read the same `.env` at the same moment.
  const projectBundles = new ProjectBundleResolver(config);
  const sessionManager = new SessionManager(config, projectBundles);

  /**
   * The credential broker, built on first use and then kept (SPEC 29 §10).
   *
   * Lazy because constructing it is not free — it decides which approval
   * surface this platform has — and a server that never brokers a login should
   * not pay for one. Kept because the broker's approval grants ARE its memory
   * of what the user already agreed to; a per-request instance would re-prompt
   * on every page of a multi-page sign-in.
   */
  let brokerInstance: LoginBroker | null = null;
  const loginBroker = (): LoginBroker => (brokerInstance ??= createLoginBroker());
  // Beside the manager, never inside it: an errand adds nothing to the sessions
  // map, which is what makes "nothing survives on the server" checkable.
  //
  // The lock lives out here rather than inside the runner because it has a
  // second reader: `close_cdp_tab`'s hold guard, which must refuse a tab an
  // errand is driving (stories/errands.md §The wheel, amending cdp-tabs §2).
  const errandLocks = new ErrandLocks();
  const errandRunner = new ErrandRunner(config, sessionManager, projectBundles, errandLocks);
  // Same shape as the errand runner beside it: no state in the sessions map, the
  // shared project resolver, and the manager's run counter borrowed for the
  // duration (stories/codebehind-compile.md §Server).
  const compiler = new CodeBehindCompiler(config, sessionManager, projectBundles);
  const version = getPackageVersion();
  const startedAt = new Date().toISOString();
  let shuttingDown = false;

  // JSON body parsing
  app.use(express.json());

  // GET /health — UNAUTHENTICATED by design, and registered before the auth
  // middleware so it stays that way. This is a localhost dev server and the
  // body carries no api key, no config and no session contents — the point is
  // that a client can ask "is our server there?" without holding a key, which
  // is what makes the extension's spawn decision and the status bar possible.
  //
  // It is also registered before the wildcard-CORS middleware, and that is
  // load-bearing rather than incidental. Every other route is auth-gated, so
  // `Access-Control-Allow-Origin: *` on them is harmless — a foreign origin
  // never gets a readable body. `/health` is the one route that is both
  // unauthenticated and readable, and it publishes `inspector` — the Node
  // inspector ws URL whose unguessable UUID is the only thing standing
  // between a web page and `Runtime.evaluate` on the developer's machine
  // (browsers can open ws:// to localhost regardless of origin). Handing that
  // UUID to any http page the developer happens to visit is not a trade this
  // endpoint should make; the only consumers are Node clients (the CLI and
  // the extension host), which do not need CORS.
  //
  // It deliberately does NOT bump `idleMonitor`: the status bar polls this
  // every 30 s, so bumping here would keep the server alive forever and make
  // the idle timeout dead code (story server-lifecycle §3).
  //
  // Synchronous, and touches no session state beyond counts.
  app.get('/health', (_req: Request, res: Response) => {
    const body: HealthResponse = {
      ok: true,
      service: HEALTH_SERVICE_ID,
      version,
      pid: process.pid,
      startedAt,
      openSessions: sessionManager.countOpenSessions(),
      runsInFlight: sessionManager.runsInFlight(),
      // Ground truth from inside the process. null ⇒ step-into cannot work
      // (started without --inspect, or the requested port was taken — node
      // only warns in that case, which is the wrong-process-attach bug this
      // field exists to kill).
      inspector: inspectorUrl() ?? null,
      idleTimeoutMinutes: idleMonitor.timeoutMinutes,
    };
    res.status(200).json(body);
  });

  // CORS — allow any origin so Tauri / browser clients can reach the API
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // "Stop accepting new work" (§2), registered after /health so a client can
  // still watch the server go away.
  //
  // `server.close()` alone is not a work gate: it refuses new *connections*
  // but a client already holding a keep-alive socket — which TestBench does —
  // can still send a request during the seconds `closeAll()` spends shutting
  // browsers down. That request would create a session and launch a browser
  // after the map was drained, and then be killed mid-run by the exit,
  // orphaning the browser.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    if (shuttingDown) {
      res.status(503).json({ error: 'Server is shutting down' });
      return;
    }
    next();
  });

  // Auth middleware — check x-api-key header
  app.use((req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== config.server.apiKey) {
      res.status(401).json({ error: 'Unauthorized: missing or invalid x-api-key header' });
      return;
    }
    // Authenticated traffic is half of the idle definition (§3); the other
    // half is `runsInFlight`, checked by the reaper in `startServer`.
    idleMonitor.bump();
    next();
  });

  // POST /admin/shutdown — graceful stop, behind auth.
  //
  // Body: `{ force?: boolean }`. A run in flight refuses with 409 unless
  // forced. Open-but-idle sessions do NOT block a stop — they are closed as
  // part of it (story server-lifecycle §2). That asymmetry is the whole
  // point: TestBench sessions stay open for reuse indefinitely, so blocking
  // on them would mean `aiui stop` never works.
  app.post('/admin/shutdown', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const force = body.force === true;
    const runsInFlight = sessionManager.runsInFlight();

    if (runsInFlight > 0 && !force) {
      res.status(409).json({
        error:
          `Refusing to stop: ${runsInFlight} run(s) executing. ` +
          'Re-send with {"force": true} to stop anyway.',
        runsInFlight,
        openSessions: sessionManager.countOpenSessions(),
      });
      return;
    }

    res.status(200).json({ ok: true, stopping: true });
    // Teardown + exit belong to the process owner, not the app. `hooks` is
    // optional (§2) so tests can build the app without them — but an app
    // serving real traffic with nothing wired would answer "stopping" and
    // then keep running, which is the one failure mode a caller cannot
    // detect. Say so rather than going quiet.
    if (!hooks) {
      logger.warn('Shutdown requested but no teardown hook is wired — the server will keep running');
      return;
    }
    hooks.requestShutdown(force);
  });

  // POST /sessions/:id/steps
  // ?stream=1 → SSE stream of per-step events, otherwise plain JSON response.
  app.post('/sessions/:id/steps', async (req: Request, res: Response, next: NextFunction) => {
    const streaming = req.query['stream'] === '1';

    try {
      const sessionId = String(req.params.id);

      // Validate session ID length
      if (sessionId.length > 1024) {
        res.status(400).json({ error: 'Session ID must be 1024 characters or fewer' });
        return;
      }

      const body = req.body as Record<string, unknown>;

      // Validate steps array
      if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
        res.status(400).json({ error: 'Request body must include a "steps" array with at least one step' });
        return;
      }

      // Validate all steps are strings
      if (!body.steps.every((s: unknown) => typeof s === 'string')) {
        res.status(400).json({ error: 'All steps must be strings' });
        return;
      }

      const request: StepRequest = { steps: body.steps as string[] };
      if (body.config !== undefined) {
        request.config = body.config as {
          baseUrl?: string;
          timeout?: string;
          // Raw `## Config: viewport:` spec (stories/per-test-viewport.md §3).
          // Cast, not validated, exactly like its neighbours — the session
          // manager owns the one validator and refuses a bad value before it
          // launches anything. The cast is a type assertion rather than a
          // projection, so the key would travel even unlisted; naming it keeps
          // this declaration an honest description of the wire shape instead
          // of a stale one that happens to work.
          viewport?: string;
          // `profile` is a descriptive label only — `port` selects the browser.
          // Retained so `GET /sessions` can say which browser a session drives.
          cdp?: { port: number; tab?: string; profile?: string };
        };
      }
      if (body.parameters !== undefined) {
        request.parameters = body.parameters as Record<string, string>;
      }
      if (body.env !== undefined && body.env !== null && typeof body.env === 'object') {
        request.env = body.env as Record<string, string>;
      }
      // Which data row this batch is (stories/data-driven-rows.md). Validated
      // here rather than trusted: a batch carrying `dataRow` writes no report
      // and waits for a finalise, so a malformed pair would leave a run with
      // no report at all and nothing saying why.
      if (body.dataRow !== undefined) {
        const dataRow = body.dataRow;
        const dataRowCount = body.dataRowCount;
        if (!Number.isInteger(dataRow) || (dataRow as number) < 1) {
          res.status(400).json({ error: 'dataRow must be a positive integer (1-based).' });
          return;
        }
        if (!Number.isInteger(dataRowCount) || (dataRowCount as number) < 1) {
          res
            .status(400)
            .json({ error: 'dataRowCount must be a positive integer when dataRow is given.' });
          return;
        }
        if ((dataRow as number) > (dataRowCount as number)) {
          res
            .status(400)
            .json({ error: `dataRow ${String(dataRow)} exceeds dataRowCount ${String(dataRowCount)}.` });
          return;
        }
        request.dataRow = dataRow as number;
        request.dataRowCount = dataRowCount as number;
      } else if (body.dataRowCount !== undefined) {
        res.status(400).json({ error: 'dataRowCount was given without dataRow.' });
        return;
      }
      if (body.dataRowValues !== undefined) {
        const values = body.dataRowValues;
        if (
          values === null ||
          typeof values !== 'object' ||
          Array.isArray(values) ||
          !Object.values(values as Record<string, unknown>).every((v) => typeof v === 'string')
        ) {
          res.status(400).json({ error: 'dataRowValues must be an object of string values.' });
          return;
        }
        request.dataRowValues = values as Record<string, string>;
      }
      // Active environment name — drives server-side `${env.X}` / `${data.X}`
      // resolution (loads `.env.<name>` + `<dataDir>/<name>.json` from the test
      // file's project root). Without this the server never interpolates
      // env/data placeholders on the HTTP path.
      if (typeof body.envName === 'string') {
        request.envName = body.envName;
      }
      // Test-level named dataSources (name → path) from the test's frontmatter,
      // forwarded by the client. Resolved relative to testFilePath's dir and
      // loaded into `${<name>.X}` namespaces so they interpolate on the server
      // path too (not just the CLI parse path).
      if (
        body.dataSources !== undefined &&
        body.dataSources !== null &&
        typeof body.dataSources === 'object' &&
        !Array.isArray(body.dataSources)
      ) {
        const sources: Record<string, string> = {};
        for (const [name, p] of Object.entries(body.dataSources)) {
          if (typeof p === 'string') sources[name] = p;
        }
        if (Object.keys(sources).length > 0) request.dataSources = sources;
      }
      if (body.breakpoints !== undefined && Array.isArray(body.breakpoints)) {
        request.breakpoints = body.breakpoints as number[];
      }
      if (
        body.breakpointsByUri !== undefined &&
        body.breakpointsByUri !== null &&
        typeof body.breakpointsByUri === 'object' &&
        !Array.isArray(body.breakpointsByUri)
      ) {
        // Defensive copy + shape check — each value must be number[].
        const map: Record<string, number[]> = {};
        for (const [uri, lines] of Object.entries(body.breakpointsByUri)) {
          if (Array.isArray(lines) && lines.every((n) => typeof n === 'number')) {
            map[uri] = lines as number[];
          }
        }
        if (Object.keys(map).length > 0) request.breakpointsByUri = map;
      }
      if (body.sourceLines !== undefined && Array.isArray(body.sourceLines)) {
        // Element-type and arity checked for the same reason
        // `validateSectionEntry` checks `steps`/`stepLines`: this array is
        // parallel to `steps`, and a skew means a step is attributed to the
        // wrong source line — a wrong gutter, a wrong breakpoint, a wrong
        // re-run anchor. Historically only the sections map was checked,
        // while the same skew one field over went through unexamined.
        //
        // Dropped rather than 400'd, unlike `sections`: `sourceLines` is a
        // display/attribution aid with a documented fallback (step index),
        // so degrading is well-defined here, where dropping a section
        // silently changes what executes.
        const lines = body.sourceLines as unknown[];
        const usable =
          lines.length === (body.steps as string[]).length &&
          lines.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
        if (usable) {
          request.sourceLines = lines as number[];
        } else {
          logger.warn(
            `Ignoring malformed "sourceLines" (${lines.length} entries for ` +
              `${(body.steps as string[]).length} steps): step lines will fall back to step index.`,
          );
        }
      }
      // Step-into protocol fields. `skillsDir` triggers server-side skill
      // expansion + frame:push/pop emission; `testFilePath` anchors frame
      // events on the test file; `stepMode` opts the run into the
      // pause-between-steps state machine. All optional — legacy clients
      // omit them and the run executes as before.
      if (typeof body.skillsDir === 'string') {
        request.skillsDir = body.skillsDir;
      }
      if (typeof body.testFilePath === 'string') {
        request.testFilePath = body.testFilePath;
      }
      // Inline section definitions (stories/test-script-sections-contract.md
      // §3.2). This block is load-bearing: `StepRequest` is built from an
      // explicit per-field allow-list, so widening the TYPE alone compiles
      // cleanly and drops the field at runtime. That is exactly how `envName`
      // was once lost.
      //
      // Malformed entries are a 400 rather than a silent drop — the house
      // pattern for `breakpointsByUri` is shape-check-and-drop, but degrading
      // here means bare section names ship to the AI as literal instructions
      // while their bodies never run, which is the silent double-execution
      // class this feature exists to eliminate. Fail loudly instead.
      if (body.sections !== undefined && body.sections !== null) {
        if (typeof body.sections !== 'object' || Array.isArray(body.sections)) {
          res.status(400).json({ error: '"sections" must be an object keyed by section name' });
          return;
        }
        const entries = Object.entries(body.sections as Record<string, unknown>);
        // `{}` is treated as absent, not as an error: a client with no
        // sections may legitimately send an empty map, and every gate uses
        // `hasSections()` so it behaves as the legacy path.
        if (entries.length > 0) {
          if (typeof body.testFilePath !== 'string') {
            res.status(400).json({
              error: '"sections" requires "testFilePath" — section frames and cycle keys derive from it',
            });
            return;
          }
          // Null-prototype: a section may legally be named `__proto__`, and on
          // a normal object literal `sections['__proto__'] = entry` invokes
          // the prototype setter instead of creating an own key — the entry
          // would vanish, `hasSections()` would say false, and the bare name
          // would reach the AI as a literal instruction. Exactly the silent
          // degradation this block refuses to allow.
          const sections = Object.create(null) as NonNullable<StepRequest['sections']>;
          for (const [key, raw] of entries) {
            const invalid = validateSectionEntry(key, raw);
            if (invalid) {
              res.status(400).json({ error: invalid });
              return;
            }
            const entry = raw as {
              name: string;
              headingLine: number;
              steps: string[];
              stepLines: number[];
              rows?: Array<Record<string, string>>;
            };
            sections[key] = {
              name: entry.name,
              headingLine: entry.headingLine,
              steps: entry.steps,
              stepLines: entry.stepLines,
              // Named explicitly: this copy is field-by-field, so a new key
              // travels only if it is listed. The seam that once dropped
              // `envName`.
              ...(entry.rows && { rows: entry.rows }),
            };
          }
          request.sections = sections;
        }
      }
      if (typeof body.toolsDir === 'string') {
        request.toolsDir = body.toolsDir;
      }
      if (typeof body.stepMode === 'string') {
        const validModes = new Set(['continue', 'into', 'over', 'out']);
        if (validModes.has(body.stepMode)) {
          request.stepMode = body.stepMode as 'continue' | 'into' | 'over' | 'out';
        }
      }
      if (body.pauseAtNextTool === true) {
        request.pauseAtNextTool = true;
      }
      if (body.pauseAtNextCodeBehind === true) {
        request.pauseAtNextCodeBehind = true;
      }
      // Step-cache control fields. Caching is opt-in: the server enables it
      // only when `cacheEnabled: true` is sent explicitly (and a testFilePath
      // is present). An absent flag means off. We pass through whichever
      // explicit boolean the client sent. `fullSteps` lets multi-batch runs
      // share a stable bundle hash so cache hits survive paused-and-resumed
      // runs.
      if (body.cacheEnabled === false) {
        request.cacheEnabled = false;
      } else if (body.cacheEnabled === true) {
        request.cacheEnabled = true;
      }
      if (
        Array.isArray(body.fullSteps) &&
        body.fullSteps.every((s: unknown) => typeof s === 'string')
      ) {
        request.fullSteps = body.fullSteps as string[];
      }
      // Keep the DOM either side of every step on the run's results, so this
      // run is a recording `POST /codebehind/compile` can use instead of
      // running the test again (stories/codebehind-compile-as-a-run.md). This
      // line is load-bearing for the reason the `sections` one is: a field the
      // allow-list does not name is dropped, silently.
      if (body.captureStepContext === true) {
        request.captureStepContext = true;
      }
      // Compile as the run goes (stories/compile-as-you-go.md §On the wire).
      // Two values, not a boolean: the server behaves differently per mode
      // (Review and a wholesale recording on `'run'`; no Review, a spliced
      // recording and code-behind off on `'steps'`), and a bare `true` would
      // leave it guessing which the client meant. A refusal rather than a
      // fallback, for the reason `runSettings` refuses: a client that asked
      // for one mode and quietly got the other has no way to notice. And on
      // the allow-list because a field the list does not name is dropped,
      // silently — which is exactly how `envName` was lost once.
      if (body.compile !== undefined) {
        if (body.compile !== 'run' && body.compile !== 'steps') {
          res.status(400).json({ error: '"compile" must be "run" or "steps"' });
          return;
        }
        if (typeof body.testFilePath !== 'string') {
          res.status(400).json({
            error: '"compile" requires "testFilePath" — entries are written into the test\'s sibling .steps.ts',
          });
          return;
        }
        if (!streaming) {
          // The proposal only exists as a `compile:result` frame — the JSON
          // response is a `StepResponse` and has nowhere to put it. Generating
          // it anyway would spend a model call per step on something the
          // caller cannot receive.
          res.status(400).json({
            error: '"compile" requires ?stream=1 — the proposal comes back as a compile:result frame',
          });
          return;
        }
        request.compile = body.compile;
        // Blocks 2..n of a split run (an `[input:]`/`[interactive]` step, or
        // a breakpoint that left Continue to send the rest). On the
        // allow-list for the same reason `compile` is.
        if (body.compileContinues === true) request.compileContinues = true;
      }
      // Section attribution for a single-step compile of a `### Section`
      // body. Refused rather than ignored when it makes no sense: a whole-test
      // Run & Compile has the real frames, and a caller that asked for a scope
      // and quietly got the top level would find out when the entry never
      // bound.
      if (body.compileScope !== undefined) {
        const scope = body.compileScope as { section?: unknown } | null;
        if (request.compile !== 'steps') {
          res.status(400).json({
            error: '"compileScope" is only valid with "compile": "steps"',
          });
          return;
        }
        if (
          scope === null ||
          typeof scope !== 'object' ||
          Array.isArray(scope) ||
          typeof scope.section !== 'string' ||
          scope.section.trim() === ''
        ) {
          res.status(400).json({ error: '"compileScope" must be { section: <non-empty string> }' });
          return;
        }
        request.compileScope = { section: scope.section };
      }
      // Re-run-with-variables fields (testbench "re-run a skill step"):
      // `seedScope` injects captured/runtime vars before the run; `startAt`
      // starts execution partway into the expanded skill body. Both optional.
      if (
        body.seedScope !== undefined &&
        body.seedScope !== null &&
        typeof body.seedScope === 'object' &&
        !Array.isArray(body.seedScope)
      ) {
        const scope: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.seedScope)) {
          if (typeof v === 'string') scope[k] = v;
        }
        if (Object.keys(scope).length > 0) request.seedScope = scope;
      }
      if (
        body.startAt !== undefined &&
        body.startAt !== null &&
        typeof body.startAt === 'object' &&
        !Array.isArray(body.startAt)
      ) {
        const sa = body.startAt as { uri?: unknown; line?: unknown };
        if (typeof sa.uri === 'string' && typeof sa.line === 'number') {
          request.startAt = { uri: sa.uri, line: sa.line };
        }
      }
      // `endAt` bounds the partial re-run's upper end ("run selected skill
      // steps"); same shape as `startAt`. Optional; meaningful only with startAt.
      if (
        body.endAt !== undefined &&
        body.endAt !== null &&
        typeof body.endAt === 'object' &&
        !Array.isArray(body.endAt)
      ) {
        const ea = body.endAt as { uri?: unknown; line?: unknown };
        if (typeof ea.uri === 'string' && typeof ea.line === 'number') {
          request.endAt = { uri: ea.uri, line: ea.line };
        }
      }
      if (body.logging !== undefined && body.logging !== null && typeof body.logging === 'object') {
        const lg = body.logging as { consoleLogLevel?: unknown; serverFileLogLevel?: unknown };
        const validLevels = new Set(['silent', 'error', 'warn', 'info', 'debug']);
        const validFiles = new Set(['off', 'compact', 'full']);
        const out: {
          consoleLogLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
          serverFileLogLevel?: 'off' | 'compact' | 'full';
        } = {};
        if (typeof lg.consoleLogLevel === 'string' && validLevels.has(lg.consoleLogLevel)) {
          out.consoleLogLevel = lg.consoleLogLevel as 'silent' | 'error' | 'warn' | 'info' | 'debug';
        }
        if (typeof lg.serverFileLogLevel === 'string' && validFiles.has(lg.serverFileLogLevel)) {
          out.serverFileLogLevel = lg.serverFileLogLevel as 'off' | 'compact' | 'full';
        }
        if (out.consoleLogLevel || out.serverFileLogLevel) request.logging = out;
      }
      // Per-session run settings (stories/run-settings.md §1). This branch is
      // load-bearing for the same reason the `sections` one is: `StepRequest` is
      // built from an explicit per-field allow-list, so widening the TYPE alone
      // compiles cleanly and drops the field at runtime — which is exactly how
      // `envName` was lost once.
      //
      // Every refusal here is a 400 naming what is valid. NOT a fallback: an
      // agent that asked for `capture: "all"` and quietly got the server default
      // has no way to notice, and the whole point of the feature is that the
      // caller controls what happens.
      if (body.runSettings !== undefined && body.runSettings !== null) {
        const parsed = parseRunSettings(body.runSettings);
        if (typeof parsed === 'string') {
          res.status(400).json({ error: parsed });
          return;
        }
        request.runSettings = parsed;
      }

      // One compile per test file at a time, shared with
      // `POST /codebehind/compile`. Decided BEFORE the stream opens, for the
      // reason that route takes its lock in the handler: once `flushHeaders`
      // has run the answer is a 200 whatever happens next. The session manager
      // takes the lock for real — two callers can both read false here.
      if (request.compile !== undefined && request.testFilePath && compileLock.isLocked(request.testFilePath)) {
        res.status(409).json({
          error:
            `A compile of ${path.basename(request.testFilePath)} is already running. ` +
            'One compile per test file at a time.',
        });
        return;
      }

      if (streaming) {
        const sse = openSseStream(res);
        try {
          await sessionManager.executeSteps(sessionId, request, sse.emit, sse.signal);
        } catch (err) {
          if (!sse.clientGone) {
            const message = err instanceof Error ? err.message : String(err);
            sse.emit({ type: 'output', msg: `Server error: ${message}`, kind: 'error' });
            sse.emit({ type: 'done', status: 'error' });
          }
        } finally {
          sse.close();
        }
        return;
      }

      const result = await sessionManager.executeSteps(sessionId, request);

      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Session manager throws for config-on-non-first-request and similar validation errors
      if (message.includes('Config can only be provided on the first request')) {
        res.status(400).json({ error: message });
        return;
      }

      next(err);
    }
  });

  // POST /codebehind/compile (stories/codebehind-compile.md §Server)
  //
  // Always SSE: a compile records, generates, reviews and replays, which is
  // minutes of work, and a client that gets one JSON body at the end has no way
  // to show any of it. The final `{ status, files, summary }` rides the stream
  // as the last frame rather than as the response body for the same reason.
  //
  // Errors before the stream opens are status codes (400 malformed, 409 a
  // compile of this file already running); everything after is a frame, because
  // the headers are long gone by then.
  app.post('/codebehind/compile', async (req: Request, res: Response) => {
    const parsed = parseCompileRequest(req.body);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }

    // The 409 has to be decided BEFORE the stream opens, so the lock is taken
    // here rather than inside `compile`: once `flushHeaders` has run the answer
    // is a 200 whatever happens next.
    if (compiler.isCompiling(parsed.testFilePath)) {
      res.status(409).json({
        error:
          `A compile of ${path.basename(parsed.testFilePath)} is already running. ` +
          'One compile per test file at a time.',
      });
      return;
    }

    const sse = openSseStream(res);
    try {
      const result = await compiler.compile(parsed, sse.emit, sse.signal);
      sse.emit({
        type: 'compile:result',
        status: result.status,
        files: result.files,
        summary: result.summary,
      });
    } catch (err) {
      if (sse.clientGone) {
        sse.close();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof CompileRefused) {
        sse.emit({ type: 'output', msg: message, kind: 'error' });
      } else {
        logger.error(`Compile failed: ${message}`);
        sse.emit({ type: 'output', msg: `Server error: ${message}`, kind: 'error' });
      }
      sse.emit({ type: 'compile:done', status: 'failed', message });
      sse.emit({
        type: 'compile:result',
        status: 'failed',
        files: {},
        summary: {
          test: parsed.testFilePath,
          totalSteps: 0,
          compiled: 0,
          kept: 0,
          keptAi: 0,
          rounds: 0,
          tokensUsed: 0,
          written: [],
          unproven: [],
          writtenOffAi: [],
          notAttempted: [],
          recordingDir: recordingDirFor(parsed.testFilePath),
          error: message,
        },
      });
    } finally {
      sse.close();
    }
  });

  // POST /errands (stories/errands.md)
  // ?stream=1 → SSE stream of the same per-step events the steps route emits,
  // otherwise the folded JSON receipt.
  //
  // Deliberately not under /sessions: an errand creates none, and the URL is
  // the first place that has to say so. The runner lives beside the session
  // manager and borrows only its in-flight run counter — so a running errand
  // pins `/health`, the shutdown 409 and the idle reaper exactly as a session's
  // run does.
  app.post('/errands', async (req: Request, res: Response, next: NextFunction) => {
    const streaming = req.query['stream'] === '1';

    try {
      const parsed = parseErrandRequest(req.body);
      if (typeof parsed === 'string') {
        res.status(400).json({ error: parsed });
        return;
      }

      // Before any SSE header flushes: a tab someone else is driving is a 409,
      // and once the stream is open the only shape left is a 200 that says the
      // errand ran (stories/errands.md §The wheel).
      const started = await errandRunner.begin(parsed);
      if (!started.ok) {
        res
          .status(409)
          .json({ error: started.refusal.error, holder: started.refusal.holder });
        return;
      }
      const { lease } = started;

      try {
        if (streaming) {
          const sse = openSseStream(res);
          try {
            await errandRunner.run(lease, parsed, sse.emit, sse.signal);
          } catch (err) {
            if (!sse.clientGone) {
              const message = err instanceof Error ? err.message : String(err);
              sse.emit({ type: 'output', msg: `Server error: ${message}`, kind: 'error' });
              sse.emit({ type: 'done', status: 'error' });
            }
          } finally {
            sse.close();
          }
          return;
        }

        const receipt = await errandRunner.run(lease, parsed);
        res.status(200).json(receipt);
      } finally {
        // `run` releases in its own `finally`; this covers the gap between
        // `begin` and it — `openSseStream` throwing there would otherwise
        // strand both the tab lock and the in-flight run counter. Idempotent.
        lease.release();
      }
    } catch (err) {
      next(err);
    }
  });

  // POST /sessions/:id/run-control — Phase 3 step-into protocol.
  //
  // Delivers a step-mode command (continue / into / over / out) to a run
  // currently paused inside the step loop's `pendingRunControl` await.
  // 200 on delivery, 409 when there's no paused run to consume it.
  // The matching SSE stream continues to emit events; the client doesn't
  // need a separate response body beyond {ok:true}.
  app.post('/sessions/:id/run-control', (req: Request, res: Response) => {
    const sessionId = String(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = body.mode;
    const validModes = new Set(['continue', 'into', 'over', 'out']);
    if (typeof mode !== 'string' || !validModes.has(mode)) {
      res.status(400).json({
        error: 'mode must be one of: continue, into, over, out',
      });
      return;
    }
    // Set the tool step-into flag BEFORE delivering the run-control,
    // so the resumed loop sees it on the same tick — but only if we
    // know the run is actually parked. Otherwise a 409 would leave
    // the flag stuck on the session, ambushing the NEXT batch's first
    // tool step with a hang.
    const delivered = sessionManager.submitRunControl(
      sessionId,
      mode as 'continue' | 'into' | 'over' | 'out',
    );
    if (!delivered) {
      res.status(409).json({ error: 'No paused run for this session' });
      return;
    }
    if (body.pauseAtNextTool === true) {
      sessionManager.setPauseAtNextTool(sessionId, true);
    }
    if (body.pauseAtNextCodeBehind === true) {
      sessionManager.setPauseAtNextCodeBehind(sessionId, true);
    }
    res.status(200).json({ ok: true });
  });

  // POST /sessions/:id/tool-debugger-ack — Phase 5 tool step-into.
  //
  // Clients call this AFTER they have successfully attached VS Code's
  // Node debugger to the server process in response to a
  // `tool:awaiting-debugger` event. The session manager resolves the
  // per-session debugger-ack Promise the step loop is awaiting; the
  // loop then proceeds to the cooperative `debugger;` statement which
  // the inspector traps.
  //
  // 409 when no run is currently parked on an ack — same shape as the
  // run-control endpoint's "no paused run" diagnostic.
  app.post('/sessions/:id/tool-debugger-ack', (req: Request, res: Response) => {
    const sessionId = String(req.params.id);
    const delivered = sessionManager.submitDebuggerAck(sessionId);
    if (!delivered) {
      res.status(409).json({ error: 'No run awaiting debugger for this session' });
      return;
    }
    res.status(200).json({ ok: true });
  });

  // GET /sessions/:id
  app.get('/sessions/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = String(req.params.id);
      const state = await sessionManager.getSession(sessionId);

      if (!state) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.status(200).json(state);
    } catch (err) {
      next(err);
    }
  });

  // GET /sessions/:id/content — the active page as text or cleaned DOM
  // (stories/page-content.md).
  //
  // Nothing here calls a model. The endpoint hands back the page and stops;
  // whoever asked does the understanding. That is what keeps a page read free
  // of AI_API_KEY, free of model latency, and free of paying for the same page
  // twice — once to summarise it, once to read the summary.
  //
  // Behind the auth middleware, so it bumps the idle monitor. Correct here:
  // this is a client action, not a poll. (The warning at the CDP block below
  // is about adding a *polled* route behind auth; this is not one.)
  app.get('/sessions/:id/content', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = String(req.params.id);

      // Validate before touching the page, so a bad request never costs a
      // browser round-trip.
      const opts = readContentQuery(req, res);
      if (!opts) return;

      const content = await sessionManager.getPageContent(sessionId, opts);
      if (!content) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.status(200).json(content);
    } catch (err) {
      if (respondToPageCaptureError(err, res)) return;
      next(err);
    }
  });

  // POST /sessions/:id/login — the credential broker (SPEC 29).
  //
  // The whole of the brokered-login feature reaches the browser through this
  // one route, and it is deliberately thin: everything that decides anything
  // lives in `src/credentials/`, where it can be tested without an HTTP server.
  //
  // Note what the route does NOT accept: a site, a domain, a username, or a
  // password. There is nowhere for a caller to say which credential it wants —
  // the page the session is already on IS the site, and the broker reads that
  // from the browser. A `site` parameter here would hand a prompt-injected
  // agent the one lever the design exists to withhold.
  app.post('/sessions/:id/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = String(req.params.id);

      // The optional field hint (§7), validated BEFORE the session lookup —
      // the same ordering, and the same reason, as `GET /sessions/:id/content`:
      // a malformed request is the caller's mistake whether or not the session
      // exists, and answering 404 to a request that also has a bad selector
      // sends the agent off to fix the wrong thing.
      //
      // Validated to strings so a malformed body cannot reach a Playwright
      // locator. The hint still cannot widen where a password goes — the broker
      // re-checks the element itself.
      const body = (req.body ?? {}) as { hint?: unknown };
      let hint: FieldHint | undefined;
      if (body.hint !== undefined) {
        if (typeof body.hint !== 'object' || body.hint === null) {
          res.status(400).json({ error: 'hint must be an object.' });
          return;
        }
        const raw = body.hint as Record<string, unknown>;
        for (const key of ['username', 'password', 'otp']) {
          const value = raw[key];
          if (value !== undefined && (typeof value !== 'string' || value === '')) {
            res.status(400).json({ error: `hint.${key} must be a non-empty CSS selector.` });
            return;
          }
        }
        hint = {
          username: typeof raw['username'] === 'string' ? raw['username'] : undefined,
          password: typeof raw['password'] === 'string' ? raw['password'] : undefined,
          otp: typeof raw['otp'] === 'string' ? raw['otp'] : undefined,
        };
      }

      const page = sessionManager.activePageFor(sessionId);
      if (!page) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const result = await loginBroker().attemptLogin(page, hint);
      // Always 200. Every outcome here — denied, no credential, stuck — is a
      // thing that legitimately happened, not a failed request, and the
      // `outcome` field is what the caller reads. The same reasoning the MCP
      // layer applies to `isError`.
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /sessions/:id/last-run — report path + frozen token totals for the last
  // finalized run (issue 021). The delivery channel for a client that STOPPED a
  // run: stopping closes the SSE stream before the final `done`, so the
  // reportPath/tokens are dropped in transit; the client polls this until
  // `finalized` then reads both. Cheap (no screenshot/title), survives a
  // browser-closing stop that deleted the session. Always 200 — an unknown
  // session reads as `{ finalized: false }`.
  app.get('/sessions/:id/last-run', (req: Request, res: Response) => {
    const sessionId = String(req.params.id);
    res.status(200).json(sessionManager.getLastRun(sessionId));
  });

  // POST /sessions/:id/report — render the one report of a data-driven run
  // (stories/data-driven-rows.md, decision 12).
  //
  // Its own call rather than a flag on the last batch, because the client
  // cannot know which batch is the last one until that batch comes back: a
  // pause ends the loop after the current row, Stop ends it mid-row, and a
  // throw ends it there. Keying finalisation on `dataRow === dataRowCount`
  // would lose the report on exactly the runs where it matters most.
  //
  // `notRun` is supplied by the client because only the client knows which
  // rows it planned and never reached.
  app.post('/sessions/:id/report', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = String(req.params.id);
      const body = (req.body ?? {}) as { notRun?: unknown };
      const notRun: Array<{ index: number; values: Record<string, string>; reason: string }> = [];

      if (body.notRun !== undefined) {
        if (!Array.isArray(body.notRun)) {
          res.status(400).json({ error: 'notRun must be an array.' });
          return;
        }
        for (const entry of body.notRun as Array<Record<string, unknown>>) {
          const row = entry?.['row'];
          if (!Number.isInteger(row) || (row as number) < 1) {
            res.status(400).json({ error: 'Each notRun entry needs a positive integer "row".' });
            return;
          }
          notRun.push({
            index: row as number,
            values: (entry['values'] as Record<string, string>) ?? {},
            reason: typeof entry['reason'] === 'string' ? entry['reason'] : 'stopped',
          });
        }
      }

      const result = await sessionManager.finalizeRowRun(sessionId, notRun);
      if (!result) {
        // Not a 500: an unknown or already-finalised accumulator is what a
        // double-post after a crash looks like, and that is harmless.
        res.status(404).json({ error: `No data rows accumulated for session "${sessionId}".` });
        return;
      }
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /config — the effective server config and the run settings in force
  // (stories/run-settings.md §6).
  //
  // Behind auth, unlike `/health`. `/health` is unauthenticated because its body
  // carries nothing but counts; this one reports project paths and the resolved
  // model, which is a different disclosure and belongs behind the key.
  //
  // `?sessionId=` adds that session's retained overrides. An unknown id is a 404
  // rather than the base config: answering a question about session X with
  // "here is what nobody in particular is doing" is the confusion this endpoint
  // exists to remove.
  //
  // Behind auth also means it bumps the idle monitor, which is correct for a
  // client action and wrong for a poll. Worth remembering if a status bar ever
  // wants to display the effective settings — a polled route here would keep the
  // server alive forever and make the idle timeout dead code, which is the
  // failure `/health` was deliberately kept pre-auth to avoid.
  app.get('/config', (req: Request, res: Response) => {
    const rawSessionId = req.query['sessionId'];
    if (rawSessionId !== undefined && typeof rawSessionId !== 'string') {
      res.status(400).json({ error: 'sessionId must be a single string value.' });
      return;
    }
    // An empty `?sessionId=` is a caller who meant to name one and did not.
    // Treating it as absent would silently answer a different question.
    if (rawSessionId === '') {
      res.status(400).json({ error: 'sessionId must not be empty.' });
      return;
    }

    const settings = sessionManager.getRunSettings(rawSessionId);
    if (!settings) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.status(200).json({ config: redactConfig(config), ...settings });
  });

  // DELETE /sessions/:id
  app.delete('/sessions/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = String(req.params.id);
      await sessionManager.closeSession(sessionId);
      res.status(200).json({ status: 'closed', sessionId });
    } catch (err) {
      next(err);
    }
  });

  // GET /sessions
  app.get('/sessions', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const sessions = await sessionManager.getActiveSessionsWithTitles();
      res.status(200).json({ sessions });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // CDP browsers (stories/mcp-cdp-browser.md §4)
  //
  // Both routes sit behind the auth middleware, so both bump the idle monitor.
  // That is fine only because no client polls them: flick refreshes on open
  // plus a manual button, TestBench does not use them at all, and an MCP tool
  // call is a user action. A polling client here would silently defeat the
  // idle timeout — the failure `/health` was deliberately kept pre-auth to
  // avoid (idle-monitor.ts:10). Worth remembering before adding a caller.
  //
  // **The server owns browsers, so the server launches them.** No client
  // spawns one — not MCP, not flick, not the CLI. That is the existing "one
  // server owns browsers, sessions, cache and lifecycle" decision applied,
  // not a new one: a browser spawned from an MCP process would be invisible to
  // every other client and duplicated across every MCP host.
  // -------------------------------------------------------------------------

  /**
   * In-flight launches, keyed by `(projectRoot, engine, profile)`.
   *
   * Without this, two clients that both see "nothing alive" both spawn, and
   * the loser hits Chromium's singleton lock and exits — leaving one caller
   * holding a successful-looking result for a browser that is not there.
   *
   * All three key parts are load-bearing. Dropping `profile` would serialise
   * two launches that are legitimately concurrent (admin and default are
   * different processes on different ports); dropping `engine` or
   * `projectRoot` would let a destructive `reset` run against a profile
   * another call is mid-launch on.
   */
  const cdpLaunchesInFlight = new Map<string, Promise<StartResult>>();

  /**
   * Serialises tab closes per browser. A **queue**, not a single-flight —
   * two closes of two different tabs must both happen, just not at once.
   *
   * Without it the `allow_browser_exit` flag is bypassable, which is the one
   * guarantee this route exists to give. Two concurrent closes against a
   * two-tab browser both read a list of length two, both conclude they are not
   * closing the last tab, and both proceed — and the browser exits with
   * neither caller having asked for that. An MCP host issuing two tool calls
   * in one turn ("close both of those") is enough to trigger it.
   *
   * **Keyed on the port alone, deliberately.** A port is one listening socket
   * on this machine, so it identifies the browser; `projectRoot` does not.
   * Including the root gave one browser a queue *per project*, and this server
   * is a per-machine singleton serving many roots — so two projects addressing
   * the same browser (which `allowUnowned` permits) would each get their own
   * chain and the guarantee would evaporate exactly where it was needed.
   */
  const cdpCloseQueues = new Map<number, Promise<unknown>>();

  function queueCdpClose<T>(key: number, work: () => Promise<T>): Promise<T> {
    const tail = (cdpCloseQueues.get(key) ?? Promise.resolve())
      // `.catch` so one failed close does not poison the chain for the next
      // caller; the failure is still returned to whoever asked for it.
      .then(work, work);
    // Keep the queue keyed only while this link is the tail, so a browser that
    // goes quiet does not retain its chain forever.
    cdpCloseQueues.set(key, tail);
    void tail.catch(() => {}).finally(() => {
      if (cdpCloseQueues.get(key) === tail) cdpCloseQueues.delete(key);
    });
    return tail;
  }

  /**
   * The roots a CDP request sweeps: the named project root plus — always —
   * the machine-wide user root (stories/mcp-no-project.md, "both roots are
   * always swept"). The server computes the user root itself: every client is
   * loopback on this machine, so the two processes share one `%LOCALAPPDATA%`.
   *
   * A project-less caller passes the user root AS its projectRoot, so the two
   * entries collapse to one — compared canonically (realpath when it exists,
   * case-folded on win32) so an alias of the same directory cannot double
   * every entry in the sweep.
   */
  const canonicalRoot = (target: string): string => {
    let resolved = path.resolve(target);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      // Not existing yet is fine — a fresh machine has no user root until
      // the first launch creates it, and an absent directory still needs a
      // stable identity for the comparison below.
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  /** Whether a request's projectRoot IS the user root — which is how a
   *  project-less caller addresses it, and how a launch decides which scope
   *  to report back. */
  const isUserRoot = (projectRoot: string): boolean =>
    canonicalRoot(projectRoot) === canonicalRoot(userRootDir());

  function cdpRoots(projectRoot: string): ScopedRoot[] {
    if (isUserRoot(projectRoot)) {
      return [{ root: userRootDir(), scope: 'user' }];
    }
    return [
      { root: projectRoot, scope: 'project' },
      { root: userRootDir(), scope: 'user' },
    ];
  }

  app.get('/cdp/browsers', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectRoot = typeof req.query['projectRoot'] === 'string' ? req.query['projectRoot'] : '';
      if (!projectRoot) {
        res.status(400).json({ error: 'projectRoot query parameter is required' });
        return;
      }
      if (!path.isAbsolute(projectRoot)) {
        res.status(400).json({ error: `projectRoot must be an absolute path (got "${projectRoot}")` });
        return;
      }

      const includeForeign = req.query['includeForeign'] === 'true' || req.query['includeForeign'] === '1';
      // Whether the caller may see foreign tab titles and URLs. The server
      // cannot tell an agent from a human — TestBench and flick authenticate
      // too — so it honours what it is asked. The withholding gate is
      // MCP-side (§6): the MCP client simply does not ask for these unless
      // `mcp.cdp.allowUnowned` is set.
      const includeForeignTabs =
        req.query['includeForeignTabs'] === 'true' || req.query['includeForeignTabs'] === '1';

      const profiles = await knownProfilesAcross(cdpRoots(projectRoot));
      const live = profiles.filter((p) => p.live && p.port !== null);
      // Which session is on which tab (stories/cdp-tabs.md §1). A map lookup
      // against sessions this server already holds — the per-page target ids
      // were resolved and cached when each page was adopted, so this costs no
      // CDP round-trip. It is what makes the close refusal predictable rather
      // than a surprise: the agent can see a tab is spoken for before trying.
      const holders = await Promise.all(
        live.map(async (p) => (await sessionManager.sessionsByTarget(p.port as number)).byTarget),
      );
      const running = live.map((p, i) => ({
        engine: p.engine,
        profile: p.profile,
        port: p.port as number,
        profileDir: p.profileDir,
        scope: p.scope,
        tabs: (p.tabs ?? []).map((t) => ({
          ...t,
          sessionId: holders[i]?.get(t.targetId) ?? null,
        })),
      }));
      // No `port` field at all, rather than `port: null`. An `available` entry
      // is a directory, not a browser; giving it a port-shaped hole invites a
      // caller to try to attach to it.
      const available = profiles
        .filter((p) => !p.live)
        .map((p) => ({
          engine: p.engine,
          profile: p.profile,
          profileDir: p.profileDir,
          scope: p.scope,
        }));

      const foreign: {
        engine: string;
        port: number;
        tabs: { targetId: string; title: string; url: string }[] | null;
        tabsWithheld: boolean;
        error: string | null;
      }[] = [];

      if (includeForeign) {
        // The only port scan in the design. Our own browsers are on
        // OS-assigned ports that nothing can guess, so scanning could never
        // find them — but a browser someone else started is by definition on
        // a conventional one.
        const ourPorts = new Set(running.map((r) => r.port));
        const scanned = await discoverCdpPorts();
        for (const probe of scanned) {
          if (!probe.reachable) continue;
          // Not an attachable browser. 9229 is in the scan list and is the
          // Node --inspect default — including this server's own debugger.
          if (probe.engine === 'node') continue;
          // An OS-assigned port can legitimately land on 9222: W0 saw ports
          // as low as 7566. A browser we own is never foreign.
          if (ourPorts.has(probe.port)) continue;
          foreign.push({
            engine: probe.engine,
            port: probe.port,
            tabs: includeForeignTabs ? (probe.tabs ?? []) : null,
            tabsWithheld: !includeForeignTabs,
            error: probe.error ?? null,
          });
        }
      }

      res.status(200).json({ running, available, foreign });
    } catch (err) {
      next(err);
    }
  });

  app.post('/cdp/browsers', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const projectRoot = typeof body.projectRoot === 'string' ? body.projectRoot : '';
      if (!projectRoot) {
        res.status(400).json({ error: 'projectRoot is required' });
        return;
      }
      if (!path.isAbsolute(projectRoot)) {
        res.status(400).json({ error: `projectRoot must be an absolute path (got "${projectRoot}")` });
        return;
      }
      const engine = body.engine;
      if (engine !== 'chrome' && engine !== 'edge') {
        res.status(400).json({ error: 'engine must be "chrome" or "edge"' });
        return;
      }
      if (body.profile !== undefined && typeof body.profile !== 'string') {
        res.status(400).json({ error: 'profile must be a string' });
        return;
      }
      const profile = (body.profile as string | undefined) ?? DEFAULT_PROFILE;
      const reset = body.reset === true;

      // Launch settings come from the aiui.config.json of the root the browser
      // is launched into — read exactly there, no walk-up, so the user root's
      // own file governs a machine-wide browser and nothing above it can. Read
      // per request rather than off the server's startup config: the server is
      // shared across projects, and browser.cdp.hideAutomation is the
      // project's (or the user's) decision, not the server's. A malformed file
      // refuses the launch — the flags it governs cannot be known, and guessing
      // "off" would silently start a different browser than the one asked for.
      let hideAutomation = false;
      try {
        const launchConfig = await loadConfig(undefined, projectRoot);
        hideAutomation = launchConfig.browser.cdp?.hideAutomation === true;
      } catch (err) {
        res.status(statusForCdpFailure('invalid_input')).json({
          error:
            `Cannot start a browser for ${projectRoot}: its aiui.config.json could not be ` +
            'loaded, so the launch settings it governs are unknown. ' +
            `${err instanceof Error ? err.message : String(err)}`,
          reason: 'config_invalid',
        });
        return;
      }

      // Single-flight. The key is built from the validated values so two
      // spellings of the same request share a slot.
      const key = `${projectRoot}\u0000${engine}\u0000${profile}`;
      let pending = cdpLaunchesInFlight.get(key);
      if (!pending) {
        pending = startCdpBrowser({ projectRoot, engine, profile, reset, hideAutomation }).finally(() => {
          cdpLaunchesInFlight.delete(key);
        });
        cdpLaunchesInFlight.set(key, pending);
      }
      const result = await pending;

      if (!result.ok) {
        res.status(statusForCdpFailure(result.kind)).json({ error: result.error, reason: result.reason });
        return;
      }

      res.status(200).json({
        engine: result.engine,
        profile: result.profile,
        port: result.port,
        profileDir: result.profileDir,
        binary: result.binary,
        tabs: result.tabs,
        outcome: result.outcome,
        warnings: result.warnings,
        // Which root the launch went into — the client chose it by which
        // projectRoot it sent, and echoing it back keeps the answer on the
        // result rather than re-derived by every consumer.
        scope: isUserRoot(projectRoot) ? 'user' : 'project',
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The three inputs every per-tab route takes, validated once.
   *
   * Shared by the close and focus routes rather than written twice: they
   * address the same thing by the same three values, and two copies of a
   * validation rule is how one route ends up accepting a port the other
   * rejects. Answers the request and returns null when anything is wrong, so a
   * caller reads it as `if (!params) return;`.
   */
  function readTabParams(
    req: Request,
    res: Response,
  ): { projectRoot: string; port: number; targetId: string } | null {
    const projectRoot =
      typeof req.query['projectRoot'] === 'string' ? req.query['projectRoot'] : '';
    if (!projectRoot) {
      res.status(400).json({ error: 'projectRoot query parameter is required' });
      return null;
    }
    if (!path.isAbsolute(projectRoot)) {
      res.status(400).json({ error: `projectRoot must be an absolute path (got "${projectRoot}")` });
      return null;
    }

    const address = readPortAndTarget(req, res);
    if (!address) return null;
    return { projectRoot, ...address };
  }

  /** The path half of the same addressing, on its own — the peek route
   *  (stories/tab-peek.md) resolves its project from `testFilePath` rather
   *  than from a `projectRoot`, and must still reject the same ports and the
   *  same empty target ids as its two siblings. */
  function readPortAndTarget(
    req: Request,
    res: Response,
  ): { port: number; targetId: string } | null {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      res.status(400).json({ error: `port must be a valid TCP port (got "${req.params.port}")` });
      return null;
    }

    const targetId = String(req.params.targetId ?? '');
    if (targetId === '') {
      res.status(400).json({ error: 'targetId is required' });
      return null;
    }

    return { port, targetId };
  }

  /** Whether a browser this project did NOT launch may be acted on. Same shape
   *  and same reasoning as `includeForeignTabs` on the listing: the server
   *  cannot tell an agent from a human, so it honours what it is asked, and the
   *  withholding lives MCP-side where `mcp.cdp.allowUnowned` is read. Without
   *  this the MCP gate would pass a foreign port that the registry then refuses
   *  anyway — an opt-in that says it grants something it cannot. */
  const readAllowUnowned = (req: Request): boolean =>
    req.query['allowUnowned'] === 'true' || req.query['allowUnowned'] === '1';

  // DELETE /cdp/browsers/:port/tabs/:targetId (stories/cdp-tabs.md §2)
  //
  // The one destructive verb over a live browser. Every guard lives in
  // `closeCdpTab`; this route validates its inputs, supplies the session join
  // the registry cannot see, and maps failures onto status codes.
  app.delete(
    '/cdp/browsers/:port/tabs/:targetId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const params = readTabParams(req, res);
        if (!params) return;
        const { projectRoot, port, targetId } = params;

        const allowBrowserExit =
          req.query['allowBrowserExit'] === 'true' || req.query['allowBrowserExit'] === '1';
        const allowUnowned = readAllowUnowned(req);

        const result = await queueCdpClose(port, () =>
          closeCdpTab({
            roots: cdpRoots(projectRoot),
            port,
            targetId,
            allowBrowserExit,
            allowUnowned,
            // Resolved per call, not cached: a session that bound this tab
            // since the caller last listed must still be seen.
            sessionHolding: async (id) => {
              const { byTarget, complete } = await sessionManager.sessionsByTarget(port);
              const holder = byTarget.get(id);
              if (holder) return holder;
              // An incomplete join cannot say "nobody holds it". Refusing on a
              // maybe is the right trade for a guard whose failure closes a
              // tab out from under a live run.
              return complete ? null : UNKNOWN_HOLDER;
            },
            // The second holder kind (stories/errands.md §The wheel, amending
            // cdp-tabs §2). Synchronous and exact — an errand's holds are in
            // this process's memory, so there is no maybe to fail closed on.
            errandHolding: (id) => errandLocks.holder(port, id),
          }),
        );

        if (!result.ok) {
          res.status(statusForCdpFailure(result.kind)).json({
            error: result.error,
            reason: result.reason,
            // Present only on the errand refusal, so the MCP side can map it to
            // a message naming the errand rather than the generic HTTP arm.
            ...(result.holder ? { holder: result.holder } : {}),
          });
          return;
        }

        res.status(200).json({
          closed: true,
          targetId: result.targetId,
          title: result.title,
          url: result.url,
          engine: result.engine,
          profile: result.profile,
          port: result.port,
          remainingTabs: result.remainingTabs,
          browserExited: result.browserExited,
          owned: result.owned,
          // Null for a permitted foreign browser — no root stands behind it.
          scope: result.scope,
          warnings: result.warnings,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /cdp/browsers/:port/tabs/:targetId/focus (stories/cdp-tab-focus.md §2)
  //
  // `POST` rather than `PUT`: this is an action on a tab, not a replacement of
  // one. **No queue** — the close route serialises per port because two
  // concurrent closes can defeat the last-tab guard; focus has no guard to
  // defeat and no irreversible outcome, so two concurrent focuses simply mean
  // the second wins, which is what "focus" means.
  app.post(
    '/cdp/browsers/:port/tabs/:targetId/focus',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const params = readTabParams(req, res);
        if (!params) return;
        const { projectRoot, port, targetId } = params;

        const result = await focusCdpTab({
          roots: cdpRoots(projectRoot),
          port,
          targetId,
          allowUnowned: readAllowUnowned(req),
        });

        if (!result.ok) {
          res.status(statusForCdpFailure(result.kind)).json({ error: result.error, reason: result.reason });
          return;
        }

        res.status(200).json({
          // "The browser accepted it", not "the user can see it" — the DevTools
          // HTTP surface has no read that would justify the stronger claim, and
          // the field's description says so rather than pretending otherwise.
          focused: true,
          targetId: result.targetId,
          title: result.title,
          url: result.url,
          engine: result.engine,
          profile: result.profile,
          port: result.port,
          // Null for a permitted foreign browser — no root stands behind it.
          scope: result.scope,
          warnings: result.warnings,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /cdp/browsers/:port/tabs/:targetId/content
  // (stories/tab-peek.md; the picture is stories/cdp-tab-screenshot.md)
  //
  // Attach → extract → detach, in one request. A read, so GET and no body —
  // page-content.md §Locked's reasoning applies verbatim.
  //
  // What this route deliberately does NOT do is as load-bearing as what it
  // does: it touches no sessions map, bumps no in-flight run counter (a peek
  // is a read, not a run — verification item 1), takes and consults no errand
  // turn lock in either direction (§No lock), and writes no report file.
  app.get(
    '/cdp/browsers/:port/tabs/:targetId/content',
    async (req: Request, res: Response, next: NextFunction) => {
      const params = readPortAndTarget(req, res);
      if (!params) return;
      const { port, targetId } = params;

      // `format: "screenshot"` takes a different query shape and a different
      // capture, so the split happens here (stories/cdp-tab-screenshot.md).
      // Everything downstream of it — the project bundle, the `activate: false`
      // attach, the detach — is shared, which is the whole reason the picture
      // lives on this route rather than a new one.
      let plan: PeekPlan;
      if (req.query['format'] === 'screenshot') {
        const shot = readScreenshotQuery(req, res);
        if (!shot) return;
        plan = { kind: 'screenshot', fullPage: shot.fullPage };
      } else {
        const opts = readContentQuery(req, res);
        if (!opts) return;
        plan = { kind: 'content', opts };
      }

      // The synthetic `<root>/.aiui-peek.md`, and it is required rather than
      // optional: it is the only thing a project root resolves from, and
      // without it the capture would silently run under library defaults that
      // differ from the project's (a 100k dom clip against a configured 300k,
      // different noise reduction) — so a peek and `get_page_content` would
      // disagree about the same page with nothing saying why.
      const rawTestFilePath = req.query['testFilePath'];
      if (typeof rawTestFilePath !== 'string' || rawTestFilePath === '') {
        res.status(400).json({ error: 'testFilePath query parameter is required' });
        return;
      }
      if (!path.isAbsolute(rawTestFilePath)) {
        res
          .status(400)
          .json({ error: `testFilePath must be an absolute path (got "${rawTestFilePath}")` });
        return;
      }
      // Accepted so the project layer resolves exactly as an errand's does, and
      // so a peek shares the resolver's cache entry with the runs beside it.
      // It changes no capture setting — a peek interpolates nothing.
      const rawEnvName = req.query['envName'];
      if (rawEnvName !== undefined && typeof rawEnvName !== 'string') {
        res.status(400).json({ error: 'envName must be a single string value.' });
        return;
      }

      try {
        // Pre-check, so a tab that closed while we reached for it is a 404
        // with our own JSON envelope rather than whatever `connectOverCDP`
        // makes of a missing target. The MCP side reads that envelope as "the
        // tab is gone"; a BARE 404 means the route itself is missing, and the
        // two remedies are opposites (stories/cdp-tab-focus.md §6).
        //
        // Same device as `focusCdpTab`'s: the browser answers for ids that are
        // not tabs, so the id must be one `toPageTabs` would have shown.
        const tabs = await listPageTabs(port);
        if (tabs === null) {
          res.status(statusForCdpFailure('launch_failed')).json({
            reason: 'tab_list_unreadable',
            error:
              `Could not read the tab list from the browser on port ${port}. ` +
              'It may be shutting down.\n' +
              'Call list_cdp_browsers to see what is still running.',
          });
          return;
        }
        if (!tabs.some((tab) => tab.targetId === targetId)) {
          res.status(statusForCdpFailure('not_found'))
            .json({ error: goneTabMessage(port, targetId), reason: 'tab_vanished' });
          return;
        }

        // The project layer, through the SAME resolver a session and an errand
        // use, so all three read the same `.env` and the same config at the
        // same moment.
        const bundle = await projectBundles.resolve(rawTestFilePath, rawEnvName?.trim() || null);

        // The same attach `ErrandRunner.drive` makes, with one parameterised
        // difference: `activate: false`, because a read must not move the
        // user's window (stories/tab-peek.md §Attach, amending
        // cdp-tab-focus.md §3). The exact `targetId:` spec means the
        // first-match-wins arm of `resolveCdpTab` is never asked to arbitrate.
        const attached = await launchBrowser(bundle.config.browser, {
          port,
          tab: `targetId:${targetId}`,
          activate: false,
        });

        let content;
        try {
          if (plan.kind === 'screenshot') {
            // NOT the run pipeline's `captureScreenshot`, and the difference
            // was measured rather than reasoned about: Playwright's viewport
            // screenshot waits for a stable composited frame, which a MINIMIZED
            // window never produces, so it hangs and times out. Driving
            // `Page.captureScreenshot` directly skips that wait — see the table
            // on `captureTabScreenshot` (stories/cdp-tab-screenshot.md W1).
            const shot = await captureTabScreenshot(attached.page, plan.fullPage);
            if (!shot.ok) {
              // Never an empty picture: that would report a blank page, a claim
              // about the page nobody downstream can correct. And the two
              // reasons get different words because they have different fixes —
              // a timeout is a fact about the WINDOW, and telling someone their
              // page is wedged sends them debugging instead of un-minimizing.
              res.status(statusForCdpFailure(shot.reason === 'timeout' ? 'refused' : 'launch_failed')).json({
                reason:
                  shot.reason === 'timeout' ? 'tab_screenshot_timeout' : 'tab_screenshot_failed',
                error:
                  shot.reason === 'timeout'
                    ? `The tab on port ${port} did not produce a picture (${shot.detail}).\n` +
                      'A MINIMIZED window is the usual cause: it composes no new ' +
                      'frame, so there is nothing to photograph until something ' +
                      'wakes it. The tab itself is fine.\n' +
                      'Restore the window (or focus_cdp_tab) and ask again — it is ' +
                      'instant once the window is on screen. A background tab of a ' +
                      'VISIBLE window photographs fine as it is.\n' +
                      'Or read the page with format "text", which works either way.'
                    : `Could not photograph the tab on port ${port} (${shot.detail}). ` +
                      'The tab is there but the capture failed — the browser may be ' +
                      'mid-navigation or wedged. This is NOT a blank page. Try ' +
                      'again, or read it with format "text".',
              });
              return;
            }
            const image = shot.image;
            const identity = await readPageIdentity(attached.page);
            content = {
              // Named, not spread: `readPageIdentity` also reports whether the
              // read went stale, and that belongs to the navigation's warning —
              // spreading it would put an undeclared field on this response.
              url: identity.url,
              title: identity.title,
              format: 'screenshot' as const,
              // Null for the same reason the argument is refused: nothing
              // narrowed this picture.
              selector: null,
              screenshot: image.base64,
              width: image.width,
              height: image.height,
            };
          } else {
            // `bundle.config.browser` on BOTH sides of this: the attach above and
            // the capture here read the project's settings, never the server's.
            content = await capturePageContent(attached.page, bundle.config.browser, plan.opts);
          }
        } finally {
          // Disconnect, never kill. `closeBrowser` severs the CDP websocket and
          // closes only a tab the attach itself opened — a `targetId:` attach
          // opens none, so nothing of the user's browser changes. In a
          // `finally` because the connection also holds the context-wide dialog
          // guard, and a peek must hold that for as long as the extraction
          // takes and not one moment longer (§Detach).
          await closeBrowser(attached);
        }

        res.status(200).json({
          targetId,
          // The root the SETTINGS came from, which is the claim
          // stories/mcp-no-project.md asks every result to make. Null when no
          // `aiui.config.json` stood above the synthetic path, in which case
          // the server's own defaults were used and saying otherwise would be
          // an invention.
          root: bundle.projectRoot,
          ...content,
        });
      } catch (err) {
        if (respondToPageCaptureError(err, res)) return;
        // The other half of the same 404, and the reason the pre-check above
        // is not the whole answer: it reads the browser's tab list a moment
        // BEFORE the attach, and a tab closed inside that window reaches
        // `resolveCdpTab` instead. Left to `next`, that arrives as a 500
        // carrying `CDP: no tab matches targetId "…"` — internal prose the MCP
        // side can only read as a server fault, sending a caller to rebuild or
        // retry when the true answer is "that tab is gone, here is what is
        // open". Same envelope, same status, same words as the pre-check.
        if (err instanceof CdpTabNotFoundError) {
          res.status(statusForCdpFailure('not_found'))
            .json({ error: goneTabMessage(port, targetId), reason: 'tab_vanished' });
          return;
        }
        next(err);
      }
    },
  );

  // POST /cdp/browsers/:port/navigate (stories/navigate-tab.md)
  //
  // The framework's only navigation that costs no model. Everything downstream
  // of the guards is the peek route's — same project resolution, same
  // `activate: false` attach, same disconnect-not-kill detach — because the
  // difference between this verb and that one is what it is ALLOWED to do, not
  // how it reaches the browser.
  //
  // Not `/tabs/:targetId/navigate`: the target is optional here, and a path that
  // requires one would make opening a new tab the awkward case rather than the
  // default. That default is the whole safety story (§Locked).
  app.post(
    '/cdp/browsers/:port/navigate',
    async (req: Request, res: Response, next: NextFunction) => {
      const port = Number(req.params.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        res.status(400).json({ error: `port must be a valid TCP port (got "${req.params.port}")` });
        return;
      }

      const body = (req.body ?? {}) as {
        url?: unknown;
        targetId?: unknown;
        testFilePath?: unknown;
        envName?: unknown;
      };

      const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
      if (rawUrl === '') {
        res.status(400).json({ error: 'url is required' });
        return;
      }
      // Scheme first, before anything is resolved or attached. `javascript:` is
      // code execution in a browser holding real logins, `file:` is local disk,
      // `chrome:` is settings — and none of them is what anyone means by "open".
      // Plain `http` IS allowed and says nothing: internal tools live there, and
      // a warning on every call is noise nobody can act on.
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        res.status(400).json({
          error:
            `"${rawUrl}" is not a URL this can navigate to. Give an absolute ` +
            'http:// or https:// address, including the scheme.',
        });
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        res.status(400).json({
          error:
            `Refusing to navigate to a "${parsed.protocol}" address — only http ` +
            'and https are allowed.\n' +
            'javascript: runs code in a browser holding real logins, file: reads ' +
            'local disk, and chrome:/about: are the browser\'s own settings.',
        });
        return;
      }

      const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';

      // Same synthetic-path contract the peek route documents: it is the only
      // thing a project root resolves from, and without it the attach runs under
      // library defaults that differ from the project's.
      const rawTestFilePath = body.testFilePath;
      if (typeof rawTestFilePath !== 'string' || rawTestFilePath === '') {
        res.status(400).json({ error: 'testFilePath is required' });
        return;
      }
      if (!path.isAbsolute(rawTestFilePath)) {
        res
          .status(400)
          .json({ error: `testFilePath must be an absolute path (got "${rawTestFilePath}")` });
        return;
      }
      const rawEnvName = body.envName;
      if (rawEnvName !== undefined && typeof rawEnvName !== 'string') {
        res.status(400).json({ error: 'envName must be a single string value.' });
        return;
      }

      try {
        if (targetId !== '') {
          // The replace path, and every guard on it lives here rather than in
          // the caller. The pre-check first, so a tab that closed while we
          // reached for it is our own 404 envelope (cdp-tab-focus §6).
          const tabs = await listPageTabs(port);
          if (tabs === null) {
            res.status(statusForCdpFailure('launch_failed')).json({
              reason: 'tab_list_unreadable',
              error:
                `Could not read the tab list from the browser on port ${port}. ` +
                'It may be shutting down.\n' +
                'Call list_cdp_browsers to see what is still running.',
            });
            return;
          }
          if (!tabs.some((tab) => tab.targetId === targetId)) {
            res
              .status(statusForCdpFailure('not_found'))
              .json({ error: goneTabMessage(port, targetId), reason: 'tab_vanished' });
            return;
          }

          // Who is driving it. The EXACT OPPOSITE of the peek, which proceeds
          // happily alongside a driver because a read cannot spoil one — a
          // navigation yanks the page out from under a run mid-step. Both holder
          // kinds, same shapes `close_cdp_tab` already refuses on.
          const errandHolder = errandLocks.holder(port, targetId);
          if (errandHolder) {
            res.status(statusForCdpFailure('refused')).json({
              reason: 'tab_held_by_errand',
              error:
                `That tab is being driven by errand ${errandHolder.errandId}, so ` +
                'navigating it now would move the page out from under a run in ' +
                'progress.\nWait for the errand to finish, or navigate a different tab.',
              holder: errandHolder,
            });
            return;
          }
          const { byTarget, complete } = await sessionManager.sessionsByTarget(port);
          const sessionHolder = byTarget.get(targetId);
          if (sessionHolder || !complete) {
            // An incomplete join cannot say "nobody holds it", and refusing on a
            // maybe is the right trade for a guard whose failure navigates a tab
            // out from under a live run.
            res.status(statusForCdpFailure('refused')).json({
              error: sessionHolder
                ? `That tab is being driven by session ${sessionHolder}, so ` +
                  'navigating it now would move the page out from under a run in ' +
                  'progress.\nClose that session first, or navigate a different tab.'
                : 'Could not confirm whether a session is driving that tab, and a ' +
                  'navigation that lands on a live run is not worth the risk.\n' +
                  'Call list_sessions, then try again.',
            });
            return;
          }
        }

        const bundle = await projectBundles.resolve(rawTestFilePath, rawEnvName?.trim() || null);

        // `new` when no target was named — the default, and the only arm that
        // destroys nothing. `activate: false` gates the EXISTING-tab arm only, so
        // a tab this opens still appears: you asked for something to be opened.
        const attached = await launchBrowser(bundle.config.browser, {
          port,
          tab: targetId === '' ? 'new' : `targetId:${targetId}`,
          activate: false,
        });

        const warnings: string[] = [];
        let identity;
        let landedTargetId: string | null = targetId === '' ? null : targetId;
        try {
          try {
            await attached.page.goto(parsed.toString(), {
              waitUntil: 'domcontentloaded',
              timeout: NAVIGATE_TIMEOUT_MS,
            });
          } catch (err) {
            // A timeout is NOT a failure: the navigation happened and the tab
            // moved, so refusing would misreport it and leave a tab somewhere the
            // caller does not know about. Anything else is a real error.
            if (!isTimeoutError(err)) throw err;
            warnings.push(
              `The page had not finished loading after ` +
                `${Math.round(NAVIGATE_TIMEOUT_MS / 1000)}s (waiting for ` +
                'domcontentloaded), so the tab is there but the document is still ' +
                'arriving. Reading it now may show a partial page, or miss elements ' +
                'that have not loaded yet — peek_tab again in a moment if something ' +
                'you expect is absent.',
            );
          }

          identity = await readPageIdentity(attached.page);
          if (identity.stale) {
            warnings.push(
              'The page moved again while we were reading it, so the url and title ' +
                'reported may be the previous page rather than where the tab ended ' +
                'up. peek_tab to see where it actually is.',
            );
          }
          if (landedTargetId === null) {
            const ref = await attached.pageTracker.activeTabRef();
            landedTargetId = ref?.targetId ?? null;
          }
        } finally {
          // **The tab we opened is the deliverable, not scaffolding.**
          // `closeBrowser` closes a tab the attach itself opened, which is right
          // for a RUN — a test that opened a tab should take its coat when it
          // leaves — and exactly wrong here, where opening the tab IS the job.
          // Caught live: without this the new tab appeared, navigated, and
          // vanished before the caller could ever peek at it.
          attached.cdpTabOpenedByUs = false;
          // Disconnect, never kill — and in a `finally` because the connection
          // holds the context-wide dialog guard.
          await closeBrowser(attached);
        }

        res.status(200).json({
          requestedUrl: parsed.toString(),
          url: identity.url,
          title: identity.title,
          // Null only when a brand-new tab could not be identified afterwards;
          // the navigation still happened, and inventing an id would be worse.
          targetId: landedTargetId,
          openedNewTab: targetId === '',
          root: bundle.projectRoot,
          warnings,
        });
      } catch (err) {
        if (err instanceof CdpTabNotFoundError) {
          res
            .status(statusForCdpFailure('not_found'))
            .json({ error: goneTabMessage(port, targetId) });
          return;
        }
        next(err);
      }
    },
  );

  // Error handling middleware
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${message}`);
    res.status(500).json({ error: message });
  });

  return {
    app,
    sessionManager,
    idleMonitor,
    errandLocks,
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

/** Grace delay before exiting so the shutdown response flushes to the client. */
const SHUTDOWN_GRACE_MS = 250;
/** Backstop for a teardown that hangs (a wedged browser, a stuck socket). */
const SHUTDOWN_HARD_EXIT_MS = 10_000;

/** Just enough of `process` to register the two guards, so a test can pass a
 *  bare EventEmitter instead of arming handlers on the real process. */
export interface CrashGuardTarget {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (reason: unknown) => void): unknown;
}

/**
 * Keep the server alive through an async failure nobody was awaiting.
 *
 * The Sessions API is a shared, long-lived process holding every client's
 * sessions and every browser those sessions drive. Node's default for an
 * unowned rejection is to exit, and that default is calibrated for a one-shot
 * script, not for this: issues/047 is a Playwright event handler dropping a
 * rejected `Page.handleJavaScriptDialog` on the floor, which took the whole
 * process down mid-run and lost every session — while the browsers it had
 * launched stayed orphaned and the MCP client got a naked dropped stream it
 * could only describe as "the run may still be executing".
 *
 * The specific bug is fixed at the source (`installDialogGuard`). This is the
 * backstop for the next one, and the class is worth a backstop: a stray promise
 * inside a browser event listener says nothing about whether this process can
 * keep serving the sessions it is holding. So both handlers log loudly
 * — with the stack, which is the whole reason you want one of these — and
 * carry on. A run whose own await chain broke still fails on its own; nothing
 * here papers over that.
 *
 * `uncaughtException` is the one to be uneasy about, since Node's warning about
 * an indeterminate process state is real. It is installed anyway because a
 * synchronous throw from the same class of listener has the same blast radius,
 * and "definitely lose every session" is worse than "possibly degraded".
 *
 * **Armed only once the listener is bound**, which is load-bearing rather than
 * tidy. A failed `listen` — EADDRINUSE, above all — surfaces as an uncaught
 * exception, and `mcp/server-start.ts` depends on that being fatal: a second
 * server spawned onto a taken port must die there, not linger as a process that
 * never bound anything. `app.listen`'s callback never runs in that case, so
 * startup stays exactly as fatal as it was.
 */
export function installCrashGuards(target: CrashGuardTarget = process): void {
  const describe = (err: unknown): string =>
    err instanceof Error ? (err.stack ?? err.message) : String(err);

  target.on('unhandledRejection', (reason: unknown) => {
    logger.error(
      `Unhandled promise rejection — the server is staying up and sessions are ` +
        `unaffected:\n${describe(reason)}`,
    );
  });
  target.on('uncaughtException', (err: unknown) => {
    logger.error(
      `Uncaught exception — the server is staying up and sessions are ` +
        `unaffected:\n${describe(err)}`,
    );
  });
}

export async function startServer(config: Config): Promise<void> {
  let shuttingDown = false;

  // `shutdown` is a hoisted function declaration, not a `const` arrow, so the
  // hook can be handed to `createApiServer` before `server` exists without a
  // mutable trampoline — a placeholder that has to be swapped in later is a
  // window in which a stop request gets a 200 and does nothing.
  const { app, sessionManager, idleMonitor, beginShutdown } = createApiServer(config, {
    requestShutdown: (force) =>
      void shutdown(`${force ? 'Forced shutdown' : 'Shutdown'} requested — ${closingSummary()}`),
  });
  const { host, port } = config.server;

  /** Shared tail of every shutdown log line, so the reason reads as one
   *  sentence naming what is about to be closed. */
  const closingSummary = () =>
    `closing ${sessionManager.countOpenSessions()} session(s) and shutting down`;

  const server = app.listen(port, host, () => {
    // Only now — see `installCrashGuards` on why a failed bind must stay fatal.
    installCrashGuards();
    logger.info(`Sessions API server listening on http://${host}:${port}`);
    if (idleMonitor.armed) {
      logger.info(
        `Idle timeout armed: ${idleMonitor.timeoutMinutes}m with no run in flight ` +
          'and no authenticated request',
      );
    }
    logger.info('Server ready — press Ctrl+C to stop');
  });

  const stopIdleReaper = startIdleReaper({
    monitor: idleMonitor,
    // The second half of the idle definition (§3): a busy server is never
    // idle, however quiet the socket has been. An open-but-idle session is
    // deliberately NOT busy — it is closed on the way out.
    isBusy: () => sessionManager.runsInFlight() > 0,
    onExpire: () => void shutdown(`Idle for ${idleMonitor.timeoutMinutes}m — ${closingSummary()}`),
  });

  async function shutdown(reason: string): Promise<void> {
    // Re-entrancy guard: SIGINT twice, or an idle expiry racing an explicit
    // `aiui stop`, must not run teardown twice.
    if (shuttingDown) return;
    shuttingDown = true;
    stopIdleReaper();

    // Nothing can rescue a hung teardown from inside the teardown, so arm the
    // hard exit first. unref'd so it never itself keeps the process alive.
    const hardExit = setTimeout(() => {
      logger.warn('Shutdown did not complete in time — exiting anyway');
      process.exit(0);
    }, SHUTDOWN_HARD_EXIT_MS);
    hardExit.unref();

    logger.info(reason);

    // §2's order exactly: stop accepting new work, close all sessions, then
    // close the listener.
    //
    // The work gate is `beginShutdown()`, not `server.close()`. That matters
    // twice over: `close()` only refuses new *connections*, so a client on an
    // already-open keep-alive socket (TestBench holds one) could otherwise
    // slip a run in while browsers were closing — and closing the listener
    // early also makes `/health` go dark instantly, so `aiui stop`'s
    // confirmation poll would report "stopped" while teardown was still
    // running. Keeping the listener up until sessions are closed is what
    // makes that confirmation mean anything.
    beginShutdown();
    try {
      await sessionManager.closeAll();
    } catch (err) {
      logger.warn(`Error while closing sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
    server.close();
    // Give the in-flight response (the `aiui stop` caller's 200) time to
    // flush before the socket dies with the process.
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  }

  process.on('SIGINT', () => void shutdown(`Received SIGINT — ${closingSummary()}`));
  process.on('SIGTERM', () => void shutdown(`Received SIGTERM — ${closingSummary()}`));
}

/**
 * Map a registry refusal onto an HTTP status.
 *
 * Split out so the classification lives next to the codes rather than inside
 * a route handler, and so it stays a total function over `CdpFailureKind` —
 * adding a kind without a code becomes a type error rather than a silent 500.
 */
function statusForCdpFailure(kind: CdpFailureKind): number {
  switch (kind) {
    case 'invalid_input':
      return 400;
    // The port is not one of ours, or the browser has no such tab. 404 rather
    // than 409: nothing about the state needs changing, the caller named
    // something that is not here.
    case 'not_found':
      return 404;
    // Well-formed, but the state on disk says no: a live browser on the
    // profile, a directory we did not create, a tab a session is driving.
    // Retrying verbatim will fail the same way, which is what 409 tells a
    // client.
    case 'refused':
      return 409;
    case 'launch_failed':
      return 500;
  }
}

/**
 * The server's config with both secrets replaced by whether they are set.
 *
 * Removed and replaced with a sibling boolean rather than blanked to `"***"`:
 * a redacted-looking string is still a string, and a client that echoes config
 * into a log, a tool result or an editor panel would carry it around as though
 * it were a value. `apiKeySet` cannot be mistaken for a key.
 */
function redactConfig(config: Config): Record<string, unknown> {
  const { apiKey: aiKey, ...ai } = config.ai;
  const { apiKey: serverKey, ...server } = config.server;
  return {
    ...config,
    ai: { ...ai, apiKeySet: typeof aiKey === 'string' && aiKey.length > 0 },
    server: { ...server, apiKeySet: typeof serverKey === 'string' && serverKey.length > 0 },
  };
}

/**
 * Parse `runSettings` off a request body, or return the 400 message.
 *
 * Split out so the validation reads as one table rather than fifteen lines
 * inside an already-long route handler, and so the tests can cover the refusals
 * without an HTTP round-trip per case.
 *
 * The clearing values (`null` on the model and the booleans, `'default'` on the
 * enum) are PRESERVED here rather than dropped: `mergeRunSettings` distinguishes
 * an absent key ("leave what the session has") from a clearing one ("stop
 * overriding"), and dropping them here would collapse the two.
 */
function parseRunSettings(raw: unknown): RunSettings | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return '"runSettings" must be an object';
  }
  const input = raw as Record<string, unknown>;

  const unknown = Object.keys(input).filter((key) => !RUN_SETTING_KEYS.includes(key));
  if (unknown.length > 0) {
    return (
      `Unknown runSettings key(s) ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
      `Valid keys are ${RUN_SETTING_KEYS.join(', ')}.`
    );
  }

  const out: RunSettings = {};

  if ('capture' in input) {
    const capture = input.capture;
    if (typeof capture !== 'string' || !CAPTURE_MODES.includes(capture as CaptureMode)) {
      return (
        `Invalid runSettings.capture ${JSON.stringify(capture)}. ` +
        `Valid values are ${CAPTURE_MODES.map((m) => `"${m}"`).join(', ')}.`
      );
    }
    out.capture = capture as CaptureMode;
  }

  if ('ai' in input) {
    const ai = input.ai;
    if (typeof ai !== 'string' || !AI_MODES.includes(ai as AiMode)) {
      return (
        `Invalid runSettings.ai ${JSON.stringify(ai)}. ` +
        `Valid values are ${AI_MODES.map((m) => `"${m}"`).join(', ')}.`
      );
    }
    out.ai = ai as AiMode;
  }

  if ('model' in input) {
    const model = input.model;
    if (model === null) {
      // Explicit "stop overriding the model".
      out.model = null;
    } else if (typeof model !== 'string' || model.trim() === '') {
      // The gateway is the authority on which models exist — a client-side
      // allow-list would go stale — so anything non-empty passes through. Only
      // "nothing at all" is refused, because it cannot be what was meant.
      return 'runSettings.model must be a non-empty string, or null to clear the override.';
    } else {
      out.model = model.trim();
    }
  }

  for (const key of ['fullPage', 'sendScreenshots'] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === null) {
      out[key] = null;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      return `runSettings.${key} must be a boolean, or null to clear the override.`;
    }
  }

  return out;
}

/**
 * Parse an errand request off a request body, or return the 400 message.
 *
 * An explicit per-field allow-list, like the steps route's request builder and
 * for the same reason: `ErrandRequest` is BUILT here, so widening the type
 * alone compiles cleanly and drops the field at runtime — which is exactly how
 * `envName` was lost once.
 *
 * Every refusal names what was wrong. An errand is one request with no state
 * behind it, so a caller that guessed a field name has nothing to inspect
 * afterwards; the refusal is the only feedback there is.
 */
/**
 * The compile request's per-field allow-list (stories/codebehind-compile.md
 * §Server).
 *
 * Built field by field, like `StepRequest` and for the same reason: widening
 * the TYPE alone compiles cleanly and drops the field at runtime, which is
 * exactly how `envName` was lost once. Every field this endpoint accepts is
 * named here, and anything else the caller sends is discarded on purpose.
 *
 * A refusal, not a fallback, wherever a wrong value would change what compiles:
 * `select.steps` naming step 0 is a typo with a plausible reading, and quietly
 * compiling something else would be worse than saying no.
 */
export function parseCompileRequest(raw: unknown): CompileRequest | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'Request body must be an object';
  }
  const body = raw as Record<string, unknown>;

  const testFilePath = body.testFilePath;
  if (typeof testFilePath !== 'string' || testFilePath === '') {
    return '"testFilePath" is required — the test to compile';
  }
  if (!path.isAbsolute(testFilePath)) {
    return `"testFilePath" must be an absolute path (got "${testFilePath}")`;
  }

  const request: CompileRequest = { testFilePath };

  if (body.steps !== undefined) {
    if (!Array.isArray(body.steps) || !body.steps.every((s) => typeof s === 'string')) {
      return '"steps" must be an array of strings';
    }
    request.steps = body.steps as string[];
  }

  if (body.sections !== undefined && body.sections !== null) {
    if (typeof body.sections !== 'object' || Array.isArray(body.sections)) {
      return '"sections" must be an object keyed by section name';
    }
    const sections = Object.create(null) as NonNullable<CompileRequest['sections']>;
    for (const [key, value] of Object.entries(body.sections as Record<string, unknown>)) {
      const invalid = validateSectionEntry(key, value);
      if (invalid) return invalid;
      const entry = value as { name: string; headingLine: number; steps: string[]; stepLines: number[] };
      sections[key] = {
        name: entry.name,
        headingLine: entry.headingLine,
        steps: entry.steps,
        stepLines: entry.stepLines,
      };
    }
    if (Object.keys(sections).length > 0) request.sections = sections;
  }

  if (body.envName !== undefined) {
    if (typeof body.envName !== 'string') return '"envName" must be a string';
    request.envName = body.envName;
  }

  if (body.sessionId !== undefined) {
    if (typeof body.sessionId !== 'string' || body.sessionId === '') {
      return '"sessionId" must be a non-empty string';
    }
    request.sessionId = body.sessionId;
  }

  if (body.select !== undefined && body.select !== null) {
    if (typeof body.select !== 'object' || Array.isArray(body.select)) {
      return '"select" must be an object';
    }
    const raw2 = body.select as Record<string, unknown>;
    const select: NonNullable<CompileRequest['select']> = {};
    if (raw2.onlyStale !== undefined) {
      if (typeof raw2.onlyStale !== 'boolean') return '"select.onlyStale" must be a boolean';
      select.onlyStale = raw2.onlyStale;
    }
    if (raw2.all !== undefined) {
      if (typeof raw2.all !== 'boolean') return '"select.all" must be a boolean';
      select.all = raw2.all;
    }
    if (raw2.steps !== undefined) {
      if (
        !Array.isArray(raw2.steps) ||
        !raw2.steps.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 1)
      ) {
        return '"select.steps" must be an array of 1-based step numbers';
      }
      select.steps = raw2.steps as number[];
    }
    if (select.onlyStale && select.all) {
      return '"select.onlyStale" and "select.all" select opposite things; pick one';
    }
    request.select = select;
  }

  if (body.maxRounds !== undefined) {
    if (typeof body.maxRounds !== 'number' || !Number.isInteger(body.maxRounds) || body.maxRounds < 1) {
      return '"maxRounds" must be a positive integer';
    }
    request.maxRounds = body.maxRounds;
  }

  if (body.dryRun !== undefined) {
    if (typeof body.dryRun !== 'boolean') return '"dryRun" must be a boolean';
    request.dryRun = body.dryRun;
  }

  return request;
}

function parseErrandRequest(raw: unknown): ErrandRequest | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'Request body must be an object';
  }
  const body = raw as Record<string, unknown>;

  if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
    return 'Request body must include a "steps" array with at least one step';
  }
  if (!body.steps.every((s: unknown) => typeof s === 'string')) {
    return 'All steps must be strings';
  }

  const port = body.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return `"port" must be a valid TCP port (got ${JSON.stringify(port)})`;
  }

  // Exact, and only exact. The tab was matched MCP-side against the same
  // filtered listing `list_cdp_browsers` shows, so the server is handed the
  // winner rather than a name to arbitrate.
  const targetId = body.targetId;
  if (typeof targetId !== 'string' || targetId === '') {
    return '"targetId" is required and must be a non-empty string';
  }

  // The synthetic `<root>/.aiui-errand.md`. Required: it is the only thing a
  // project root is resolved from, and without it the project layer of
  // `effectiveSettings` falls back to server defaults with nothing saying so.
  const testFilePath = body.testFilePath;
  if (typeof testFilePath !== 'string' || testFilePath === '') {
    return '"testFilePath" is required — the errand\'s project root is resolved from it';
  }

  // Echoed into the receipt rather than re-derived: every result says which
  // root it used (stories/mcp-no-project.md §Locked).
  const root = body.root;
  if (typeof root !== 'string' || root === '') {
    return '"root" is required — the receipt must say which root the errand used';
  }
  if (!path.isAbsolute(root)) {
    return `"root" must be an absolute path (got "${root}")`;
  }
  const scope = body.scope;
  if (scope !== 'project' && scope !== 'user') {
    return '"scope" must be "project" or "user"';
  }

  const request: ErrandRequest = {
    port,
    targetId,
    steps: body.steps as string[],
    testFilePath,
    root,
    scope,
  };

  if (body.keepOpen !== undefined) {
    if (typeof body.keepOpen !== 'boolean') {
      return '"keepOpen" must be a boolean';
    }
    request.keepOpen = body.keepOpen;
  }
  if (body.envName !== undefined) {
    if (typeof body.envName !== 'string') {
      return '"envName" must be a string';
    }
    request.envName = body.envName;
  }
  if (body.env !== undefined) {
    if (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env)) {
      return '"env" must be an object';
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    request.env = env;
  }

  return request;
}

/**
 * Validate one entry of the `sections` map, returning an error message or
 * null. Contract §3.2's table, one condition per row.
 *
 * Deliberately strict about the `steps`/`stepLines` arity: they are parallel
 * arrays, and a skew means the server would attribute a body step to the
 * wrong source line — a wrong gutter, a wrong breakpoint, a wrong re-run
 * anchor. Cheaper to refuse the request than to debug that later.
 */
function validateSectionEntry(key: string, raw: unknown): string | null {
  const where = `sections["${key}"]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${where} must be an object`;
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.name !== 'string') return `${where}.name must be a string`;
  if (typeof entry.headingLine !== 'number' || !Number.isFinite(entry.headingLine)) {
    return `${where}.headingLine must be a number`;
  }
  if (!Array.isArray(entry.steps) || !entry.steps.every((s) => typeof s === 'string')) {
    return `${where}.steps must be an array of strings`;
  }
  // A looped section's rows (stories/data-driven-rows.md, part B). Refused
  // rather than ignored: a malformed `rows` would silently run the body once
  // instead of N times, which is the failure the whole feature is about.
  if (entry.rows !== undefined) {
    if (!Array.isArray(entry.rows) || entry.rows.length === 0) {
      return `${where}.rows must be a non-empty array when present`;
    }
    for (const row of entry.rows) {
      if (
        typeof row !== 'object' ||
        row === null ||
        Array.isArray(row) ||
        !Object.values(row as Record<string, unknown>).every((v) => typeof v === 'string')
      ) {
        return `${where}.rows entries must be objects of string values`;
      }
    }
  }
  if (
    !Array.isArray(entry.stepLines) ||
    !entry.stepLines.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return `${where}.stepLines must be an array of numbers`;
  }
  if (entry.steps.length !== entry.stepLines.length) {
    return (
      `${where}.steps and ${where}.stepLines must be the same length ` +
      `(got ${entry.steps.length} and ${entry.stepLines.length}) — they are parallel arrays`
    );
  }
  // The map is keyed by `matchText(name)` and the server uses the incoming
  // keys VERBATIM (contract §3.2 forbids re-deriving them for use). Nothing
  // stops a client sending a key that isn't the normalized name, and the
  // result is a section that can never be called: every lookup derives its
  // key from the step text, so it misses, and the bare name ships to the AI.
  //
  // §3.2 forbids re-deriving the key for use. It does not forbid VALIDATING
  // it, and this is the one invariant that makes the whole map addressable.
  const expected = matchText(entry.name);
  if (key !== expected) {
    return (
      `${where} is keyed "${key}" but its name normalizes to "${expected}". ` +
      `Section maps are keyed by matchText(name); a mismatched key can never be called.`
    );
  }
  // An empty name is refused at parse time by all three implementations
  // (contract §2.5) and never enters an index, so it cannot arrive here from
  // a well-behaved client — and if it did, it would be uncallable.
  if (expected === '') return `${where} has an empty name`;
  return null;
}
