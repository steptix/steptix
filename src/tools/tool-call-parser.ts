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
 * Returns `null` if the line contains no `[tool:` token at all. Throws
 * `ToolCallSyntaxError` if the line contains the token but the bracketed
 * call is malformed. Any text before `[tool:` is captured as `label` —
 * see `parseInvocation` for the full grammar.
 */
export function parseToolCall(line: string): ToolCall | null {
  const parsed: ParsedInvocation | null = parseInvocation(line, {
    prefix: '[tool:',
    errorClass: ToolCallSyntaxError,
    // Tool references may be path-qualified (`auth/login/login`) to name the
    // file plus the tool inside it — see `parseToolRef` in the registry.
    allowSlashInName: true,
  });
  if (!parsed) return null;
  return {
    name: parsed.name,
    args: parsed.args,
    outputAliases: parsed.outputAliases,
    ...(parsed.label !== undefined && { label: parsed.label }),
  };
}
