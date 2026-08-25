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
  const parsed = parseInvocation(line, {
    prefix: '[skill:',
    errorClass: SkillCallSyntaxError,
    // Skills may live in subfolders of `skillsDir`, referenced path-qualified:
    // `[skill: auth/login]` resolves `<skillsDir>/auth/login.md`. A leading
    // slash is accepted sugar for the same thing (`[skill: /auth/login]`).
    allowSlashInName: true,
  });
  if (!parsed || !parsed.name.includes('/')) return parsed;

  // Canonicalise before anything downstream sees the name: the expander's
  // cycle keys, frame `skillName`s and report badges must agree that
  // `/auth/login` and `auth/login` are one skill, so exactly one form
  // survives parsing. Note the grammar admits no `.` or `\` in the name, so
  // a path-qualified reference can never traverse out of `skillsDir`.
  const canonical = parsed.name.replace(/^\//, '');
  if (canonical === '' || canonical.split('/').some((s) => s.length === 0)) {
    const prefixIdx = line.indexOf('[skill:');
    const nameCol = line.indexOf(parsed.name, prefixIdx);
    throw new SkillCallSyntaxError(
      `invalid skill name "${parsed.name}": empty path segment (no trailing or doubled '/')`,
      line,
      nameCol,
    );
  }
  return { ...parsed, name: canonical };
}
