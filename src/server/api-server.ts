import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { url as inspectorUrl } from 'node:inspector';
import path from 'node:path';
import type { CaptureMode, Config, RunSettings } from '../config/types.js';
import { CAPTURE_MODES, RUN_SETTING_KEYS } from '../config/run-settings.js';
import {
  knownProfiles,
  startCdpBrowser,
  closeCdpTab,
  UNKNOWN_HOLDER,
  DEFAULT_PROFILE,
  type CdpFailureKind,
  type StartResult,
} from '../browser/cdp-registry.js';
import { discoverCdpPorts } from '../browser/cdp-discovery.js';
import { SessionManager, type RunEvent, type StepRequest } from './session-manager.js';
import { PageCaptureError } from '../browser/dom-cleaner.js';
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

/** Write a single SSE frame. */
function writeSseEvent(res: Response, event: RunEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
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
  /** Close the app to new work (§2). Idempotent. */
  beginShutdown: () => void;
} {
  const app = express();
  const sessionManager = new SessionManager(config);
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
            const entry = raw as { name: string; headingLine: number; steps: string[]; stepLines: number[] };
            sections[key] = {
              name: entry.name,
              headingLine: entry.headingLine,
              steps: entry.steps,
              stepLines: entry.stepLines,
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

      if (streaming) {
        // Open SSE stream. Headers must be set before any res.write().
        // Note: don't set Connection: keep-alive explicitly — Node's HTTP
        // keep-alive socket pool can hold the connection open after res.end()
        // and keep server.close() blocked. The default is keep-alive anyway,
        // and SSE consumers don't require it.
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if any
        res.flushHeaders();

        // Use res.on('close') for client disconnect — req.on('close') fires
        // when express.json() finishes parsing the body, which would falsely
        // signal a disconnect immediately.
        //
        // The AbortController lets sessionManager.executeSteps see the
        // disconnect and stop processing further steps; without it the
        // server would burn through every queued step before noticing.
        const abortController = new AbortController();
        let clientGone = false;
        res.on('close', () => {
          clientGone = true;
          abortController.abort();
        });

        // Periodic comment frame so intermediaries don't time the connection
        // out (typical proxy idle window is 30s).
        const keepalive = setInterval(() => {
          if (clientGone) return;
          try {
            res.write(': keep-alive\n\n');
          } catch {
            // socket may be gone
          }
        }, 25_000);

        try {
          await sessionManager.executeSteps(
            sessionId,
            request,
            (event) => {
              if (clientGone) return;
              writeSseEvent(res, event);
            },
            abortController.signal,
          );
        } catch (err) {
          if (!clientGone) {
            const message = err instanceof Error ? err.message : String(err);
            writeSseEvent(res, { type: 'output', msg: `Server error: ${message}`, kind: 'error' });
            writeSseEvent(res, { type: 'done', status: 'error' });
          }
        } finally {
          clearInterval(keepalive);
          if (!clientGone) {
            res.end();
          }
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
      const rawFormat = req.query['format'];
      const format = rawFormat === undefined ? 'text' : String(rawFormat);
      if (format !== 'text' && format !== 'dom') {
        // Deliberately not a fallback to 'text'. A caller that asked for
        // 'html' and silently received prose has no way to notice.
        res.status(400).json({
          error: `Unknown format "${format}". Valid formats are "text" (visible text, default) and "dom" (cleaned DOM).`,
        });
        return;
      }

      // Rejected rather than ignored. A repeated `?selector=a&selector=b`
      // arrives as an array, and silently dropping it would widen the read
      // from one element to the entire page — the opposite of what the caller
      // asked for, on the endpoint whose whole size story is "narrow with a
      // selector". `format` and `max_chars` already 400 on the same input.
      const rawSelector = req.query['selector'];
      if (rawSelector !== undefined && typeof rawSelector !== 'string') {
        res.status(400).json({ error: 'selector must be a single string value.' });
        return;
      }
      // An empty `?selector=` is the same trap in a smaller shape: dropping it
      // silently reads the whole page when the caller asked for one element.
      if (rawSelector === '') {
        res.status(400).json({ error: 'selector must not be empty.' });
        return;
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
          return;
        }
      }

      const content = await sessionManager.getPageContent(sessionId, {
        format,
        selector,
        maxChars,
      });
      if (!content) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.status(200).json(content);
    } catch (err) {
      // A read that lost to a navigation is the caller's to retry — it says
      // nothing about the session's health, so it must not read as a 500.
      if (err instanceof PageCaptureError && err.kind === 'navigated') {
        res.status(409).json({ error: err.message });
        return;
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
        return;
      }
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

      const profiles = await knownProfiles(projectRoot);
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
        .map((p) => ({ engine: p.engine, profile: p.profile, profileDir: p.profileDir }));

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

      // Single-flight. The key is built from the validated values so two
      // spellings of the same request share a slot.
      const key = `${projectRoot} ${engine} ${profile}`;
      let pending = cdpLaunchesInFlight.get(key);
      if (!pending) {
        pending = startCdpBrowser({ projectRoot, engine, profile, reset }).finally(() => {
          cdpLaunchesInFlight.delete(key);
        });
        cdpLaunchesInFlight.set(key, pending);
      }
      const result = await pending;

      if (!result.ok) {
        res.status(statusForCdpFailure(result.kind)).json({ error: result.error });
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
      });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /cdp/browsers/:port/tabs/:targetId (stories/cdp-tabs.md §2)
  //
  // The one destructive verb over a live browser. Every guard lives in
  // `closeCdpTab`; this route validates its inputs, supplies the session join
  // the registry cannot see, and maps failures onto status codes.
  app.delete(
    '/cdp/browsers/:port/tabs/:targetId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectRoot =
          typeof req.query['projectRoot'] === 'string' ? req.query['projectRoot'] : '';
        if (!projectRoot) {
          res.status(400).json({ error: 'projectRoot query parameter is required' });
          return;
        }
        if (!path.isAbsolute(projectRoot)) {
          res
            .status(400)
            .json({ error: `projectRoot must be an absolute path (got "${projectRoot}")` });
          return;
        }

        const port = Number(req.params.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          res.status(400).json({ error: `port must be a valid TCP port (got "${req.params.port}")` });
          return;
        }

        const targetId = String(req.params.targetId ?? '');
        if (targetId === '') {
          res.status(400).json({ error: 'targetId is required' });
          return;
        }

        const allowBrowserExit =
          req.query['allowBrowserExit'] === 'true' || req.query['allowBrowserExit'] === '1';
        // Whether a browser this project did NOT launch may be closed. Same
        // shape and same reasoning as `includeForeignTabs` on the listing: the
        // server cannot tell an agent from a human, so it honours what it is
        // asked, and the withholding lives MCP-side where `mcp.cdp.allowUnowned`
        // is read. Without this the MCP gate would pass a foreign port that the
        // registry then refuses anyway — an opt-in that says it grants
        // something it cannot.
        const allowUnowned =
          req.query['allowUnowned'] === 'true' || req.query['allowUnowned'] === '1';

        const result = await queueCdpClose(port, () =>
          closeCdpTab({
            projectRoot,
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
          }),
        );

        if (!result.ok) {
          res.status(statusForCdpFailure(result.kind)).json({ error: result.error });
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
          warnings: result.warnings,
        });
      } catch (err) {
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
