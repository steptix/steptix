import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { addLogCallback, addTraceCallback, logger } from './logger.js';
import { redact, redactDeep } from './secrets.js';

export interface RunLog {
  stream: WriteStream;
  path: string;
  dispose: () => void;
}

export type RunLogFileMode = 'off' | 'compact' | 'full';

/**
 * Open a per-run log file under `<reportsDir>/logs/`. Filename is
 * `<sanitized-id>-<UTC-timestamp>.log`. Returns a stream + path; caller is
 * responsible for closing it via the returned `dispose()`.
 *
 * Failures (mkdir / open) are swallowed and logged — a missing log file must
 * never break a run.
 */
export function openRunLogFile(id: string, reportsDir: string): RunLog | null {
  try {
    const logsDir = pathResolve(reportsDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = pathJoin(logsDir, `${safeId}-${stamp}.log`);
    const stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    return {
      stream,
      path: filePath,
      dispose: () => { stream.end(); },
    };
  } catch (err) {
    logger.warn(`Could not open run log file for "${id}": ${String(err)}`);
    return null;
  }
}

/**
 * Wire a {@link RunLog} to the global logger. Returns a disposer that detaches
 * both bridges. Always attaches the regular log bridge; only attaches the
 * trace bridge when `fileMode === 'full'` so 'compact' files skip the giant
 * AI request/response payload blocks.
 *
 * The file always captures every level regardless of the console threshold,
 * so a quiet console still produces a complete forensic trail.
 *
 * `secrets` is the run's must-never-print list (stories/secret-redaction.md),
 * read at each write because it grows as the run captures values. Log lines
 * are masked as text; a trace payload is masked as an object *before* it is
 * serialized, so a secret that JSON would escape (a `"` or `\` in it) is
 * still found.
 */
export function attachRunLogBridges(
  runLog: RunLog,
  fileMode: RunLogFileMode,
  secrets: () => string[] = () => [],
): () => void {
  const removeLog = addLogCallback((level, message) => {
    const ts = new Date().toISOString();
    runLog.stream.write(`[${ts}] [${level.toUpperCase().padEnd(5)}] ${redact(message, secrets())}\n`);
  });
  const removeTrace = fileMode === 'full'
    ? addTraceCallback((label, payload) => {
        const ts = new Date().toISOString();
        let body: string;
        try {
          body = JSON.stringify(redactDeep(payload, secrets()), null, 2);
        } catch (err) {
          body = `<unserializable: ${String(err)}>`;
        }
        runLog.stream.write(
          `\n=== [${ts}] TRACE ${label} ===\n${body}\n=== END ${label} ===\n\n`,
        );
      })
    : () => {};
  return () => { removeLog(); removeTrace(); };
}
