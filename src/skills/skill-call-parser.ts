/**
 * Tokenizer for `[skill: name ...]` invocations. Produces precise errors
 * with source-line + caret diagnostics when the input is malformed, and
 * desugars bare-identifier shorthand into the canonical arg form.
 *
 * Grammar:
 *   SkillCall    := WS? '[skill:' WS Name (WS Arg)* WS? ']' Trailing
 *   Arg          := OutAlias | Param
 *   Param        := Identifier ( '=' QuotedString )?
 *   OutAlias     := 'out.' Identifier ( '=' QuotedString )?
 *   QuotedString := '"' [^"]* '"'
 *
 * Bare `Param`     desugars to `Identifier="{{Identifier}}"`
 * Bare `OutAlias`  desugars to `out.Identifier="Identifier"`
 */

export interface ParsedSkillCall {
  name: string;
  args: Record<string, string>;
  outputAliases: Record<string, string>;
  /** Text after the closing `]` — preserved for callers that want to log it. */
  trailing: string;
}

export class SkillCallSyntaxError extends Error {
  constructor(
    /** Plain message, without the source-line decoration. */
    public readonly reason: string,
    /** The full source line as authored (with leading whitespace). */
    public readonly source: string,
    /** Zero-based column in `source` where the problem was detected. */
    public readonly column: number,
  ) {
    super(formatMessage(reason, source, column));
    this.name = 'SkillCallSyntaxError';
  }
}

function formatMessage(reason: string, source: string, column: number): string {
  const caret = `${' '.repeat(Math.max(0, column))}^`;
  return `${reason}\n  ${source}\n  ${caret}`;
}

const NAME_PREFIX = '[skill:';

/**
 * Try to parse `line` as a skill invocation.
 *
 * Returns `null` if the line is not a skill call (does not start with
 * `[skill:` after optional leading whitespace). Throws `SkillCallSyntaxError`
 * if the line opens as a skill call but is malformed.
 */
export function parseSkillCall(line: string): ParsedSkillCall | null {
  const leadingWs = line.match(/^\s*/)?.[0].length ?? 0;
  if (line.slice(leadingWs, leadingWs + NAME_PREFIX.length) !== NAME_PREFIX) {
    return null;
  }

  const scanner = new Scanner(line, leadingWs + NAME_PREFIX.length);
  scanner.skipInlineSpace();

  const name = scanner.readIdentifier({ allowHyphen: true });
  if (!name) {
    scanner.errorHere('skill name missing');
  }

  const args: Record<string, string> = {};
  const outputAliases: Record<string, string> = {};

  // Track whether the previous token consumed trailing whitespace via
  // skipInlineSpace; we use this to enforce a separator between args.
  while (true) {
    const consumedSpace = scanner.skipInlineSpace();

    if (scanner.peek() === ']') {
      scanner.advance();
      return { name, args, outputAliases, trailing: scanner.rest() };
    }

    if (scanner.atEnd()) {
      scanner.errorAt(scanner.pos, "unclosed skill invocation: expected ']'");
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
      // Bare-identifier shorthand. Must be followed by whitespace or ']'.
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

  /** Skip space and tab characters only — newlines should never appear inside a single step line. */
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

  /** Read until the next `"`, advancing past it. Throws on unterminated. */
  readUntilQuote(argName: string, openQuoteCol: number): string {
    const start = this.pos;
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === '"') {
        const value = this.source.slice(start, this.pos);
        this.advance();
        return value;
      }
      // Newlines are not legal inside a quoted value.
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
    throw new SkillCallSyntaxError(message, this.source, col);
  }
}
