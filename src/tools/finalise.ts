import { logger } from '../utils/logger.js';
import type { ToolContext, ToolDefinition, ToolScope } from './types.js';
import { isDeferredTool, type DeferredTool } from './tool-helper.js';

/**
 * Pure transform: given an export from a tool file plus contextual hints,
 * return a fully-formed `ToolDefinition` ready for the registry to register.
 *
 * Returns `null` only for a non-function value that isn't a tool: a type, a
 * constant, an object that isn't a `ToolDefinition`. Any exported FUNCTION is
 * a rung-1 tool named after its export key (or the filename for a default
 * export), tagged with `tool()` or not — so a helper that should stay private
 * must not be exported from a tool file.
 *
 * Throws on unrecoverable problems (filename name validation failure, etc.).
 */
export interface FinaliseHints {
  /** The basename of the file (no extension) — used as the fallback name. */
  filename: string;
  /** The export key, when this candidate came from a named export. */
  exportKey?: string;
  /** Absolute file path, for error messages. */
  filePath: string;
}

const NAME_RE = /^[\w-]+$/;
const RESERVED_SCOPE_KEYS = new Set([
  'page',
  'context',
  'browser',
  'step',
  'log',
  'args',
]);

export function finaliseToolExport(
  candidate: unknown,
  hints: FinaliseHints,
): ToolDefinition | null {
  // Rung 3 — already a fully-formed ToolDefinition.
  if (isToolDefinition(candidate)) {
    if (
      hints.exportKey &&
      candidate.name &&
      candidate.name !== hints.exportKey
    ) {
      logger.warn(
        `Tool name "${candidate.name}" in ${hints.filePath} disagrees with its export key "${hints.exportKey}" — using "${candidate.name}"`,
      );
    }
    if (
      !hints.exportKey &&
      candidate.name &&
      candidate.name !== hints.filename
    ) {
      logger.warn(
        `Tool name "${candidate.name}" in ${hints.filePath} disagrees with the filename "${hints.filename}" — using "${candidate.name}"`,
      );
    }
    return candidate;
  }

  // Rung 2 — DeferredTool from `tool(...)`.
  if (isDeferredTool(candidate)) {
    const name = resolveName(candidate.explicitName, hints);
    return wrapBareFn(name, candidate.fn, hints.filePath);
  }

  // Rung 1 — bare function default export (or named export that's a function).
  if (typeof candidate === 'function') {
    const name = resolveName(undefined, hints);
    return wrapBareFn(name, candidate as DeferredTool['fn'], hints.filePath);
  }

  return null;
}

function resolveName(
  explicit: string | undefined,
  hints: FinaliseHints,
): string {
  if (explicit) {
    if (!NAME_RE.test(explicit)) {
      throw new Error(
        `Invalid tool name "${explicit}" in ${hints.filePath} — must match ${NAME_RE}`,
      );
    }
    return explicit;
  }
  if (hints.exportKey) {
    if (!NAME_RE.test(hints.exportKey)) {
      throw new Error(
        `Tool exported as "${hints.exportKey}" in ${hints.filePath} — name must match ${NAME_RE}`,
      );
    }
    return hints.exportKey;
  }
  if (!NAME_RE.test(hints.filename)) {
    throw new Error(
      `Tool filename "${hints.filename}" in ${hints.filePath} — must match ${NAME_RE} (rename the file or declare an explicit name)`,
    );
  }
  return hints.filename;
}

function wrapBareFn(
  name: string,
  fn: DeferredTool['fn'],
  filePath: string,
): ToolDefinition {
  return {
    name,
    parameters: {},
    // Single declared output named after the tool — used when the function
    // returns a value. (No write happens when it returns undefined.)
    outputs: { [name]: { type: 'string' } },
    // Rung 1/2 are loose with caller args: any name is accepted and no
    // type coercion happens. Schema-driven validation is opt-in via
    // `defineTool`.
    acceptsExtraArgs: true,
    async run(args, ctx) {
      const scope = buildScope(args, ctx, name, filePath);
      const result = await Promise.resolve(fn(scope));
      if (result === undefined || result === null) return;
      ctx.step.setVar(name, stringifyResult(result));
    },
  };
}

function buildScope(
  args: Record<string, unknown>,
  ctx: ToolContext,
  toolName: string,
  filePath: string,
): ToolScope {
  // Caller args spread to the top level. Reserved names (page/context/...)
  // are then assigned over the top so framework values always win.
  const scope: Record<string, unknown> = { ...args };
  for (const reserved of RESERVED_SCOPE_KEYS) {
    if (reserved in args) {
      logger.warn(
        `Tool "${toolName}" in ${filePath} was called with reserved arg "${reserved}" — shadowed by the framework value`,
      );
    }
  }
  scope['args'] = args;
  scope['page'] = ctx.page;
  scope['context'] = ctx.context;
  scope['browser'] = ctx.browser;
  scope['step'] = ctx.step;
  scope['log'] = ctx.log;
  return scope as ToolScope;
}

function stringifyResult(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  // object / array / etc.
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function isToolDefinition(v: unknown): v is ToolDefinition {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { name?: unknown }).name === 'string' &&
    typeof (v as { run?: unknown }).run === 'function' &&
    typeof (v as { parameters?: unknown }).parameters === 'object' &&
    typeof (v as { outputs?: unknown }).outputs === 'object'
  );
}
