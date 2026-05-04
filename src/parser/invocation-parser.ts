/**
 * Shared tokenizer for `[<kind>: name ...]` invocations used by both skill
 * and tool calls. Produces precise errors with source-line + caret
 * diagnostics when the input is malformed, and desugars bare-identifier
 * shorthand into the canonical arg form.
 *
 * Grammar (parameterised by `kind`):
 *   Call         := WS? '[<kind>:' WS Name (WS Arg)* WS? ']' Trailing
 *   Arg          := OutAlias | Param
 *   Param        := Identifier ( '=' QuotedString )?
 *   OutAlias     := 'out.' Identifier ( '=' QuotedString )?
 *   QuotedString := '"' [^"]* '"'
 *
 * Bare `Param`     desugars to `Identifier="{{Identifier}}"`
 * Bare `OutAlias`  desugars to `out.Identifier="Identifier"`
 */

export interface ParsedInvocation {
  name: string;
  args: Record<string, string>;
  outputAliases: Record<string, string>;
  /** Text after the closing `]` — preserved for callers that want to log it. */
  trailing: string;
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

export interface InvocationParserOptions {
  /** The bracketed prefix, e.g. `'[skill:'` or `'[tool:'`. */
  prefix: string;
  /** Error subclass to throw for syntax errors. Defaults to `InvocationSyntaxError`. */
  errorClass?: new (reason: string, source: string, column: number) => InvocationSyntaxError;
}

/**
 * Try to parse `line` as an invocation of the configured kind.
 *
 * Returns `null` if the line is not a call of this kind (does not start with
 * the configured prefix after optional leading whitespace). Throws the
 * configured error class if the line opens as a call but is malformed.
 */
export function parseInvocation(
  line: string,
  options: InvocationParserOptions,
): ParsedInvocation | null {
  const { prefix } = options;
  const leadingWs = line.match(/^\s*/)?.[0].length ?? 0;
  if (line.slice(leadingWs, leadingWs + prefix.length) !== prefix) {
    return null;
  }

  const ErrorCls = options.errorClass ?? InvocationSyntaxError;
  const scanner = new Scanner(line, leadingWs + prefix.length, ErrorCls);
  scanner.skipInlineSpace();

  const name = scanner.readIdentifier({ allowHyphen: true });
  if (!name) {
    scanner.errorHere('name missing');
  }

  const args: Record<string, string> = {};
  const outputAliases: Record<string, string> = {};

  while (true) {
    const consumedSpace = scanner.skipInlineSpace();

    if (scanner.peek() === ']') {
      scanner.advance();
      return { name, args, outputAliases, trailing: scanner.rest() };
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
      if (scanner.peek() !== '"') {
        scanner.errorHere(`expected '"' after '=' for argument '${argName}'`);
      }
      const quoteCol = scanner.pos;
      scanner.advance();
      const value = scanner.readUntilQuote(argName, quoteCol);
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

  readIdentifier(opts: { allowHyphen?: boolean } = {}): string {
    const start = this.pos;
    const re = opts.allowHyphen ? /[\w-]/ : /\w/;
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

  errorHere(message: string): never {
    this.errorAt(this.pos, message);
  }

  errorAt(col: number, message: string): never {
    throw new this.ErrorCls(message, this.source, col);
  }
}
