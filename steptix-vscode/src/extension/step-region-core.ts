/**
 * Where a step could be authored in a test file — vscode-free, so the fence
 * and region logic is unit-testable under `node --test`.
 *
 * Completion consumes this to decide whether to offer section names. The
 * subtlety it handles: `classifyLines` does not track fenced code blocks, so a
 * numbered line inside a fence within the `## Steps` span classifies as a
 * `step` and looks live. A separate delimiter scan catches that.
 */
import { classifyLines } from 'steptix-runner-core';

/** A ```` ``` ````/`~~~` fence delimiter line (any indent, any info string). */
export function isFenceDelimiter(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/**
 * Whether 0-based `lineIdx` is inside a fenced code block, by counting
 * delimiters from the top.
 *
 * Deliberately naive — it does not match opening/closing fence lengths or
 * types (a CommonMark nicety). Two consequences, both cosmetic and confined
 * to already-unusual documents:
 *
 *  - a `~~~` fence "closed" by ``` ``` ```` (mismatched types) reads as closed
 *    here, so a completion could fire inside it;
 *  - an unclosed fence marks the rest of the file as inside, suppressing
 *    completion there.
 *
 * The cost either way is only a spurious or missing completion dropdown in
 * example code, never a wrong diagnostic, link, or run.
 */
export function isInsideFence(text: string, lineIdx: number): boolean {
  const lines = text.split(/\r?\n/);
  let open = false;
  for (let i = 0; i < lineIdx; i++) {
    if (isFenceDelimiter(lines[i] ?? '')) open = !open;
  }
  return open;
}

/**
 * Whether 0-based `lineIdx` sits where a step could be authored — inside a
 * `## Steps` span (or a section body within it), and NOT inside a fence.
 *
 * A step being typed classifies as `prose` until it has content, so this
 * cannot look at the line's own kind. It infers the region from the nearest
 * non-blank classified line above: a step, section-step or section-heading
 * means we are in the step region; any other heading or prose means we are
 * not. Fenced lines are skipped in that walk (they are not real ancestors)
 * and rejected outright for the cursor line itself.
 */
export function inStepRegion(text: string, lineIdx: number): boolean {
  if (isInsideFence(text, lineIdx)) return false;

  const classified = classifyLines(text);
  const lines = text.split(/\r?\n/);
  for (let i = lineIdx - 1; i >= 0; i--) {
    if (isInsideFence(text, i) || isFenceDelimiter(lines[i] ?? '')) continue;
    const kind = classified[i]?.kind;
    if (kind === 'blank') continue;
    if (kind === 'step' || kind === 'section-step' || kind === 'section-heading') return true;
    if (kind === 'heading' && /^#{2,}\s+steps\s*$/i.test(lines[i] ?? '')) return true;
    return false;
  }
  return false;
}
