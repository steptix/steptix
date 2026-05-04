/**
 * Tokenizer for `[tool: name ...]` invocations. Shares grammar logic with
 * the skill-call parser via `parseInvocation` — see
 * `src/parser/invocation-parser.ts` for the full grammar and shorthand rules.
 */

import {
  parseInvocation,
  InvocationSyntaxError,
  type ParsedInvocation,
} from '../parser/invocation-parser.js';
import type { ToolCall } from './types.js';

export class ToolCallSyntaxError extends InvocationSyntaxError {
  constructor(reason: string, source: string, column: number) {
    super(reason, source, column, 'ToolCallSyntaxError');
  }
}

/**
 * Try to parse `line` as a tool invocation.
 *
 * Returns `null` if the line is not a tool call (does not start with
 * `[tool:` after optional leading whitespace). Throws `ToolCallSyntaxError`
 * if the line opens as one but is malformed.
 */
export function parseToolCall(line: string): ToolCall | null {
  const parsed: ParsedInvocation | null = parseInvocation(line, {
    prefix: '[tool:',
    errorClass: ToolCallSyntaxError,
  });
  if (!parsed) return null;
  return {
    name: parsed.name,
    args: parsed.args,
    outputAliases: parsed.outputAliases,
  };
}
