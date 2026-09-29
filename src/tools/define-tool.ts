import type {
  ToolDefinition,
  ToolParameter,
  ToolOutput,
} from './types.js';

/**
 * Author entry point for declaring a tool. The returned object preserves the
 * generic types of `parameters` and `outputs` so the IDE narrows `args` and
 * the `step.setVar` name set inside `run`.
 *
 * Example:
 *
 * ```ts
 * import { defineTool } from 'steptix/tools';
 *
 * export default defineTool({
 *   name: 'fetch_otp',
 *   parameters: { email: { type: 'string' } },
 *   outputs:    { otp:   { type: 'string' } },
 *   async run({ email }, { step }) {
 *     // ...
 *     step.setVar('otp', '123456');
 *   },
 * });
 * ```
 */
export function defineTool<
  P extends Record<string, ToolParameter>,
  O extends Record<string, ToolOutput>,
>(def: ToolDefinition<P, O>): ToolDefinition<P, O> {
  validateDefinition(def);
  return def;
}

/** Best-effort sanity check at module load time — names and shape, not types. */
function validateDefinition<
  P extends Record<string, ToolParameter>,
  O extends Record<string, ToolOutput>,
>(def: ToolDefinition<P, O>): void {
  if (!def || typeof def !== 'object') {
    throw new Error('defineTool: argument must be an object');
  }
  if (!def.name || typeof def.name !== 'string') {
    throw new Error('defineTool: `name` is required and must be a string');
  }
  if (!/^[\w-]+$/.test(def.name)) {
    throw new Error(`defineTool: tool name "${def.name}" must match /^[\\w-]+$/`);
  }
  if (typeof def.run !== 'function') {
    throw new Error(`defineTool: tool "${def.name}" must define a \`run\` function`);
  }
  if (!def.parameters || typeof def.parameters !== 'object') {
    throw new Error(`defineTool: tool "${def.name}" must define a \`parameters\` object (use {} for none)`);
  }
  if (!def.outputs || typeof def.outputs !== 'object') {
    throw new Error(`defineTool: tool "${def.name}" must define an \`outputs\` object (use {} for none)`);
  }
  for (const [k, v] of Object.entries(def.parameters)) {
    if (!v || typeof v !== 'object' || !('type' in v)) {
      throw new Error(`defineTool: tool "${def.name}" parameter "${k}" must declare a \`type\``);
    }
  }
  for (const [k, v] of Object.entries(def.outputs)) {
    if (!v || typeof v !== 'object' || !('type' in v)) {
      throw new Error(`defineTool: tool "${def.name}" output "${k}" must declare a \`type\``);
    }
  }
}
