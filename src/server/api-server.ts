import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../config/types.js';
import { SessionManager, type RunEvent, type StepRequest } from './session-manager.js';
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
        request.sourceLines = body.sourceLines as number[];
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
