/**
 * Shared tokenizer for `[<kind>: name ...]` invocations used by both skill
 * and tool calls. Produces precise errors with source-line + caret
 * diagnostics when the input is malformed, and desugars bare-identifier
 * shorthand into the canonical arg form.
 *
 * Grammar (parameterised by `kind`):
 *   Call         := Label? '[<kind>' Sep Name (WS Arg)* WS? ']' Trailing
 *   Sep          := WS? ':' WS?  |  WS
 *   Arg          := OutAlias | Param
 *   Param        := Identifier ( '=' (QuotedString | JsonArray | BareLiteral) )?
 *   OutAlias     := 'out.' Identifier ( '=' QuotedString )?
 *   QuotedString := '"' [^"]* '"'
 *   JsonArray    := '[' ... ']'   // captured verbatim including the brackets
 *   BareLiteral  := NumberLiteral | BooleanLiteral
 *   NumberLiteral  := -? digit+ ('.' digit+)?
 *   BooleanLiteral := 'true' | 'false'
 *
 * The colon after the keyword is optional — `[skill login]` and
 * `[skill: login]` are the same call. `[<kind>` opens an invocation only when
 * followed by `:` or inline whitespace, so bracketed prose that merely
 * contains the keyword's letters (`[skillful]`, `[skills]`) stays prose.
 *
 * Bare `Param`     desugars to `Identifier="{{Identifier}}"`
 * Bare `OutAlias`  desugars to `out.Identifier="Identifier"`
 *
 * `JsonArray` values are captured as the raw bracketed source (e.g.
 * `["a","b"]`). The tool executor decodes them via `JSON.parse` at the
 * bridge boundary when the target parameter is array-typed.
 *
 * `BareLiteral` values are stored as their string form (e.g. `"30"`,
 * `"true"`). The tool executor's `coerce` step converts the string to the
 * declared schema type (`number` / `boolean`) at call time, so authors can
 * write `sinceDays=30` or `enabled=true` without manual quoting. Anything
 * outside the BareLiteral grammar (e.g. `count=abc`) is rejected at parse
 * time with a clear "quote it as a string" hint — we don't silently
 * promote arbitrary identifiers to strings, since that masks typos.
 *
 * Output aliases (`out.X=`) only accept `QuotedString` — they're storing a
 * variable name, where number/boolean literals are never meaningful.
 */

export interface ParsedInvocation {
  name: string;
  /** Zero-based column in the source line where `name`'s first character sits.
   *  Recorded at read time so callers can point a caret at the name without
   *  re-deriving the offset with `indexOf` — which finds the wrong occurrence
   *  when the same text also appears in the call's `label`. */
  nameColumn: number;
  args: Record<string, string>;
  outputAliases: Record<string, string>;
  /** Text after the closing `]` — preserved for callers that want to log it. */
  trailing: string;
  /** Human-readable description that appeared *before* the `[skill:` / `[tool:`
   *  token on the same line, trimmed of surrounding whitespace. Omitted when
   *  the call appears at the start of the line (no prefix text) or when the
   *  prefix text is whitespace-only. Pure metadata — the parser never feeds
   *  it back into argument resolution. */
  label?: string;
}

export class InvocationSyntaxError extends Error {
  constructor(
    /** Plain message, without the source-line decoration. */
    public readonly reason: string,
    /** The full source line as authored (with leading whitespace). */
    public readonly source: string,
    /** Zero-based column in `source` where the problem was detected. */
    public readonly column: number,
    /** Subclass name (`SkillCallSyntaxError`, `ToolCallSyntaxError`). */
    name = 'InvocationSyntaxError',
  ) {
    super(formatMessage(reason, source, column));
    this.name = name;
  }
}

function formatMessage(reason: string, source: string, column: number): string {
  const caret = `${' '.repeat(Math.max(0, column))}^`;
  return `${reason}\n  ${source}\n  ${caret}`;
}

/**
 * True when `ch` could start a bare numeric or boolean literal — used by the
 * dispatcher in `parseInvocation` to decide whether to take the `readBareLiteral`
 * branch. Conservative: accepts only the first character of a valid token, so
 * a typo like `count=abc` falls through to the "quote it" error rather than
 * being silently captured as a string.
 */
function isBareLiteralStart(ch: string): boolean {
  return /[0-9\-+.tf]/.test(ch);
}

/**
 * Dispatch the four arg-value forms after `=`: quoted string, JSON array,
 * bare literal (number/boolean), or syntax error. Lifted out of
 * `parseInvocation` so each branch's return is the function's return —
 * keeps TypeScript's control-flow analysis happy through the never-returning
 * `errorHere` paths.
 */
function readArgValue(
  scanner: Scanner,
  argName: string,
  isOutput: boolean,
): string {
  const next = scanner.peek();
  if (next === '"') {
    const quoteCol = scanner.pos;
    scanner.advance();
    return scanner.readUntilQuote(argName, quoteCol);
  }
  if (next === '[') {
    if (isOutput) {
      scanner.errorHere(
        `output alias '${argName}' must be a quoted string, not an array`,
      );
    }
    // Inline JSON array — captured as the raw bracketed source. Decoded by
    // the tool executor at the bridge boundary when the target parameter is
    // array-typed.
    return scanner.readBracketedLiteral(argName);
  }
  if (isBareLiteralStart(next)) {
    if (isOutput) {
      // Output aliases must be quoted strings — they're variable names.
      // Allowing bare literals here would let `out.x=5` create a variable
      // named `"5"`, which is never sensible.
      scanner.errorHere(
        `output alias '${argName}' must be a quoted string, not a bare literal`,
      );
    }
    return scanner.readBareLiteral(argName);
  }
  if (next === '{') {
    // Almost certainly an unquoted `{{var}}` template reference — a common
    // mistake, since the bare-identifier shorthand auto-quotes but an
    // explicit `=` value does not. Point straight at the fix rather than
    // listing the generic value forms (which never mention templates).
    scanner.errorHere(
      `template variable for argument '${argName}' must be quoted — ` +
        `write ${argName}="{{...}}" (e.g. ${argName}="{{repos}}"), not ${argName}={{...}}`,
    );
  }
  scanner.errorHere(
    `expected '"', '[', a number, or true/false after '=' for argument '${argName}'`,
  );
}

/** Regex the captured bare token must satisfy to be accepted as a number. */
const BARE_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const BARE_BOOLEAN_RE = /^(?:true|false)$/;

/** The invocation keywords, in the order the code-step scans alternate them. */
export const INVOCATION_KINDS = ['skill', 'tool'] as const;
export type InvocationKind = (typeof INVOCATION_KINDS)[number];

/**
 * THE token rule, in one place: `[<kind>` followed by `:` or inline
 * whitespace. Everything in this package that asks "does this step open an
 * invocation?" builds its pattern from here rather than re-typing the class —
 * `src/mcp/assemble.ts` (the errand / project-less code-step scan) and
 * `src/codebehind/live-compile.ts` (never-generate) both do.
 *
 * The separator class is deliberately `[ \t:]` and NOT `\s`: the scanner's
 * `skipInlineSpace` only ever consumes a space or a tab, so admitting a
 * newline or a non-breaking space here would claim tokens the scanner then
 * refuses to name — a mirror that says "call" where the parser says "prose".
 *
 * Case-SENSITIVE, matching the scanner. `[SKILL: x]` is prose to the runner,
 * so a mirror that claims it would refuse a step the server runs happily.
 *
 * (testbench-native cannot import this — separate package — and mirrors it in
 * `invocation-target-core.ts`, pinned by that package's parity tests.)
 */
export function invocationTokenPattern(
  kinds: readonly string[] = INVOCATION_KINDS,
  flags = '',
): RegExp {
  return new RegExp(`\\[(?:${kinds.join('|')})(?=[ \\t:])`, flags);
}

/**
 * One finder per kind, built once — `parseInvocation` runs on every step line
 * of every parse.
 *
 * `g`, because the scan must be able to resume past a DECLINED candidate (a
 * markdown link, an unparseable colon-less token) to reach a real call later
 * on the same line. `parseInvocation` sets `lastIndex` before every `exec`, so
 * the shared state never leaks between calls — safe because the whole scan is
 * synchronous.
 */
const TOKEN_FINDERS: Record<InvocationKind, RegExp> = {
  skill: invocationTokenPattern(['skill'], 'g'),
  tool: invocationTokenPattern(['tool'], 'g'),
};

/**
 * Does this step open an invocation the runner will expand or dispatch?
 *
 * THE predicate for "is this a code step", used by the errand / project-less
 * scan (`src/mcp/assemble.ts`) and by code-behind's never-generate rule
 * (`src/codebehind/live-compile.ts`). It runs the real parser rather than a
 * look-alike regex, so it cannot disagree with what the runner does — which a
 * regex demonstrably did, in both directions, and which no regex can get right
 * now that the grammar declines markdown links and unparseable colon-less
 * tokens. Those decisions live inside `parseInvocation`; a mirror would have
 * to re-implement them to stay honest, so it doesn't mirror, it calls.
 *
 * A line that COMMITS and then fails to parse counts as a call: it is a
 * malformed `[skill:`, and the contexts asking this question exist to keep
 * such lines out of runs that cannot execute them.
 *
 * Cost is two parses per step, on paths that already parse the file — the
 * scans run over a handful of steps at request assembly, not in a hot loop.
 */
export function isCodeStep(line: string): boolean {
  for (const kind of INVOCATION_KINDS) {
    try {
      if (parseInvocation(line, { kind, allowSlashInName: true }) !== null) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export interface InvocationParserOptions {
  /** The invocation keyword. The token is `[<kind>` followed by `:` or inline
   *  whitespace — the colon is optional. Narrowed to the two real kinds so the
   *  finder table is total and nothing unvalidated reaches a `RegExp`. */
  kind: InvocationKind;
  /** Error subclass to throw for syntax errors. Defaults to `InvocationSyntaxError`. */
  errorClass?: new (reason: string, source: string, column: number) => InvocationSyntaxError;
  /**
   * Allow `/` in the name token so callers can use path-qualified references.
   * Tool calls use it to name a file plus the tool inside it
   * (`auth/login/login`); skill calls use it to reach skills in subfolders
   * of `skillsDir` (`auth/login`, leading slash tolerated).
   */
  allowSlashInName?: boolean;
}

/**
 * Try to parse `line` as an invocation of the configured kind.
 *
 * Returns `null` if the line does not contain the invocation token — the
 * keyword bracket (`[skill` / `[tool`) followed by `:` or inline whitespace —
 * at all. Throws the configured error class if the line contains the token
 * but the bracketed call is malformed.
 *
 * Any text that appears before the token is captured as `label` (trimmed)
 * so authors can prefix an invocation with a human-readable description:
 *
 *   `Search with DuckDuckGo [skill: duckduckgo_search query="..."]`
 *
 * The label is pure metadata — the parser never threads it into arg
 * resolution. Whitespace-only prefix text produces no label (the canonical
 * `[skill: foo]` form is unchanged).
 */
export function parseInvocation(
  line: string,
  options: InvocationParserOptions,
): ParsedInvocation | null {
  const { kind } = options;
  // EVERY candidate token on the line, not just the first. A token can be
  // DECLINED — a markdown link, or a colon-less one that does not parse — and
  // a declined candidate must not take the rest of the line with it:
  // `See the [skill guide](./g.md) and then [skill: login]` really does call
  // `login`. Scanning only the first match made that step prose, and made
  // `isCodeStep` answer "no" for a step carrying a live call, which is
  // exactly the property the project-less no-tools guarantee rests on.
  const finder = TOKEN_FINDERS[kind];
  finder.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = finder.exec(line)) !== null) {
    const prefixIdx = token.index;
    // Resume the search *after* this `[`, so a declined candidate advances
    // the scan by one character rather than looping on itself.
    finder.lastIndex = prefixIdx + 1;

    // Does the separator include a colon? That is the difference between a
    // token an author can only have typed deliberately (`[skill:`) and one
    // that ordinary prose produces by accident (`[skill ` — see COMMITMENT
    // below). Peeked before parsing so the decision is made before any error.
    const sepEnd = prefixIdx + 1 + kind.length;
    const sawColon = /^[ \t]*:/.test(line.slice(sepEnd));

    try {
      const parsed = parseFromToken(line, options, prefixIdx, sepEnd);
      // `null` here means "declined as a markdown link" — keep looking.
      if (parsed !== null) return parsed;
    } catch (err) {
      // COMMITMENT. `[skill:` is unambiguous authorial intent, so a malformed
      // one throws with a caret rather than silently becoming prose — that is
      // the whole point of the tokenizer (stories/skill-call-syntax.md).
      //
      // The colon-less spelling cannot carry that rule. `[tool "hammer"]` and
      // `Verify the [skill level: expert] badge` are English, and throwing on
      // them fails the ENTIRE test file at parse time (`extractSteps`), not
      // just the step — a prose sentence taking down the suite. So a
      // colon-less token that does not parse is not a call; keep looking.
      //
      // The cost is a typo'd colon-less call (`[skill login pass=]`) reaching
      // the AI as prose instead of erroring. Authors who want the strict
      // reading have it: write the colon.
      if (sawColon || !(err instanceof InvocationSyntaxError)) throw err;
    }
  }
  return null;
}

/** The grammar proper, from a located token. Split out so `parseInvocation`
 *  can decide what a thrown error MEANS without duplicating the scan. */
function parseFromToken(
  line: string,
  options: InvocationParserOptions,
  prefixIdx: number,
  sepEnd: number,
): ParsedInvocation | null {
  const labelRaw = line.slice(0, prefixIdx).trim();
  const label = labelRaw === '' ? undefined : labelRaw;

  const ErrorCls = options.errorClass ?? InvocationSyntaxError;
  const scanner = new Scanner(line, sepEnd, ErrorCls);
  // Sep := WS? ':' WS? | WS — the lookahead above guarantees at least one
  // separator character is present, so a bare `[skill]` never gets here.
  scanner.skipInlineSpace();
  scanner.tryConsume(':');
  scanner.skipInlineSpace();

  const nameColumn = scanner.pos;
  const name = scanner.readIdentifier({
    allowHyphen: true,
    allowSlash: options.allowSlashInName === true,
  });
  if (!name) {
    scanner.errorHere('name missing');
  }

  const args: Record<string, string> = {};
  const outputAliases: Record<string, string> = {};

  while (true) {
    const consumedSpace = scanner.skipInlineSpace();

    if (scanner.peek() === ']') {
      scanner.advance();
      const trailing = scanner.rest();
      // `[text](url)` is a markdown LINK, not an invocation — and in a
      // markdown-authored suite it is the likeliest way for a bracketed
      // keyword to appear. `[skill guide](./guide.md)` otherwise parses as
      // a call to a skill named `guide` and fails the whole file when no
      // such skill exists. Only an IMMEDIATELY adjacent `(` is a link, so
      // a genuine call with a parenthesised comment after it —
      // `[skill: login] (smoke only)` — still parses.
      if (trailing.startsWith('(')) return null;
      return {
        name,
        nameColumn,
        args,
        outputAliases,
        trailing,
        ...(label !== undefined && { label }),
      };
    }

    if (scanner.atEnd()) {
      scanner.errorAt(scanner.pos, "unclosed invocation: expected ']'");
    }

    if (!consumedSpace) {
      scanner.errorHere(`expected whitespace or ']' before next argument`);
    }

    const isOutput = scanner.tryConsume('out.');
    const argStart = scanner.pos;
    const argName = scanner.readIdentifier();
    if (!argName) {
      if (isOutput) {
        scanner.errorAt(argStart, `expected output name after 'out.'`);
      }
      scanner.errorAt(argStart, `expected argument name or ']'`);
    }

    if (scanner.peek() === '=') {
      scanner.advance();
      const value = readArgValue(scanner, argName, isOutput);
      if (isOutput) {
        outputAliases[argName] = value;
      } else {
        args[argName] = value;
      }
    } else {
      const next = scanner.peek();
      if (next !== '' && next !== ' ' && next !== '\t' && next !== ']') {
        scanner.errorHere(
          `unexpected character '${next}' after argument '${argName}' (expected '=', whitespace, or ']')`,
        );
      }
      if (isOutput) {
        outputAliases[argName] = argName;
      } else {
        args[argName] = `{{${argName}}}`;
      }
    }
  }
}

class Scanner {
  pos: number;

  constructor(
    public readonly source: string,
    startPos: number,
    private readonly ErrorCls: new (
      reason: string,
      source: string,
      column: number,
    ) => InvocationSyntaxError,
  ) {
    this.pos = startPos;
  }

  peek(): string {
    return this.source[this.pos] ?? '';
  }

  advance(): void {
    this.pos++;
  }

  atEnd(): boolean {
    return this.pos >= this.source.length;
  }

  rest(): string {
    return this.source.slice(this.pos);
  }

  skipInlineSpace(): boolean {
    const start = this.pos;
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t') this.pos++;
      else break;
    }
    return this.pos > start;
  }

  tryConsume(prefix: string): boolean {
    if (this.source.slice(this.pos, this.pos + prefix.length) === prefix) {
      this.pos += prefix.length;
      return true;
    }
    return false;
  }

  readIdentifier(opts: { allowHyphen?: boolean; allowSlash?: boolean } = {}): string {
    const start = this.pos;
    // `allowSlash` is for path-qualified references — a tool's file plus the
    // tool inside it (`auth/login/login`), or a skill in a subfolder of
    // `skillsDir` (`auth/login`): the name token may contain `/` to name a
    // path. Hyphens are always allowed alongside slashes since each path
    // segment is `[\w-]+`. Note there is deliberately no `.` and no `\` in
    // the class, so no path-qualified name can traverse out of its root.
    const re = opts.allowSlash ? /[\w\-/]/ : opts.allowHyphen ? /[\w-]/ : /\w/;
    while (!this.atEnd() && re.test(this.peek())) this.pos++;
    return this.source.slice(start, this.pos);
  }

  readUntilQuote(argName: string, openQuoteCol: number): string {
    const start = this.pos;
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === '"') {
        const value = this.source.slice(start, this.pos);
        this.advance();
        return value;
      }
      if (ch === '\n' || ch === '\r') {
        this.errorAt(openQuoteCol, `unterminated string for argument '${argName}'`);
      }
      this.pos++;
    }
    this.errorAt(openQuoteCol, `unterminated string for argument '${argName}'`);
  }

  /**
   * Read a bare numeric or boolean literal — everything from the current
   * position up to (but not including) the next whitespace or `]`. Validates
   * the captured token against `BARE_NUMBER_RE` / `BARE_BOOLEAN_RE`; rejects
   * anything else with a "quote it as a string" hint, so an unintended
   * unquoted identifier (e.g. `count=abc`) never silently becomes a string.
   *
   * The caller (`parseInvocation`) is positioned at the first character of
   * the bare token when this is invoked. Returns the token as a string —
   * the tool bridge's `coerce` step does the type conversion at call time.
   */
  readBareLiteral(argName: string): string {
    const start = this.pos;
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === ']' || ch === '\n' || ch === '\r') break;
      this.pos++;
    }
    const token = this.source.slice(start, this.pos);
    if (BARE_NUMBER_RE.test(token) || BARE_BOOLEAN_RE.test(token)) {
      return token;
    }
    this.errorAt(
      start,
      `argument '${argName}' has invalid bare value '${token}' — expected a number, true/false, or a quoted string`,
    );
  }

  /**
   * Read a bracketed `[...]` literal, returning the source verbatim
   * (including the outer brackets). Tracks bracket depth and skips over
   * `"`-quoted strings (with `\"` escapes) so a nested `]` inside a string
   * doesn't close the literal early. The caller (`parseInvocation`) is
   * positioned at the opening `[` when this is invoked.
   */
  readBracketedLiteral(argName: string): string {
    const start = this.pos;
    const openCol = this.pos;
    if (this.peek() !== '[') {
      this.errorAt(openCol, `expected '[' for array literal of argument '${argName}'`);
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    while (!this.atEnd()) {
      const ch = this.peek();
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
        if (depth === 0) {
          this.pos++; // consume the closing ']'
          return this.source.slice(start, this.pos);
        }
      } else if (ch === '\n' || ch === '\r') {
        this.errorAt(openCol, `unterminated array literal for argument '${argName}'`);
      }
      this.pos++;
    }
    this.errorAt(openCol, `unterminated array literal for argument '${argName}'`);
  }

  errorHere(message: string): never {
    this.errorAt(this.pos, message);
  }

  errorAt(col: number, message: string): never {
    throw new this.ErrorCls(message, this.source, col);
  }
}
