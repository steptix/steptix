import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../config/types.js';
import { SessionManager, type RunEvent, type StepRequest } from './session-manager.js';
import { matchText } from '../parser/section-match.js';
import { logger } from '../utils/logger.js';

/** Write a single SSE frame. */
function writeSseEvent(res: Response, event: RunEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApiServer(config: Config): {
  app: express.Express;
  sessionManager: SessionManager;
} {
  const app = express();
  const sessionManager = new SessionManager(config);

  // JSON body parsing
  app.use(express.json());

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

  // Auth middleware — check x-api-key header
  app.use((req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== config.server.apiKey) {
      res.status(401).json({ error: 'Unauthorized: missing or invalid x-api-key header' });
      return;
    }
    next();
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
          cdp?: { port: number; tab?: string };
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

  // Error handling middleware
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${message}`);
    res.status(500).json({ error: message });
  });

  return { app, sessionManager };
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export async function startServer(config: Config): Promise<void> {
  const { app, sessionManager } = createApiServer(config);
  const { host, port } = config.server;

  const server = app.listen(port, host, () => {
    logger.info(`Sessions API server listening on http://${host}:${port}`);
    logger.info('Server ready — press Ctrl+C to stop');
  });

  const shutdown = async () => {
    logger.info('Shutting down — closing all sessions...');
    await sessionManager.closeAll();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
