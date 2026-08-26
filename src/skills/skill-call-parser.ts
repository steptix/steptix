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
    kind: 'skill',
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
  // survives parsing.
  //
  // The slash strip is also half of the containment property `loadSkill`
  // relies on. The grammar admits no `.` and no `\`, so no name can walk
  // upwards — but a name is fed to `path.resolve(skillsDir, ...)`, and
  // `path.resolve` treats a leading slash as ABSOLUTE: without this strip,
  // `/auth/login` would resolve to the drive root on Windows rather than into
  // `skillsDir`. Grammar plus strip is what makes the resolve safe.
  //
  // `''.split('/')` is `['']`, so the `some()` check catches an empty name too.
  const canonical = parsed.name.replace(/^\//, '');
  if (canonical.split('/').some((s) => s.length === 0)) {
    throw new SkillCallSyntaxError(
      `invalid skill name "${parsed.name}": empty path segment (no trailing or doubled '/')`,
      line,
      // The parser's recorded column, not a re-derived `indexOf`: a call whose
      // label repeats the name (`auth//login [skill: auth//login]`) would put
      // the caret on the label's copy.
      parsed.nameColumn,
    );
  }
  return { ...parsed, name: canonical };
}
