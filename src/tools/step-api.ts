import { logger } from '../utils/logger.js';
import type { ToolLog } from './types.js';

/**
 * The bits of a tool step's runtime surface that are not specific to tools.
 *
 * Step code-behind runs author-supplied TypeScript against the same live
 * page/context/browser as `[tool: ...]` does, and records the same log lines
 * into the report, so these live here rather than being written twice
 * (stories/step-codebehind.md — "the tool executor internals reused, not
 * duplicated").
 */

/** One captured log line, as the report renders it. */
export interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Render a `log.info(...)` argument list into one report line. */
export function formatLog(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}

/**
 * A `ToolLog` that appends to `sink` (for the report) and mirrors to the
 * run logger under `[<label>]`.
 */
export function createCapturingLog(label: string, sink: CapturedLog[]): ToolLog {
  const push = (level: CapturedLog['level'], args: unknown[]): string => {
    const message = formatLog(args);
    sink.push({ level, message });
    return `[${label}] ${message}`;
  };
  return {
    info: (...args) => logger.info(push('info', args)),
    warn: (...args) => logger.warn(push('warn', args)),
    error: (...args) => logger.error(push('error', args)),
  };
}
