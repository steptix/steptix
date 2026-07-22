import { describe, it, expect } from 'vitest';
import { parseTestContent } from '../src/parser/markdown.js';
import { buildSectionIndex } from '../runner-core/dist/section-index.js';
import { extractSections, findWrappedStepLines } from '../runner-core/dist/step-lines.js';
import { matchText } from '../src/parser/section-match.js';

/**
 * The editor's view of "what is a call" vs the runtime's.
 *
 * Contract §2.4 promises these can never disagree — the authoring layer's
 * links and "never used" diagnostic are built on `buildSectionIndex`, while
 * execution is decided by the CLI parser and expander. They share no code:
 * runner-core scans lines, the CLI runs steps through `marked`. This file is
 * the only thing holding them together.
 *
 * The two directions are NOT equally bad, and the suite is built around that:
 *
 *  - **index claims a call the CLI does not make** — the dangerous one. The
 *    editor underlines the step, go-to-definition works, no warning appears,
 *    and the section never runs. Asserted to never happen.
 *  - **CLI calls where the index does not** — cosmetic. No link, and a
 *    spurious "never used" warning, on a call that still works. Tolerated,
 *    counted, and pinned to the known shapes below so the count cannot grow
 *    unnoticed.
 *
 * The gap between them exists because a markdown list item may wrap across
 * lines while this index sees only the item's first line. `stepWrapsAt` in
 * runner-core/src/step-lines.ts is the whitelist that keeps every inaccuracy
 * on the harmless side; `buildSectionIndex` and `findWrappedStepLines` are
 * both built on it, so fuzzing here exercises the one shared rule.
 */

const SECTION = 'Login';

/** Build a document with `after` inserted directly below the call site. */
const doc = (after: string[]): string =>
  ['## Steps', '', `1. ${SECTION}`, ...after, '', `### ${SECTION}`, '', '1. Type the username'].join(
    '\n',
  );

/**
 * Does the CLI resolve step 0 as a call? Null when it refuses the file.
 *
 * A refused document is excluded from the comparison rather than required to
 * index as a non-call. The CLI's alignment guard is CLI-only — the server
 * receives steps already split and never runs it — so on a refused document
 * the CLI simply has no opinion to disagree with. Requiring `index === false`
 * there would be asserting something this index does not promise; refusing
 * such files is the pre-flight's job, not the index's.
 */
function cliCalls(text: string): boolean | null {
  try {
    const parsed = parseTestContent(text, 'parity.md');
    const raw = parsed.rawSteps[0] ?? '';
    return matchText(raw) === matchText(SECTION);
  } catch {
    return null;
  }
}

const indexCalls = (text: string): boolean =>
  buildSectionIndex(text).calls.some((c) => c.line === 3);

/**
 * Every continuation shape, with marked's real answer measured rather than
 * assumed. `agree: false` rows are the accepted conservative losses.
 */
const SHAPES: { name: string; after: string[]; agree: boolean }[] = [
  { name: 'nothing after', after: [], agree: true },
  { name: 'next step', after: ['2. Next'], agree: true },
  { name: 'indented prose immediately', after: ['   cont'], agree: true },
  { name: 'unindented prose immediately (lazy continuation)', after: ['cont'], agree: true },
  { name: 'indented bullet immediately', after: ['   - detail'], agree: true },
  { name: 'unindented bullet immediately', after: ['- detail'], agree: true },
  { name: 'blank then indented prose', after: ['', '   cont'], agree: true },
  { name: 'blank then unindented prose', after: ['', 'cont'], agree: true },
  { name: 'blank then indented bullet', after: ['', '   - detail'], agree: true },
  { name: 'blank then step', after: ['', '2. Next'], agree: true },
  { name: 'blank then bare ordinal', after: ['', '4.'], agree: true },
  { name: 'heading immediately', after: ['#### H'], agree: true },
  { name: 'tab-indented prose immediately', after: ['\tcont'], agree: true },
  { name: 'one-space-indented prose immediately', after: [' cont'], agree: true },

  // Block constructs that marked does NOT fold into the item but that the
  // whitelist conservatively treats as folding. Each is a real call the index
  // declines to link — cosmetic, and the accepted price of not reimplementing
  // markdown's block grammar. Listed by name so that a change turning one
  // into agreement has to update this table deliberately.
  { name: 'bare ordinal immediately', after: ['4.'], agree: false },
  { name: 'bare ordinal then a step', after: ['4.', '2. Next'], agree: false },
  { name: 'blank then one-space-indented prose', after: ['', ' cont'], agree: false },
  { name: 'fenced block opening immediately', after: ['```', 'x', '```'], agree: false },
  { name: 'blockquote immediately', after: ['> quoted'], agree: false },
  { name: 'HTML comment immediately', after: ['<!-- c -->'], agree: false },
  { name: 'HTML block immediately', after: ['<div>x</div>'], agree: false },
  { name: 'thematic break immediately', after: ['***'], agree: false },

  // The other side of that coin: constructs that DO fold, and so are
  // correctly refused. Without these the table would only prove the
  // whitelist is lenient, not that it is right.
  { name: 'table row immediately (folds)', after: ['| a | b |'], agree: true },
  { name: 'setext underline immediately (folds)', after: ['==='], agree: true },
  { name: 'indented code immediately (folds)', after: ['    code'], agree: true },
  { name: 'link reference immediately (folds)', after: ['[r]: http://x'], agree: true },
];

describe('buildSectionIndex vs the CLI parser', () => {
  for (const shape of SHAPES) {
    it(`${shape.agree ? 'agrees' : 'is conservative'}: ${shape.name}`, () => {
      const text = doc(shape.after);
      const cli = cliCalls(text);
      const index = indexCalls(text);

      if (cli === null) {
        // Refused by the CLI — see `cliCalls`. Nothing to compare.
        return;
      }

      // The invariant, in both branches: never claim a call the CLI won't make.
      if (index) expect(cli).toBe(true);
      expect(index === cli).toBe(shape.agree);
    });
  }

  it('every accepted loss is genuinely in the safe direction', () => {
    // The count itself is not the point and is expected to grow as more
    // non-folding constructs are found. What must hold for every one of them
    // is the direction: the CLI calls, the index does not.
    expect(SHAPES.filter((s) => !s.agree).length).toBeGreaterThan(4);
    for (const shape of SHAPES.filter((s) => !s.agree)) {
      const text = doc(shape.after);
      expect(cliCalls(text)).toBe(true);
      expect(indexCalls(text)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Fuzz
// ---------------------------------------------------------------------------

/**
 * A hand-written table only covers shapes someone thought of.
 *
 * An earlier version of this generator only ever appended filler *between* a
 * fixed main-flow call site and a fixed section, which meant it could never
 * produce a body call site, frontmatter, CRLF, a multi-digit ordinal, a
 * `[no-hooks]` call, or a section defined before the call — and its
 * "conservative > 0" guard was carried by a single document. This one varies
 * all of that.
 */
function* generate(seedCount: number): Generator<string> {
  const FILLER = [
    '2. Next step',
    '   continuation line',
    'lazy continuation',
    '',
    '   - nested bullet',
    '4.',
    '#### Inert heading',
    'Some prose.',
    '\ttab continuation',
    ' one space',
    '10. [no-hooks] Marked step',
    '```',
    '> quoted',
    '<!-- comment -->',
    '   1. indented ordinal',
  ];
  const CALL_FORMS = [
    `1. ${SECTION}`,
    `10. ${SECTION}`,
    `1. [no-hooks] ${SECTION}`,
    `3. ${SECTION.toUpperCase()}`,
  ];

  // Deterministic LCG: a fixed corpus is reproducible from a failure message,
  // and Math.random would make a failing run impossible to re-run.
  let state = 20260723;
  const next = (n: number): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
  const filler = (n: number): string[] =>
    Array.from({ length: n }, () => FILLER[next(FILLER.length)]!);

  for (let s = 0; s < seedCount; s++) {
    const lines: string[] = [];
    if (next(3) === 0) lines.push('---', 'type: test', '---', '');

    const sectionFirst = next(4) === 0;
    const section = ['', `### ${SECTION}`, '', '1. Type the username', ...filler(next(3))];
    const call = [`${CALL_FORMS[next(CALL_FORMS.length)]!}`, ...filler(1 + next(4))];

    lines.push('## Steps', '');
    if (sectionFirst) lines.push(...section, '', ...call);
    else lines.push(...call, ...section);

    // A second section whose body contains a call site — the class the old
    // generator could not reach at all.
    if (next(2) === 0) {
      lines.push('', '### Wrapper', '', `1. ${SECTION}`, ...filler(1 + next(3)));
    }

    yield lines.join(next(5) === 0 ? '\r\n' : '\n');
  }
}

/** Every call the index claims, as `line:name`. */
const allIndexCalls = (text: string): Set<string> =>
  new Set(buildSectionIndex(text).calls.map((c) => `${c.line}:${matchText(c.name)}`));

/**
 * Every call the CLI actually resolves, as `line:name`. Derived from the
 * parse rather than the expansion so it needs no skillsDir: a step is a call
 * iff its match text names a defined section.
 */
function allCliCalls(text: string): Set<string> | null {
  let parsed;
  try {
    parsed = parseTestContent(text, 'parity.md');
  } catch {
    return null;
  }
  const defined = new Set(Object.keys(parsed.sections));
  const out = new Set<string>();
  const add = (raw: string, line: number): void => {
    const key = matchText(raw);
    if (defined.has(key)) out.add(`${line}:${key}`);
  };
  parsed.rawSteps.forEach((raw, i) => add(raw, parsed.stepLines[i] ?? -1));
  for (const section of Object.values(parsed.sections)) {
    section.rawSteps.forEach((raw, i) => add(raw, section.stepLines[i] ?? -1));
  }
  return out;
}

describe('buildSectionIndex vs the CLI parser (fuzz)', () => {
  it('never claims a call the CLI does not make, anywhere in the document', () => {
    let compared = 0;
    let refused = 0;
    let conservative = 0;
    let indexCalled = 0;
    let bodyCalls = 0;
    const violations: string[] = [];

    for (const text of generate(4000)) {
      const cli = allCliCalls(text);
      if (cli === null) {
        refused++;
        continue;
      }
      const index = allIndexCalls(text);
      compared++;
      indexCalled += index.size;
      for (const call of index) {
        if (!cli.has(call)) violations.push(`index claims ${call}, CLI does not:\n${text}`);
      }
      for (const call of cli) {
        if (!index.has(call)) conservative++;
      }
      // Track that body call sites are actually being produced.
      if ([...cli].some((c) => Number(c.split(':')[0]) > 4)) bodyCalls++;
    }

    expect(violations.slice(0, 3)).toEqual([]);

    // The invariant above is "index implies CLI", which an index that never
    // says "call" satisfies for free. These guards are what stop this from
    // becoming a test that passes by proving nothing.
    expect(compared).toBeGreaterThan(500);
    expect(indexCalled).toBeGreaterThan(500);
    expect(conservative).toBeGreaterThan(20);
    expect(bodyCalls).toBeGreaterThan(50);

    // eslint-disable-next-line no-console
    console.log(
      `[section-index parity] compared=${compared} indexCalled=${indexCalled} ` +
        `refused=${refused} conservative=${conservative} withDeepCalls=${bodyCalls}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Body content — the same wrapped-item hazard, one level down
// ---------------------------------------------------------------------------

/**
 * `stepWrapsAt` stops the index drawing a link for a wrapped CALL SITE. The
 * same wrap breaks the body payload too, and worse: `extractSections` sends
 * one string per step, so a wrapped body item arrives at the server
 * truncated. When the truncation happens to equal a section name, the server
 * dispatches into that section while the CLI runs the literal instruction —
 * a silent change of control flow.
 *
 * That cannot be fixed by folding the continuation here without a fourth
 * hand-written copy of marked's list semantics, so the contract's rule is
 * detect-and-refuse (§3.2) and `findWrappedStepLines` is the detector. These
 * tests pin both halves: the divergence is real, and the detector sees it.
 */
describe('wrapped body steps are detected, not silently truncated', () => {
  const CASES: { name: string; text: string; wrapped: number[] }[] = [
    {
      name: 'wrapped body step',
      text: [
        '## Steps', '', '1. Sign in', '', '### Sign in', '', '1. Type the username',
        '   into the tenant field, then press Enter',
      ].join('\n'),
      wrapped: [7],
    },
    {
      name: 'wrapped body step whose first line equals a section name',
      text: [
        '## Steps', '', '1. Checkout', '', '### Checkout', '', '1. Sign in',
        '   using the saved credentials', '2. Pay', '', '### Sign in', '', '1. Type',
      ].join('\n'),
      wrapped: [7],
    },
    {
      name: 'body step continued by a nested bullet',
      text: [
        '## Steps', '', '1. Go', '', '### Go', '', '1. Fill the form', '   - username: admin',
      ].join('\n'),
      wrapped: [7],
    },
    {
      name: 'control: nothing wrapped',
      text: ['## Steps', '', '1. Go', '', '### Go', '', '1. Fill the form', '2. Submit'].join('\n'),
      wrapped: [],
    },
  ];

  for (const testCase of CASES) {
    it(`detects: ${testCase.name}`, () => {
      expect(findWrappedStepLines(testCase.text)).toEqual(testCase.wrapped);
    });

    it(`the divergence is real: ${testCase.name}`, () => {
      // Compare what the client would send against what the CLI actually
      // runs. Where they differ, the detector must have flagged it — that is
      // the property the pre-flight relies on.
      const parsed = parseTestContent(testCase.text, 'parity.md');
      const detected = new Set(findWrappedStepLines(testCase.text));
      let sawDivergence = false;

      for (const section of extractSections(testCase.text)) {
        const cliSection = parsed.sections[matchText(section.name)];
        expect(cliSection).toBeDefined();
        section.steps.forEach((step, i) => {
          if (step.instruction === cliSection!.rawSteps[i]) return;
          sawDivergence = true;
          expect(detected.has(step.line)).toBe(true);
        });
      }

      expect(sawDivergence).toBe(testCase.wrapped.length > 0);
    });
  }

  it('the truncation really can change control flow, not just text', () => {
    // The case that makes this MAJOR rather than cosmetic: the client's
    // truncated body step is byte-equal to another section's name, so the
    // server would call it. The CLI would not.
    const text = CASES[1]!.text;
    const body = extractSections(text).find((s) => s.name === 'Checkout')!;
    const parsed = parseTestContent(text, 'parity.md');

    expect(body.steps[0]!.instruction).toBe('Sign in');
    expect(parsed.sections['checkout']!.rawSteps[0]).toBe(
      'Sign in\nusing the saved credentials',
    );
    // "Sign in" names a real section — so sending it would dispatch.
    expect(Object.keys(parsed.sections)).toContain('sign in');
    // And the detector flags the line, which is what lets the pre-flight
    // refuse the file instead.
    expect(findWrappedStepLines(text)).toContain(body.steps[0]!.line);
  });
});
