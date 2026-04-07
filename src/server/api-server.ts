import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../config/types.js';
import { SessionManager, type StepRequest } from './session-manager.js';
import { logger } from '../utils/logger.js';

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
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  app.post('/sessions/:id/steps', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = String(req.params.id);

      // Validate session ID length
      if (sessionId.length > 128) {
        res.status(400).json({ error: 'Session ID must be 128 characters or fewer' });
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
        request.config = body.config as { baseUrl?: string; timeout?: string };
      }
      if (body.parameters !== undefined) {
        request.parameters = body.parameters as Record<string, string>;
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
