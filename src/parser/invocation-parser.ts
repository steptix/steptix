/**
 * Shared tokenizer for `[<kind>: name ...]` invocations used by both skill
 * and tool calls. Produces precise errors with source-line + caret
 * diagnostics when the input is malformed, and desugars bare-identifier
 * shorthand into the canonical arg form.
 *
 * Grammar (parameterised by `kind`):
 *   Call         := WS? '[<kind>:' WS Name (WS Arg)* WS? ']' Trailing
 *   Arg          := OutAlias | Param
 *   Param        := Identifier ( '=' (QuotedString | JsonArray | BareLiteral) )?
 *   OutAlias     := 'out.' Identifier ( '=' QuotedString )?
 *   QuotedString := '"' [^"]* '"'
 *   JsonArray    := '[' ... ']'   // captured verbatim including the brackets
 *   BareLiteral  := NumberLiteral | BooleanLiteral
 *   NumberLiteral  := -? digit+ ('.' digit+)?
 *   BooleanLiteral := 'true' | 'false'
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

export interface InvocationParserOptions {
  /** The bracketed prefix, e.g. `'[skill:'` or `'[tool:'`. */
  prefix: string;
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
 * Returns `null` if the line does not contain the configured prefix
 * (`[skill:` / `[tool:`) at all. Throws the configured error class if the
 * line contains the prefix but the bracketed call is malformed.
 *
 * Any text that appears before the prefix is captured as `label` (trimmed)
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
  const { prefix } = options;
  const prefixIdx = line.indexOf(prefix);
  if (prefixIdx === -1) {
    return null;
  }
  const labelRaw = line.slice(0, prefixIdx).trim();
  const label = labelRaw === '' ? undefined : labelRaw;

  const ErrorCls = options.errorClass ?? InvocationSyntaxError;
  const scanner = new Scanner(line, prefixIdx + prefix.length, ErrorCls);
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
      return {
        name,
        nameColumn,
        args,
        outputAliases,
        trailing: scanner.rest(),
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
