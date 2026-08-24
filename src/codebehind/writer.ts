import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { format as prettierFormat, resolveConfig as prettierResolveConfig } from 'prettier';
import { matchText } from '../parser/section-match.js';
import { bundleToolModule } from '../tools/reload.js';
import { logger } from '../utils/logger.js';
import {
  scan,
  codeDepthBetween,
  enclosingBraceSpan,
  matchForward,
  objectStringProperty,
  CODE,
  type Scan,
} from './tokenizer.js';
import { resolveCodeBehindCacheDir } from './loader.js';

/**
 * The `.steps.ts` writer (stories/step-codebehind.md, "The writer").
 *
 * Three invariants, in priority order:
 *
 *  1. **Never corrupt the file.** Spans are located with a real tokenizer, the
 *     replacement is written atomically (temp + rename), the result is
 *     esbuild-validated, and a failing validation restores the previous bytes
 *     byte-for-byte.
 *  2. **Never delete an entry** — not even one matching no step. An author's
 *     code is theirs; a stale entry is a warning, not a licence to remove it.
 *  3. **Touch nothing else.** Only the one entry's span is replaced, so
 *     helpers, imports, comments and hand edits elsewhere survive verbatim.
 */

export interface WriteEntryRequest {
  /** Absolute path of the `.steps.ts`. */
  file: string;
  /** The step's authored text — becomes/matches the entry's `source`. */
  source: string;
  /** Section scope to stamp. The runner decides this from the step's frame;
   *  the model never chooses scope. */
  section?: string | undefined;
  /** 0-based occurrence among entries carrying the same (source, section). */
  occurrence: number;
  /** The entry object literal as generated — `{ source: ..., async run(...) }`,
   *  braces included, no trailing comma required. */
  entryCode: string;
  /** Markdown file this code-behind belongs to; used in the created header. */
  markdownFile?: string | undefined;
}

export type WriteEntryAction = 'created' | 'appended' | 'replaced';

/** Write (or rewrite) one entry. Throws only on an I/O failure the caller
 *  cannot paper over; a validation failure restores and throws. */
export async function writeCodeBehindEntry(
  request: WriteEntryRequest,
): Promise<WriteEntryAction> {
  const file = path.resolve(request.file);
  const original = await readIfExists(file);

  let next: string;
  let action: WriteEntryAction;
  if (original === null) {
    next = createFile(request);
    action = 'created';
  } else {
    const spliced = spliceEntry(original, request);
    next = spliced.text;
    action = spliced.action;
  }

  await atomicWrite(file, next);

  try {
    await validate(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (original === null) {
      await fs.rm(file, { force: true });
    } else {
      await atomicWrite(file, original);
    }
    throw new Error(
      `Generated code-behind did not compile, so ${file} was left exactly as it was: ${message}`,
    );
  }

  return action;
}

/**
 * Write a complete code-behind file the compiler produced
 * (stories/codebehind-compile.md, "Write").
 *
 * Validated before it lands, so a file that would not compile is never written
 * at all — the same invariant the entry writer has, reached the other way
 * round because here the whole file is new rather than one span of an existing
 * one.
 */
export async function writeCodeBehindFile(file: string, contents: string): Promise<void> {
  const target = path.resolve(file);
  const invalid = await validateCodeBehindSource(target, contents);
  if (invalid) {
    throw new Error(
      `Refusing to write ${target}: the proposed content does not compile: ${invalid}`,
    );
  }
  await atomicWrite(target, contents);
}

/**
 * A code-behind file as an author would write it.
 *
 * The model emits each entry on one line — a JSON envelope invites that — and
 * nothing downstream cares, but a file of 300-character lines is not code
 * anyone can read in a diff or edit by hand. So the candidate is formatted
 * with Prettier every time it changes: the generate prompt, the trail, the
 * replay, the diff and the applied file all see the same text. House style —
 * single quotes, 100 columns. Binding is by each `source` string's value, so
 * the quoting Prettier picks changes nothing.
 *
 * A project that runs Prettier itself has a config, and the file is theirs:
 * when `file` is given, its project's Prettier config (found the way
 * Prettier finds it, upward from the file) wins over the house style, so the
 * compiled file does not churn under the author's own formatter.
 *
 * Never throws: code Prettier cannot parse comes back as it was, and the
 * esbuild validation that follows reports the real error.
 */
export async function formatCodeBehindSource(source: string, file?: string): Promise<string> {
  try {
    const projectConfig = file ? await prettierResolveConfig(file).catch(() => null) : null;
    return await prettierFormat(source, {
      singleQuote: true,
      printWidth: 100,
      trailingComma: 'all',
      ...(projectConfig ?? {}),
      parser: 'typescript',
      ...(file && { filepath: file }),
    });
  } catch (err) {
    logger.debug(`Could not format the code-behind file: ${String(err)}`);
    return source;
  }
}

/**
 * esbuild-validate proposed content **without** touching the file it is
 * destined for. Returns the error message, or null when it compiles.
 *
 * Bundled from a temp `.ts` inside the cache dir beside the destination, so
 * `ai-ui-automation/codebehind` resolves by the same walk-up the real file
 * would use. A code-behind file has no relative imports (the generator's rule
 * 6), which is what makes bundling from a different directory equivalent.
 */
export async function validateCodeBehindSource(
  file: string,
  contents: string,
): Promise<string | null> {
  const dir = resolveCodeBehindCacheDir(file);
  const temp = path.join(dir, `validate-${randomUUID()}.ts`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(temp, contents, 'utf-8');
    await bundleToolModule(temp, dir);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/** Byte-for-byte restore-safe write: temp file in the same directory, then
 *  rename over the target (same filesystem, so the rename is atomic). */
async function atomicWrite(file: string, contents: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, contents, 'utf-8');
  try {
    await fs.rename(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * esbuild-bundle the file; a throw means the file does not compile.
 *
 * The second argument is only esbuild's working directory (nothing is
 * written — `bundleToolModule` sets `write: false`), so the file's own
 * directory is the right answer: it resolves relative helpers exactly as the
 * loader will, and it leaves no cache dir behind on a validate-only pass.
 */
async function validate(file: string): Promise<void> {
  await bundleToolModule(file, path.dirname(file));
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The header a freshly created code-behind file carries. */
export function createFile(request: WriteEntryRequest): string {
  const name = request.markdownFile ? path.basename(request.markdownFile) : 'this test';
  return (
    `// Generated by ai-ui-automation — code-behind for ${name}.\n` +
    `// Safe to hand-edit: entries match steps by their \`source\` text.\n` +
    `// A step whose text changes falls back to AI and is regenerated.\n` +
    `import { defineSteps } from 'ai-ui-automation/codebehind';\n` +
    `\n` +
    `export default defineSteps([\n` +
    `${indent(stampSection(request.entryCode, request.section), '  ')},\n` +
    `]);\n`
  );
}

/**
 * Replace the nth matching entry, or append a new one before the array's
 * closing `]`.
 *
 * Exported for tests: the splice is the part that must not corrupt a file, and
 * proving that needs no filesystem.
 */
export function spliceEntry(
  original: string,
  request: WriteEntryRequest,
): { text: string; action: 'appended' | 'replaced' } {
  const s = scan(original);
  const entryText = stampSection(request.entryCode, request.section);
  const spans = findEntrySpans(s, request.source, request.section);
  const target = spans[request.occurrence];

  if (target) {
    const lineIndent = indentOfLineAt(original, target.start);
    const replacement = indent(entryText, lineIndent).slice(lineIndent.length);
    return {
      text: original.slice(0, target.start) + replacement + original.slice(target.end),
      action: 'replaced',
    };
  }

  const insertAt = arrayCloseIndex(s);
  if (insertAt === -1) {
    throw new Error(
      `Could not find the \`defineSteps([...])\` array in the code-behind file — ` +
        `leaving it untouched.`,
    );
  }
  const before = original.slice(0, insertAt);
  const after = original.slice(insertAt);
  const lineIndent = indentOfLineAt(original, insertAt);
  const body = `${indent(entryText, `${lineIndent}  `)},\n${lineIndent}`;
  // Keep the existing last entry's trailing comma situation intact: if the
  // text before `]` doesn't already end a list item, add the separator.
  const trimmedBefore = before.replace(/\s+$/, '');
  const needsComma = trimmedBefore.length > 0 && !/[,[]$/.test(trimmedBefore);
  const prefix = needsComma ? `${trimmedBefore},\n` : `${trimmedBefore}\n`;
  return { text: prefix + body + after, action: 'appended' };
}

/**
 * Every `{ ... }` span in the file whose `source` property equals `source` and
 * whose `section` property matches `section`.
 *
 * The story's rule is "locate by the `source` string literal, then take the
 * enclosing `{ ... }` span". The extra `section` filter is what keeps two
 * same-text steps in different scopes — a main-flow one and a `### Checkout`
 * one — from rewriting each other.
 */
/**
 * The text of one entry as it stands in a file — the `{ ... }` span that
 * binds to (source, section, occurrence).
 *
 * The repair prompt needs the code that failed, and the only faithful copy
 * of it is the author's own file: the loader hands back a live object whose
 * `run` has been through esbuild, which is not what anyone wrote.
 * Undefined when the file has no such entry.
 */
export function entryTextIn(
  fileContents: string,
  source: string,
  section: string | undefined,
  occurrence = 0,
): string | undefined {
  const span = findEntrySpans(scan(fileContents), source, section)[occurrence];
  return span ? fileContents.slice(span.start, span.end) : undefined;
}
export function findEntrySpans(
  s: Scan,
  source: string,
  section: string | undefined,
): Array<{ start: number; end: number }> {
  const wanted = source.trim();
  const wantedScope = section ? matchText(section) : '';
  const spans: Array<{ start: number; end: number }> = [];
  const seen = new Set<number>();

  for (const token of s.strings) {
    if (token.value.trim() !== wanted) continue;
    const span = enclosingBraceSpan(s, token.start);
    if (!span || seen.has(span.start)) continue;
    // The literal must actually be this object's `source`, not (say) a string
    // inside its `run` body that happens to repeat the step text.
    if (objectStringProperty(s, span.start, span.end, 'source')?.trim() !== wanted) continue;
    const entryScope = objectStringProperty(s, span.start, span.end, 'section');
    if ((entryScope ? matchText(entryScope) : '') !== wantedScope) continue;
    seen.add(span.start);
    spans.push(span);
  }
  return spans;
}

/**
 * The `source` of every entry in a file, in file order, each paired with its
 * `section` scope — the identity an entry binds by. What the review guard
 * compares before and after a revision: a reviewer may edit an entry's code,
 * never the set of entries.
 */
export function listEntries(src: string): Array<{ source: string; section: string }> {
  const s = scan(src);
  const seen = new Set<number>();
  const out: Array<{ source: string; section: string }> = [];
  for (const token of s.strings) {
    const span = enclosingBraceSpan(s, token.start);
    if (!span || seen.has(span.start)) continue;
    const source = objectStringProperty(s, span.start, span.end, 'source');
    if (source === undefined || source.trim() !== token.value.trim()) continue;
    seen.add(span.start);
    const section = objectStringProperty(s, span.start, span.end, 'section');
    out.push({ source: source.trim(), section: section ? matchText(section) : '' });
  }
  return out;
}

/** Index of the `]` closing the `defineSteps([...])` array, or -1. */
function arrayCloseIndex(s: Scan): number {
  const call = findCodeIdentifier(s, 'defineSteps');
  if (call === -1) return -1;
  let open = -1;
  for (let i = call + 'defineSteps'.length; i < s.src.length; i++) {
    if (s.mask[i] !== CODE) continue;
    const c = s.src[i]!;
    if (/\s/.test(c) || c === '(') continue;
    if (c === '[') { open = i; break; }
    return -1;
  }
  if (open === -1) return -1;
  return matchForward(s, open, '[', ']');
}

/** First `name` that is real code, a whole word, and immediately called — so
 *  the header comment and the `import { defineSteps }` binding are skipped. */
function findCodeIdentifier(s: Scan, name: string): number {
  const isWord = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);
  let from = 0;
  for (;;) {
    const at = s.src.indexOf(name, from);
    if (at === -1) return -1;
    if (
      s.mask[at] === CODE &&
      !isWord(s.src[at - 1]) &&
      !isWord(s.src[at + name.length]) &&
      isCallSite(s, at + name.length)
    ) {
      return at;
    }
    from = at + name.length;
  }
}

/** True when the next significant code character after `pos` is `(`. */
function isCallSite(s: Scan, pos: number): boolean {
  for (let i = pos; i < s.src.length; i++) {
    if (s.mask[i] !== CODE) continue;
    if (/\s/.test(s.src[i]!)) continue;
    return s.src[i] === '(';
  }
  return false;
}

/**
 * Stamp the `section` field the runner decided onto a generated entry,
 * replacing whatever the model may have emitted. Scope is never the model's
 * to choose.
 */
export function stampSection(entryCode: string, section: string | undefined): string {
  let text = entryCode.trim().replace(/[,;]+$/, '').trim();
  if (!text.startsWith('{')) {
    throw new Error(
      `Generated code-behind entry must be an object literal, got: ${text.slice(0, 60)}`,
    );
  }

  const close = matchForward(scan(text), 0, '{', '}');
  if (close === -1) throw new Error('Generated code-behind entry has unbalanced braces');
  text = text.slice(0, close + 1);

  const existing = findSectionPropertySpan(scan(text));
  if (existing) text = text.slice(0, existing.start) + text.slice(existing.end);
  if (section === undefined) return normalise(text);

  return normalise(`{\n  section: ${JSON.stringify(section)},${text.slice(1)}`);
}

/** Span of the entry object's own `section: '...'` property — the key through
 *  its trailing comma — or null when it has none. Depth-checked, so a
 *  `section:` inside the `run` body is never the answer. */
function findSectionPropertySpan(s: Scan): { start: number; end: number } | null {
  for (const token of s.strings) {
    if (token.start <= 0) continue;
    if (codeDepthBetween(s, 0, token.start) !== 1) continue;
    const colon = prevSignificant(s, token.start);
    if (colon === -1 || s.src[colon] !== ':') continue;
    const keyEnd = prevSignificant(s, colon);
    if (keyEnd === -1) continue;
    let keyStart = keyEnd;
    while (keyStart > 0 && /[\w$]/.test(s.src[keyStart - 1]!)) keyStart--;
    if (s.src.slice(keyStart, keyEnd + 1) !== 'section') continue;
    // Extend past a trailing comma and the rest of that line, so the removal
    // leaves no dangling `,` and no blank line behind.
    let end = token.end;
    while (end < s.src.length && /[ \t]/.test(s.src[end]!)) end++;
    if (s.src[end] === ',') end++;
    while (end < s.src.length && /[ \t]/.test(s.src[end]!)) end++;
    if (s.src[end] === '\n') end++;
    return { start: keyStart, end };
  }
  return null;
}

/** Index of the nearest significant code character before `pos`, or -1. */
function prevSignificant(s: Scan, pos: number): number {
  for (let i = pos - 1; i >= 0; i--) {
    if (s.mask[i] !== CODE) continue;
    if (/\s/.test(s.src[i]!)) continue;
    return i;
  }
  return -1;
}

/** Collapse to LF and drop trailing whitespace on each line. */
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
}

/** Prefix every line (including the first) with `pad`. */
function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n');
}

/** The leading whitespace of the line containing `pos`. */
function indentOfLineAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, pos));
  return match?.[0] ?? '';
}

/** Best-effort write that never propagates — generation must not fail a step
 *  that already passed. */
export async function tryWriteCodeBehindEntry(
  request: WriteEntryRequest,
): Promise<WriteEntryAction | null> {
  try {
    return await writeCodeBehindEntry(request);
  } catch (err) {
    logger.warn(
      `Could not write code-behind for "${request.source}": ${(err as Error).message}`,
    );
    return null;
  }
}
