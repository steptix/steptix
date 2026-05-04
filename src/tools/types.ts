import type { Page, BrowserContext, Browser } from 'playwright';

/**
 * Scalar value types a tool parameter / output may carry. Arrays of these
 * (`string[]`, `number[]`, `boolean[]`) are also supported via
 * `${ToolScalar}[]` parameter / output type strings.
 */
export type ToolScalar = string | number | boolean;

/**
 * Schema descriptor for a tool input parameter.
 *
 * The `type` drives runtime validation of caller-supplied values and
 * is used by `defineTool` to type the `args` argument of `run`.
 *
 * Array variants (`'string[]'`, `'number[]'`, `'boolean[]'`) decode the
 * caller's JSON-encoded value (or whole-arg `{{var}}` reference whose
 * stored value is a JSON array) into a typed array at the bridge boundary.
 * Captures from `read multiple: true` produce values in this shape, so
 * `[tool: visit-each urls={{links}}]` is the natural pipeline.
 */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'boolean[]';
  description?: string;
  /** When set, the parameter is optional and this value is used if omitted. */
  default?: ToolScalar | ToolScalar[];
}

/**
 * Schema descriptor for a tool output. The framework records every output
 * a tool declares and only allows `step.setVar` writes to declared names.
 *
 * Array variants behave identically to scalar variants on the wire — the
 * stored value in the parameter map is the JSON-encoded array string —
 * but they document author intent and unlock array-typed `setVar` calls.
 */
export interface ToolOutput {
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'boolean[]';
  description?: string;
}

/** TS map: parameter `type` → the JS value type for that parameter. */
type ParamValue<T extends ToolParameter> =
  T['type'] extends 'string' ? string :
    T['type'] extends 'number' ? number :
      T['type'] extends 'boolean' ? boolean :
        T['type'] extends 'string[]' ? string[] :
          T['type'] extends 'number[]' ? number[] :
            T['type'] extends 'boolean[]' ? boolean[] :
              never;

/** TS map: parameters object → typed args object passed into `run`.  */
export type ParamsToArgs<P extends Record<string, ToolParameter>> = {
  [K in keyof P]: ParamValue<P[K]>;
};

/** The set of declared output names for a tool. */
export type OutputName<O extends Record<string, ToolOutput>> =
  keyof O & string;

/** Runtime context handed to a tool's `run` function. */
export interface ToolContext<O extends Record<string, ToolOutput> = Record<string, ToolOutput>> {
  /** The page the AI loop is currently driving. Same instance — actions persist. */
  page: Page;
  /** The current browser context (cookies, storage, .request, .pages()). */
  context: BrowserContext;
  /** The browser instance. */
  browser: Browser;
  /** Variable scope shared with the surrounding test. */
  step: ToolStepApi<O>;
  /** Lightweight log functions the framework records into the trace. */
  log: ToolLog;
}

export interface ToolStepApi<O extends Record<string, ToolOutput>> {
  /** Read a variable from the test's parameter scope. Returns `undefined` if unset. */
  getVar(name: string): string | undefined;
  /**
   * Write an output into the test's parameter scope. Name must be a declared
   * output. Array values (`string[]` / `number[]` / `boolean[]`) are
   * JSON-encoded into the parameter map so they round-trip through string
   * storage and decode cleanly when piped into another tool's array param.
   */
  setVar(name: OutputName<O>, value: ToolScalar | ToolScalar[]): void;
  /** Throw a labelled assertion error if `condition` is false. */
  expect(condition: boolean, message?: string): void;
}

export interface ToolLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Single-arg shape passed to a `tool(...)` body or bare-function tool.
 *
 * Caller-supplied args are *spread* onto the top level so an author can
 * destructure them directly (`({ baseUrl, page }) => ...`). The full args
 * bag is also reachable as `args` if you want to iterate. Reserved names
 * (`page`, `context`, `browser`, `step`, `log`, `args`) take precedence
 * — a caller arg with one of those names is shadowed by the framework
 * value and a startup warning is emitted.
 */
export interface ToolScope {
  page: import('playwright').Page;
  context: import('playwright').BrowserContext;
  browser: import('playwright').Browser;
  step: ToolStepApi<Record<string, ToolOutput>>;
  log: ToolLog;
  /** Full bag of caller-supplied args, in case you want to iterate. */
  args: Record<string, unknown>;
  /** Caller args spread to the top level for ergonomic destructuring. */
  [key: string]: unknown;
}

/**
 * The shape returned by `defineTool`. Schema generics are preserved so
 * the framework can perform parse-time and runtime validation against
 * the same types the author wrote.
 */
export interface ToolDefinition<
  P extends Record<string, ToolParameter> = Record<string, ToolParameter>,
  O extends Record<string, ToolOutput> = Record<string, ToolOutput>,
> {
  name: string;
  description?: string;
  parameters: P;
  outputs: O;
  /**
   * When true, the executor passes any caller-supplied arg through to `run`
   * without rejecting unknown names or coercing types. Used by `tool(...)`
   * and bare-function tools (rung 1/2) where no `parameters` schema is
   * declared. `defineTool({...})` (rung 3) leaves this false, preserving
   * strict argument validation.
   */
  acceptsExtraArgs?: boolean;
  run: (args: ParamsToArgs<P>, ctx: ToolContext<O>) => Promise<void> | void;
}

/**
 * A parsed tool invocation, before runtime resolution. `args` may contain
 * `{{placeholder}}` values that are interpolated against the test's
 * variable scope when the tool is executed.
 */
export interface ToolCall {
  name: string;
  args: Record<string, string>;
  outputAliases: Record<string, string>;
}

/**
 * Outcome of executing a single tool step. Captured into the report alongside
 * AI-driven step results.
 */
export interface ToolStepOutcome {
  toolName: string;
  args: Record<string, unknown>;
  outputs: Record<string, string>;
  durationMs: number;
  logs: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  status: 'passed' | 'failed';
  error?: string;
}
