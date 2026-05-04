/**
 * Tokenizer for `[skill: name ...]` invocations. Thin wrapper over the shared
 * `parseInvocation` core (see `src/parser/invocation-parser.ts`) — keeps the
 * historical `SkillCallSyntaxError` name and the skill-call-specific entry
 * point, while sharing every line of grammar logic with the tool-call parser.
 */

import {
  parseInvocation,
  InvocationSyntaxError,
  type ParsedInvocation,
} from '../parser/invocation-parser.js';

export type ParsedSkillCall = ParsedInvocation;

export class SkillCallSyntaxError extends InvocationSyntaxError {
  constructor(reason: string, source: string, column: number) {
    super(reason, source, column, 'SkillCallSyntaxError');
  }
}

export function parseSkillCall(line: string): ParsedSkillCall | null {
  return parseInvocation(line, {
    prefix: '[skill:',
    errorClass: SkillCallSyntaxError,
  });
}
