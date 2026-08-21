/**
 * A deliberately small TypeScript scanner: enough to tell code from strings,
 * template literals, comments and regex literals, and nothing more.
 *
 * The writer needs this because it rewrites one `{ ... }` span inside a file
 * a human may have edited. Brace-matching over raw text is wrong the moment a
 * string, a comment or a regex contains a brace — and a writer that gets that
 * wrong corrupts a committed file. See stories/step-codebehind.md, "The
 * writer".
 */

export const CODE = 0;
export const STRING = 1;
export const TEMPLATE = 2;
export const COMMENT = 3;
export const REGEX = 4;

export interface StringToken {
  /** Index of the opening quote. */
  start: number;
  /** Index just past the closing quote. */
  end: number;
  /** Decoded value (escapes resolved for the common cases). */
  value: string;
}

export interface Scan {
  src: string;
  /** Per-character classification; only `CODE` chars carry syntax. */
  mask: Uint8Array;
  /** Every single/double-quoted literal, in source order. Template literals
   *  are deliberately absent — an entry's `source` is never one. */
  strings: StringToken[];
}

/** Tokens after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await',
]);
const REGEX_PRECEDING_PUNCT = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-',
  '*', '%', '<', '>', '~', '^',
]);

/** Classify every character of `src`. */
export function scan(src: string): Scan {
  const mask = new Uint8Array(src.length);
  const strings: StringToken[] = [];
  let i = 0;
  // Last significant code token — a word, or a single punctuation character.
  // Drives the regex-vs-division decision, which is the one place a scanner
  // this size cannot be purely local.
  let lastToken = '';

  while (i < src.length) {
    const c = src[i]!;

    if (c === '/' && src[i + 1] === '/') {
      const end = consumeLineComment(src, i);
      fill(mask, i, end, COMMENT);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = consumeBlockComment(src, i);
      fill(mask, i, end, COMMENT);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = consumeString(src, i);
      fill(mask, i, end, STRING);
      strings.push({ start: i, end, value: decode(src.slice(i + 1, end - 1)) });
      i = end;
      lastToken = 'x';
      continue;
    }
    if (c === '`') {
      const end = consumeTemplate(src, i);
      fill(mask, i, end, TEMPLATE);
      i = end;
      lastToken = 'x';
      continue;
    }
    if (c === '/' && regexAllowedAfter(lastToken)) {
      const end = consumeRegex(src, i);
      if (end > i + 1) {
        fill(mask, i, end, REGEX);
        i = end;
        lastToken = 'x';
        continue;
      }
    }

    mask[i] = CODE;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j]!)) {
        mask[j] = CODE;
        j++;
      }
      lastToken = src.slice(i, j);
      i = j;
      continue;
    }
    lastToken = c;
    i++;
  }

  return { src, mask, strings };
}

function regexAllowedAfter(lastToken: string): boolean {
  if (REGEX_PRECEDING_PUNCT.has(lastToken)) return true;
  return REGEX_PRECEDING_KEYWORDS.has(lastToken);
}

function fill(mask: Uint8Array, start: number, end: number, kind: number): void {
  for (let i = start; i < end && i < mask.length; i++) mask[i] = kind;
}

function consumeLineComment(src: string, start: number): number {
  const nl = src.indexOf('\n', start);
  return nl === -1 ? src.length : nl;
}

function consumeBlockComment(src: string, start: number): number {
  const close = src.indexOf('*/', start + 2);
  return close === -1 ? src.length : close + 2;
}

/** From the opening quote to just past the matching one. */
export function consumeString(src: string, start: number): number {
  const quote = src[start]!;
  let i = start + 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    // An unterminated literal (someone is mid-edit) ends at the line break
    // rather than swallowing the rest of the file.
    if (c === '\n') return i;
    i++;
  }
  return src.length;
}

/** From the opening backtick to just past the matching one, `${}` included. */
export function consumeTemplate(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') {
      i = consumeBracedExpr(src, i + 1);
      continue;
    }
    i++;
  }
  return src.length;
}

/** From `{` to just past its matching `}`, respecting nested literals. */
function consumeBracedExpr(src: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"' || c === "'") { i = consumeString(src, i); continue; }
    if (c === '`') { i = consumeTemplate(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { i = consumeLineComment(src, i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = consumeBlockComment(src, i); continue; }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; if (depth === 0) return i; continue; }
    i++;
  }
  return src.length;
}

/** From `/` to just past the closing `/` plus flags; `start + 1` if it isn't
 *  actually a regex (so the caller can fall back to treating it as code). */
function consumeRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') return start + 1;
    if (c === '[') { inClass = true; i++; continue; }
    if (c === ']') { inClass = false; i++; continue; }
    if (c === '/' && !inClass) {
      i++;
      while (i < src.length && /[a-z]/.test(src[i]!)) i++;
      return i;
    }
    i++;
  }
  return start + 1;
}

/** Resolve the escapes that occur in generated/hand-written `source` values. */
function decode(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc: string) => {
    switch (esc[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return esc.length === 1 ? '\0' : esc;
      case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
      case 'u':
        return esc[1] === '{'
          ? String.fromCodePoint(parseInt(esc.slice(2, -1), 16))
          : String.fromCharCode(parseInt(esc.slice(1), 16));
      case '\n': return '';
      default: return esc;
    }
  });
}

/**
 * Walk outward from `pos` to the innermost `{ ... }` that encloses it,
 * counting only `CODE` braces. Returns null when `pos` sits at top level.
 */
export function enclosingBraceSpan(
  s: Scan,
  pos: number,
): { start: number; end: number } | null {
  let depth = 0;
  let open = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (s.mask[i] !== CODE) continue;
    const c = s.src[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) { open = i; break; }
      depth--;
    }
  }
  if (open === -1) return null;
  const close = matchForward(s, open, '{', '}');
  if (close === -1) return null;
  return { start: open, end: close + 1 };
}

/** Index of the `close` char matching the `open` char at `from`, or -1. */
export function matchForward(s: Scan, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < s.src.length; i++) {
    if (s.mask[i] !== CODE) continue;
    const c = s.src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Read a string-valued property of the object whose `{` is at `spanStart`,
 * looking only at the object's own top level (depth 1) so a nested object's
 * same-named key can't answer.
 *
 * Returns undefined when the property is absent or isn't a plain string.
 */
export function objectStringProperty(
  s: Scan,
  spanStart: number,
  spanEnd: number,
  name: string,
): string | undefined {
  for (const token of s.strings) {
    if (token.start <= spanStart || token.end > spanEnd) continue;
    if (codeDepthBetween(s, spanStart, token.start) !== 1) continue;
    const colon = prevCodeChar(s, token.start);
    if (colon === -1 || s.src[colon] !== ':') continue;
    const key = readKeyBefore(s, colon);
    if (key === name) return token.value;
  }
  return undefined;
}

/** Brace depth at `to`, counting from just after the `{` at `from`. */
export function codeDepthBetween(s: Scan, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    if (s.mask[i] !== CODE) continue;
    const c = s.src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return depth;
}

/** Index of the nearest significant code character before `pos`, or -1. */
function prevCodeChar(s: Scan, pos: number): number {
  for (let i = pos - 1; i >= 0; i--) {
    if (s.mask[i] !== CODE) continue;
    if (/\s/.test(s.src[i]!)) continue;
    return i;
  }
  return -1;
}

/** The property name immediately left of the `:` at `colon` — a bare
 *  identifier or a quoted key. */
function readKeyBefore(s: Scan, colon: number): string | undefined {
  const endChar = prevCodeChar(s, colon);
  if (endChar === -1) return undefined;
  const quoted = s.strings.find((t) => t.end === endChar + 1);
  if (quoted) return quoted.value;
  if (s.mask[endChar] !== CODE) return undefined;
  let i = endChar;
  while (i >= 0 && s.mask[i] === CODE && /[\w$]/.test(s.src[i]!)) i--;
  const word = s.src.slice(i + 1, endChar + 1);
  return word || undefined;
}
