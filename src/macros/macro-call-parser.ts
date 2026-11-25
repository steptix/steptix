/**
 * Tokenizer for `[macro: name ...]` invocations. Thin wrapper over the shared
 * `parseInvocation` core (see `src/parser/invocation-parser.ts`) — adds the
 * `MacroCallSyntaxError` class and the macro-specific name rules (subfolder
 * paths, one canonical form), while sharing every line of grammar logic with the tool-call parser.
 */

import {
  parseInvocation,
  InvocationSyntaxError,
  type ParsedInvocation,
} from '../parser/invocation-parser.js';

export type ParsedMacroCall = ParsedInvocation;

export class MacroCallSyntaxError extends InvocationSyntaxError {
  constructor(reason: string, source: string, column: number) {
    super(reason, source, column, 'MacroCallSyntaxError');
  }
}

export function parseMacroCall(line: string): ParsedMacroCall | null {
  const parsed = parseInvocation(line, {
    kind: 'macro',
    errorClass: MacroCallSyntaxError,
    // Macros may live in subfolders of `macrosDir`, referenced path-qualified:
    // `[macro: auth/login]` resolves `<macrosDir>/auth/login.md`. A leading
    // slash is accepted sugar for the same thing (`[macro: /auth/login]`).
    allowSlashInName: true,
  });
  if (!parsed || !parsed.name.includes('/')) return parsed;

  // Canonicalise before anything downstream sees the name: the expander's
  // cycle keys, frame `macroName`s and report badges must agree that
  // `/auth/login` and `auth/login` are one macro, so exactly one form
  // survives parsing.
  //
  // The slash strip is also half of the containment property `loadMacro`
  // relies on. The grammar admits no `.` and no `\`, so no name can walk
  // upwards — but a name is fed to `path.resolve(macrosDir, ...)`, and
  // `path.resolve` treats a leading slash as ABSOLUTE: without this strip,
  // `/auth/login` would resolve to the drive root on Windows rather than into
  // `macrosDir`. Grammar plus strip is what makes the resolve safe.
  //
  // `''.split('/')` is `['']`, so the `some()` check catches an empty name too.
  const canonical = parsed.name.replace(/^\//, '');
  if (canonical.split('/').some((s) => s.length === 0)) {
    throw new MacroCallSyntaxError(
      `invalid macro name "${parsed.name}": empty path segment (no trailing or doubled '/')`,
      line,
      // The parser's recorded column, not a re-derived `indexOf`: a call whose
      // label repeats the name (`auth//login [macro: auth//login]`) would put
      // the caret on the label's copy.
      parsed.nameColumn,
    );
  }
  return { ...parsed, name: canonical };
}
