/**
 * The Runner UI's skip sentence, and its parity with TestBench's.
 *
 * A step that never ran wears one glyph and one sentence everywhere
 * (stories/control-flow.md §"TestBench paints one skip"). That claim was true
 * of the six TestBench surfaces and false of the fourth client: the Electron
 * Runner UI printed `— Step 5 skipped: Skipped: another branch of this
 * decision was taken` — a different glyph, a different separator, a
 * capitalised "Step", and the word "skipped" twice — because the merge joined
 * one parent's reason to the other parent's formatting and nobody read the
 * result out loud.
 *
 * `src/ui/step-skip.ts` is a MIRROR of
 * `testbench-native/src/extension/step-skip-core.ts`: the two live in
 * different packages and neither may import the other, which is the same
 * situation `failure-text-inline.js` is in and is pinned by the same kind of
 * test. This is that test for this pair — and it is a real one, reading both
 * files, because the mirrored halves are exactly the things a reword breaks
 * silently.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKIP_GLYPH, skipLogLine } from '../src/ui/step-skip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.join(HERE, '..', rel), 'utf-8');

describe('the Runner UI wears the same skip mark as every other surface', () => {
  it('is the one hollow circle, by codepoint', () => {
    expect(SKIP_GLYPH.codePointAt(0)).toBe(0x25cc);
    // The original, read off disk rather than imported: `step-skip-core.ts`
    // belongs to the extension's package and importing it here would pull
    // that build's module resolution into this suite.
    const core = read('testbench-native/src/extension/step-skip-core.ts');
    const declared = /export const SKIP_GLYPH = '(.)'/.exec(core)?.[1];
    expect(declared).toBe(SKIP_GLYPH);
  });

  it('paints that glyph in the editor gutter, not the old minus', () => {
    const editor = read('src/ui/renderer/components/Editor.tsx');
    // The marker used to hard-code U+2212. It now takes the shared constant,
    // so a reword of the glyph moves all four surfaces at once.
    expect(editor).toContain('el.textContent = SKIP_GLYPH');
    expect(editor).not.toContain("textContent = '−'");
  });

  it('the renderer builds its log line rather than writing one', () => {
    const app = read('src/ui/renderer/App.tsx');
    expect(app).toContain('skipLogLine(data.stepIndex, data.reason)');
    // The hand-rolled sentence is gone. Its shape — an em dash, a capitalised
    // "Step", a colon before the reason — is what drifted.
    expect(app).not.toContain('— Step ${data.stepIndex} skipped');
  });
});

describe('the sentence itself', () => {
  it('says the glyph, the step and the reason, in that order', () => {
    expect(skipLogLine(5, 'Not run: step 3 returned from "Sign in"')).toBe(
      '◌ Step 5 skipped — Not run: step 3 returned from "Sign in"',
    );
  });

  it('does not repeat the word the line already said', () => {
    // `skipReasonFor` writes a standalone sentence because what holds it is a
    // report CELL, which has no glyph beside it. Pasted here it stuttered.
    expect(skipLogLine(5, 'Skipped: another branch of this decision was taken')).toBe(
      '◌ Step 5 skipped — another branch of this decision was taken',
    );
    expect(skipLogLine(5, 'skipped:   the list was empty')).toBe(
      '◌ Step 5 skipped — the list was empty',
    );
  });

  it('leaves a mid-sentence mention of the word alone', () => {
    // The strip is anchored, so only the label goes.
    expect(skipLogLine(5, 'The loop was skipped: it ran no passes')).toBe(
      '◌ Step 5 skipped — The loop was skipped: it ran no passes',
    );
  });

  it('never trails a dash with nothing after it', () => {
    // Four ways to arrive with nothing to say, including a reason that is
    // only the label the strip removes.
    for (const reason of [undefined, '', '   ', 'Skipped:', 'Skipped:  ']) {
      expect(skipLogLine(5, reason)).toBe('◌ Step 5 skipped');
    }
  });
});

describe('parity with the module it mirrors', () => {
  it('strips the same prefix, in the same way', () => {
    // Compared as SOURCE, because the two `because()` helpers are private to
    // their modules and a behavioural comparison would need both packages
    // loaded. The regex is the whole of the shared rule.
    const core = read('testbench-native/src/extension/step-skip-core.ts');
    const ui = read('src/ui/step-skip.ts');
    const inline = read('testbench-native/src/webview/lib/failure-text-inline.js');
    const strip = /replace\(\s*\/\^skipped\\s\*:\\s\*\/i\s*,\s*['"]{2}\s*\)/;
    for (const [name, text] of [
      ['step-skip-core.ts', core],
      ['src/ui/step-skip.ts', ui],
      ['failure-text-inline.js', inline],
    ] as const) {
      expect(strip.test(text), `${name} does not strip the report-cell prefix`).toBe(true);
    }
  });

  it('treats a blank reason as absent, in all three copies', () => {
    const blank = /reason\?\.trim\(\)/;
    expect(blank.test(read('testbench-native/src/extension/step-skip-core.ts'))).toBe(true);
    expect(blank.test(read('src/ui/step-skip.ts'))).toBe(true);
    expect(blank.test(read('testbench-native/src/webview/lib/failure-text-inline.js'))).toBe(true);
  });
});
