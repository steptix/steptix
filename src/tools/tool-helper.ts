import type { ToolScope } from './types.js';

/**
 * Marker shape returned by `tool(...)`. The registry detects this via
 * `IS_DEFERRED_TOOL` and finalises it into a full `ToolDefinition` once
 * the name is known (from explicit arg, export key, or filename).
 *
 * MUST stay a cross-realm `Symbol.for` (global symbol registry), never a
 * module-local `Symbol()`: the server's tool hot-reload (issue 033) esbuild-
 * bundles tool files, and a tool that imports the framework by absolute path
 * gets a *second copy* of this module inlined. A module-local symbol would
 * differ between the two copies, so `isDeferredTool` would fail to recognise a
 * `tool(...)` result coming from the bundle. `Symbol.for` is shared across both.
 */
export const IS_DEFERRED_TOOL = Symbol.for('ai-ui-automation/deferred-tool');

export interface DeferredTool<R = unknown> {
  readonly [IS_DEFERRED_TOOL]: true;
  readonly explicitName?: string;
  readonly fn: (scope: ToolScope) => R | Promise<R>;
}

export function isDeferredTool(v: unknown): v is DeferredTool {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<symbol, unknown>)[IS_DEFERRED_TOOL] === true
  );
}

/**
 * Author entry point for low-ceremony tools. Returns a deferred spec the
 * registry finalises at load time. Two overloads:
 *
 * ```ts
 * // Name inferred from filename (default export) or export key (named).
 * export default tool(({ baseUrl, context }) => fetch(...));
 *
 * // Name explicit.
 * export default tool('check_health', ({ baseUrl, context }) => fetch(...));
 * ```
 *
 * The single argument is the {@link ToolScope}: framework values (`page`,
 * `context`, `browser`, `step`, `log`, `args`) plus caller-supplied args
 * spread to the top level for direct destructuring.
 *
 * Returning a value sets the tool's single output (named after the tool).
 * Returning `undefined` registers no output — the tool ran for side effects.
 *
 * For multiple outputs, parameter type schemas, descriptions, etc., use
 * `defineTool({...})` instead.
 */
export function tool<A extends Record<string, unknown> = Record<string, string>, R = unknown>(
  fn: (scope: ToolScope & A) => R | Promise<R>,
): DeferredTool<R>;
export function tool<A extends Record<string, unknown> = Record<string, string>, R = unknown>(
  name: string,
  fn: (scope: ToolScope & A) => R | Promise<R>,
): DeferredTool<R>;
export function tool<A extends Record<string, unknown> = Record<string, string>, R = unknown>(
  arg1: string | ((scope: ToolScope & A) => R | Promise<R>),
  arg2?: (scope: ToolScope & A) => R | Promise<R>,
): DeferredTool<R> {
  let explicitName: string | undefined;
  let fn: (scope: ToolScope & A) => R | Promise<R>;
  if (typeof arg1 === 'string') {
    if (typeof arg2 !== 'function') {
      throw new Error('tool(name, fn): second argument must be a function');
    }
    explicitName = arg1;
    fn = arg2;
  } else {
    if (typeof arg1 !== 'function') {
      throw new Error('tool(fn): argument must be a function');
    }
    fn = arg1;
  }
  const deferred = Object.freeze({
    [IS_DEFERRED_TOOL]: true as const,
    ...(explicitName !== undefined && { explicitName }),
    fn: fn as DeferredTool<R>['fn'],
  });
  return deferred as DeferredTool<R>;
}
