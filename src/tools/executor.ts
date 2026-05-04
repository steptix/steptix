import type { Page, BrowserContext, Browser } from 'playwright';
import { interpolate } from '../parser/parameters.js';
import { logger } from '../utils/logger.js';
import type { ToolCatalogue } from './registry.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolLog,
  ToolStepApi,
  ToolStepOutcome,
} from './types.js';

export interface ExecuteToolStepOptions {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  resolvedParameters: Record<string, string>;
  catalogue: ToolCatalogue;
}

/**
 * Resolve and run a single tool call. The tool's `run` function gets the
 * live Playwright `page` / `context` / `browser` (same instances the AI
 * loop uses), and a `step` API that reads/writes `resolvedParameters`.
 *
 * Returns a `ToolStepOutcome` that callers can fold into a `StepResult`
 * for reporting. Errors in the tool are caught and recorded; the function
 * does not throw.
 */
export async function executeToolStep(
  call: ToolCall,
  options: ExecuteToolStepOptions,
): Promise<ToolStepOutcome> {
  const start = Date.now();
  const logs: ToolStepOutcome['logs'] = [];
  const captured: Record<string, string> = {};

  let registered;
  try {
    registered = options.catalogue.require(call.name);
  } catch (err) {
    return {
      toolName: call.name,
      args: {},
      outputs: {},
      durationMs: Date.now() - start,
      logs,
      status: 'failed',
      error: (err as Error).message,
    };
  }
  const def = registered.definition;

  let typedArgs: Record<string, unknown>;
  try {
    typedArgs = resolveAndCoerceArgs(def, call, options.resolvedParameters);
  } catch (err) {
    return {
      toolName: call.name,
      args: {},
      outputs: {},
      durationMs: Date.now() - start,
      logs,
      status: 'failed',
      error: (err as Error).message,
    };
  }

  try {
    validateOutputAliases(def, call);
  } catch (err) {
    return {
      toolName: call.name,
      args: typedArgs,
      outputs: {},
      durationMs: Date.now() - start,
      logs,
      status: 'failed',
      error: (err as Error).message,
    };
  }

  const declaredOutputs = new Set(Object.keys(def.outputs));
  const log: ToolLog = {
    info: (...args) => {
      const msg = formatLog(args);
      logs.push({ level: 'info', message: msg });
      logger.info(`[tool:${call.name}] ${msg}`);
    },
    warn: (...args) => {
      const msg = formatLog(args);
      logs.push({ level: 'warn', message: msg });
      logger.warn(`[tool:${call.name}] ${msg}`);
    },
    error: (...args) => {
      const msg = formatLog(args);
      logs.push({ level: 'error', message: msg });
      logger.error(`[tool:${call.name}] ${msg}`);
    },
  };

  const stepApi: ToolStepApi<typeof def.outputs> = {
    getVar(name) {
      return options.resolvedParameters[name];
    },
    setVar(name, value) {
      if (!declaredOutputs.has(name)) {
        throw new Error(
          `Tool "${call.name}" tried to set undeclared output "${name}". Declared: [${[...declaredOutputs].join(', ') || 'none'}]`,
        );
      }
      const stringValue = typeof value === 'string' ? value : String(value);
      // Apply caller's output alias if any.
      const aliased = call.outputAliases[name] ?? name;
      options.resolvedParameters[aliased] = stringValue;
      captured[aliased] = stringValue;
    },
    expect(condition, message) {
      if (!condition) {
        throw new Error(message ?? `Tool "${call.name}" expectation failed`);
      }
    },
  };

  const ctx: ToolContext = {
    page: options.page,
    context: options.context,
    browser: options.browser,
    step: stepApi,
    log,
  };

  try {
    await Promise.resolve(def.run(typedArgs as never, ctx));
    return {
      toolName: call.name,
      args: typedArgs,
      outputs: captured,
      durationMs: Date.now() - start,
      logs,
      status: 'passed',
    };
  } catch (err) {
    return {
      toolName: call.name,
      args: typedArgs,
      outputs: captured,
      durationMs: Date.now() - start,
      logs,
      status: 'failed',
      error: (err as Error).message,
    };
  }
}

/**
 * Interpolate `{{placeholders}}` in the call args against the test's
 * variable scope, then coerce each value to the declared type.
 *
 * When `def.acceptsExtraArgs` is true (rung 1/2 tools), unknown arg names
 * are accepted and pass through as interpolated strings — no schema, no
 * coercion. Required-parameter checks and declared-arg coercion still
 * apply for any args the schema does declare.
 */
function resolveAndCoerceArgs(
  def: ToolDefinition,
  call: ToolCall,
  resolvedParameters: Record<string, string>,
): Record<string, unknown> {
  const declared = def.parameters;
  const open = def.acceptsExtraArgs === true;
  const out: Record<string, unknown> = {};

  // Required-parameter check.
  for (const [paramName, schema] of Object.entries(declared)) {
    if (paramName in call.args) continue;
    if (schema.default !== undefined) {
      out[paramName] = schema.default;
      continue;
    }
    throw new Error(
      `Tool "${def.name}" requires parameter "${paramName}" but caller did not supply it`,
    );
  }

  // Coerce each supplied arg.
  for (const [argName, rawValue] of Object.entries(call.args)) {
    const schema = declared[argName];
    const interpolated = interpolate(rawValue, resolvedParameters);
    if (!schema) {
      if (!open) {
        throw new Error(
          `Tool "${def.name}" received unknown parameter "${argName}" — declared: [${Object.keys(declared).join(', ') || 'none'}]`,
        );
      }
      // Open mode: pass through verbatim as a string.
      out[argName] = interpolated;
      continue;
    }
    out[argName] = coerce(def.name, argName, schema.type, interpolated);
  }

  return out;
}

function coerce(
  toolName: string,
  argName: string,
  type: 'string' | 'number' | 'boolean',
  raw: string,
): string | number | boolean {
  if (type === 'string') return raw;
  if (type === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) {
      throw new Error(
        `Tool "${toolName}" parameter "${argName}" expected a number, got "${raw}"`,
      );
    }
    return n;
  }
  // boolean
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw new Error(
    `Tool "${toolName}" parameter "${argName}" expected a boolean ("true"/"false"), got "${raw}"`,
  );
}

function validateOutputAliases(def: ToolDefinition, call: ToolCall): void {
  for (const declared of Object.keys(call.outputAliases)) {
    if (!(declared in def.outputs)) {
      throw new Error(
        `Tool "${def.name}" has no declared output "${declared}" — declared: [${Object.keys(def.outputs).join(', ') || 'none'}]`,
      );
    }
  }
}

function formatLog(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}
