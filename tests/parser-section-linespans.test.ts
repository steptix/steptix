import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTestContent, scanStepSpans } from '../src/parser/markdown.js';
import { matchText } from '../src/parser/section-match.js';

/**
 * The two-pass alignment, isolated.
 *
 * `parseSections` zips text from the marked token walk against lines and
 * section membership from the raw scan, pairing them by index. Once the raw
 * text is the *match* side, a one-off shift stops being a cosmetic
 * line-number bug and starts flipping which steps count as section calls — so
 * for a file that defines sections the correspondence must hold exactly, and
 * a mismatch throws rather than guessing.
 *
 * Perfect replication is impossible in general (the raw scan sees text where
 * marked sees rendered tokens), which is precisely why these cases are pinned
 * individually: each one either must agree, or must be a loud failure.
 */

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sections',
);

/** A file that defines a section, so the strict assert applies. */
const sectioned = (body: string[]): string =>
  ['# T', '', '## Steps', ...body, '', '### S', '1. Section body'].join('\n');

/** The same body with no section defined — historic lenient path. */
const sectionless = (body: string[]): string => ['# T', '', '## Steps', ...body].join('\n');

describe('cull rules agree between the two passes', () => {
  it('drops a numbered item with no content from both passes', () => {
    // `4.` matches neither STEP_LINE_RE (no content) nor survives marked's
    // empty-text cull, so both passes skip it and the counts still agree.
    const md = sectioned(['1. One', '4.', '2. Two']);
    const parsed = parseTestContent(md);
    expect(parsed.steps).toEqual(['One', 'Two']);
    expect(scanStepSpans(md, 't.md').entries.filter((e) => e.sectionIndex === null)).toHaveLength(2);
  });

  it('drops a marker-only item from both passes', () => {
    // `[no-hooks]` with nothing after it cleans to empty text. marked culls on
    // the cleaned value; the raw scan replicates that cull explicitly, or the
    // arrays would shift by one from here on.
    const md = sectioned(['1. One', '2. [no-hooks]', '3. Two']);
    const parsed = parseTestContent(md);
    expect(parsed.steps).toEqual(['One', 'Two']);
    expect(parsed.rawSteps).toEqual(['One', 'Two']);
  });

  it('keeps a formatted marker in both passes (it is not a real marker)', () => {
    // NO_HOOKS_MARKER is anchored, so `**[no-hooks]**` does not match it on
    // either side: the item survives, un-stripped, and stays hook-wrapped.
    const md = sectioned(['1. **[no-hooks]** Still a step']);
    const parsed = parseTestContent(md);
    expect(parsed.steps).toEqual(['**[no-hooks]** Still a step']);
    expect(parsed.rawSteps).toEqual(['**[no-hooks]** Still a step']);
    expect(parsed.skipHooks).toEqual([false]);
  });

  it('pins the tight-vs-loose extractPlainText difference', () => {
    // Load-bearing, and the reason contract §2.3 exists. marked only emits a
    // `paragraph` token — the branch extractPlainText recurses through to
    // resolve `**` — for a LOOSE list (blank lines between items). In a tight
    // list it short-circuits on the raw inline source.
    //
    // Consequence: in a tight list `steps[i] === rawSteps[i]`, so the obvious
    // "does `**Login**` call `### Login`?" test passes whether or not the
    // implementation reads the correct array. That test is a no-op; the real
    // guard is the {{param}} scenario in the expander suite.
    const tight = parseTestContent(sectioned(['1. **Login**', '2. Other']));
    expect(tight.steps[0]).toBe('**Login**');
    expect(tight.rawSteps[0]).toBe('**Login**');

    const loose = parseTestContent(sectioned(['1. **Login**', '', '2. Other']));
    expect(loose.steps[0]).toBe('Login');
    expect(loose.rawSteps[0]).toBe('**Login**');
  });

  it('keeps prose between steps out of both passes', () => {
    const md = sectioned(['1. One', '', 'Some prose.', '', '2. Two']);
    expect(parseTestContent(md).steps).toEqual(['One', 'Two']);
  });

  it('keeps #### noise inside a body out of both passes', () => {
    const md = ['# T', '', '## Steps', '1. Call', '', '### S', '1. A', '', '#### Note', '', '2. B'].join('\n');
    // Both passes must drop the SAME items or the zip below them throws
    // its step/line mismatch: B is inert in each (contract §5 rule 4a). The
    // `####` neither closes S nor opens a section of its own.
    const parsed = parseTestContent(md);
    expect(parsed.sections['s']!.steps).toEqual(['A']);
    expect(Object.keys(parsed.sections)).toEqual(['s']);
    expect(scanStepSpans(md, 't.md').entries.map((e) => e.raw)).toEqual(['Call', 'A']);
  });
});

describe('genuine divergences fail loudly for sectioned files', () => {
  it('throws when a fenced code block contains a numbered line', () => {
    // marked sees a code block; the raw scan sees a step. This is the one
    // divergence that cannot be reconciled by replicating cull rules.
    const md = sectioned(['1. One', '', '```text', '1. not a step', '```', '', '2. Two']);
    expect(() => parseTestContent(md, '/t/fenced.md')).toThrow(/Step\/line mismatch in \/t\/fenced\.md/);
    expect(() => parseTestContent(md, '/t/fenced.md')).toThrow(/fenced code block/i);
  });

  it('reports both counts so the direction of the skew is visible', () => {
    const md = sectioned(['1. One', '', '```text', '1. not a step', '```']);
    expect(() => parseTestContent(md)).toThrow(/found 2 step\(s\).*found 3/s);
  });

  it('throws on the shared edge fixture, which exists to carry this case', () => {
    const md = readFileSync(path.join(FIXTURES, 'classification-edge.md'), 'utf-8');
    expect(() => parseTestContent(md, 'classification-edge.md')).toThrow(/Step\/line mismatch/);
  });

  it('throws when two divergences cancel out and the counts still match', () => {
    // The case a bare count check cannot see, and the worst one to miss.
    // A fenced numbered line the raw scan counts (+1), plus a 3-space-indented
    // item marked counts and the anchored STEP_LINE_RE does not (+1) — equal
    // totals, completely different pairing.
    //
    // Before the per-index check this parsed "successfully": rawSteps[1]
    // became "Login" (lifted out of the code fence) while steps[1] was the
    // author's real instruction, so the step resolved to `### Login`, ran that
    // body instead, and dropped the real instruction silently. rawSteps is the
    // match side, which is exactly why alignment has to be exact here.
    const md = [
      '# T', '', '## Steps', '',
      '1. Open the app', '',
      '```', '1. Login', '```', '',
      '   2. Delete the production database', '',
      '### Login', '',
      '1. Type the username',
    ].join('\n');

    expect(() => parseTestContent(md, '/t/cancel.md')).toThrow(/Step\/line mismatch/);
    // Names both readings so the author can see which pass drifted.
    expect(() => parseTestContent(md, '/t/cancel.md')).toThrow(
      /read "Delete the production database" where the line scanner read "Login"/,
    );
  });

  it('accepts a formatting-only difference between the passes', () => {
    // The one legitimate divergence: in a LOOSE list extractPlainText unwraps
    // emphasis, so steps[i] and the raw line differ by `**`. That must not
    // trip the alignment check.
    const md = sectioned(['1. **Bold step**', '', '2. `code step`']);
    expect(() => parseTestContent(md)).not.toThrow();
    const parsed = parseTestContent(md);
    expect(parsed.steps).toEqual(['Bold step', 'code step']);
    expect(parsed.rawSteps).toEqual(['**Bold step**', '`code step`']);
  });

  it('accepts constructs extractPlainText passes through verbatim', () => {
    // Links, images, escapes and entities all reach extractPlainText's
    // `'raw' in token` fallback, so both readings are byte-identical. Widened
    // beyond bold/code because the check is coupled to extractPlainText's
    // branch list, and a construct moving between branches must not silently
    // start rejecting valid files.
    const md = sectioned([
      '1. Open [the docs](https://example.test "title")',
      '',
      '2. Compare A &amp; B in <https://example.test>',
      '',
      '3. Escaped \\*not bold\\* and user_id',
    ]);
    expect(() => parseTestContent(md)).not.toThrow();
  });

  it('rejects drift that only differs by formatting or internal whitespace', () => {
    // These are the cases a normalising tripwire would wave through while
    // matchText still treats them as different — the gap that lets a step
    // resolve to a section the author never called. Each mirrors a frozen
    // match-table row asserting `matches: false`.
    for (const [authored, section] of [
      ['Login as  admin', 'Login as admin'],
      ['**Login**', 'Login'],
      ['`Login`', 'Login'],
      ['LOGIN', 'Login'],
    ]) {
      const md = [
        '# T', '', '## Steps', '',
        '1. Open', '',
        '```', `1. ${section}`, '```', '',
        `   2. ${authored}`, '',
        `### ${section}`, '',
        '1. body',
      ].join('\n');
      expect(() => parseTestContent(md, '/t/drift.md')).toThrow(/Step\/line mismatch/);
    }
  });
});

describe('multi-line list items', () => {
  // A list item may span several physical lines. marked folds the whole item
  // into one step; the raw scan only ever sees the first line. Legitimate
  // markdown, so it must not be refused — but the scanned text is then a
  // TRUNCATION of the step, which is its own hazard (below).
  it.each([
    ['wrapped, continuation indented', ['1. Click the Save button and then', '   verify the toast appears', '2. Done']],
    ['wrapped, continuation flush', ['1. Click the Save button and then', 'verify the toast appears', '2. Done']],
    ['hard line break', ['1. Click Save  ', '   then verify', '2. Done']],
    ['multi-paragraph item', ['1. First para', '', '   Second para', '2. Done']],
    ['nested bullet list', ['1. Do these', '   - a', '   - b', '2. Done']],
    ['blockquote inside the item', ['1. Note this', '   > quoted', '2. Done']],
    ['fenced block inside the item', ['1. Run it', '   ```', '   code', '   ```', '2. Done']],
  ])('accepts a sectioned file with %s', (_label, body) => {
    expect(() => parseTestContent(sectioned(body as string[]))).not.toThrow();
  });

  it('matches a continued step on its full text, never the truncated first line', () => {
    // The trap in the obvious fix. Relaxing the check without switching the
    // match side leaves `rawSteps[0]` as the bare "Login", which resolves to
    // `### Login` and silently drops the rest of the author's instruction —
    // the same failure class as a cancelling divergence, reached through the
    // multi-line door.
    const md = [
      '# T', '', '## Steps',
      '1. Login',
      '   and then confirm the dashboard shows the correct tenant',
      '2. Done', '',
      '### Login',
      '1. SECTION BODY RAN',
    ].join('\n');

    const parsed = parseTestContent(md, '/t/continued.md');
    expect(parsed.rawSteps[0]).toContain('confirm the dashboard');
    expect(matchText(parsed.rawSteps[0]!)).not.toBe('login');
    // And end-to-end: the section must not run in place of the real step.
    expect(parsed.steps[0]).toContain('confirm the dashboard');
  });

  it('does not let an empty loose reading disable the drift check', () => {
    // A codespan of only whitespace lexes to empty text, and
    // `startsWith('')` is true of everything — so an unguarded prefix test
    // would classify ANY drift at that index as a continuation and wave it
    // through. The line is itself a genuine divergence (marked culls it, the
    // scan keeps it), so it must reach `drift`.
    const md = [
      '# T', '', '## Steps', '',
      '1. Open',
      '2. ` `', '',
      '   3. Indented', '',
      '4. Close', '',
      '### Login',
      '1. body',
    ].join('\n');
    expect(() => parseTestContent(md, '/t/degenerate.md')).toThrow(/Step\/line mismatch/);
  });

  it('still resolves a genuine single-line call alongside continued steps', () => {
    const md = [
      '# T', '', '## Steps',
      '1. Login',
      '2. Something long that wraps onto',
      '   a second line', '',
      '### Login',
      '1. body',
    ].join('\n');
    const parsed = parseTestContent(md);
    expect(matchText(parsed.rawSteps[0]!)).toBe('login');
    expect(matchText(parsed.rawSteps[1]!)).not.toBe('login');
  });
});

describe('files without sections keep the historic lenient behaviour', () => {
  it('does not throw on the same fenced-block skew', () => {
    // Goal 4: every file written before this feature parses exactly as it did.
    // The skew misattributes a line number, as it always has — but it is not
    // an error, because no section call decision depends on it.
    const md = sectionless(['1. One', '', '```text', '1. not a step', '```', '', '2. Two']);
    expect(() => parseTestContent(md)).not.toThrow();
    expect(parseTestContent(md).steps).toEqual(['One', 'Two']);
  });

  it('falls back to line 0 when the raw scan finds fewer entries than marked', () => {
    // An unordered list is a step to marked and invisible to the raw scan,
    // which only recognises `N.` syntax. Pinned as-is: pre-existing behaviour.
    const md = sectionless(['- One', '- Two']);
    const parsed = parseTestContent(md);
    expect(parsed.steps).toEqual(['One', 'Two']);
    expect(parsed.stepLines).toEqual([0, 0]);
  });
});

describe('alignment holds across a mixed document', () => {
  it('pairs every step with its own line and raw text', () => {
    const md = [
      '---', 'type: test', '---', '',
      '# T', '', '## Steps',
      '1. First',
      '',
      'Prose that is not a step.',
      '',
      '2. [no-hooks] Second',
      '3.',
      '',
      '### Helper',
      '',
      '1. Helper one',
      '',
      '#### Inert',
      '',
      '2. Helper two',
    ].join('\n');
    const parsed = parseTestContent(md);

    expect(parsed.steps).toEqual(['First', 'Second']);
    expect(parsed.stepLines).toEqual([8, 12]);
    expect(parsed.rawSteps).toEqual(['First', '[no-hooks] Second']);
    expect(parsed.skipHooks).toEqual([false, true]);

    const helper = parsed.sections['helper']!;
    expect(helper.headingLine).toBe(15);
    // `#### Inert` on line 19 opens an ignored region, so "Helper two" on
    // line 21 is not one of Helper's steps.
    expect(helper.steps).toEqual(['Helper one']);
    expect(helper.stepLines).toEqual([17]);
    expect(helper.rawSteps).toEqual(['Helper one']);
  });
});
