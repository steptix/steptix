import { describe, it, expect } from 'vitest';
import { parseTestContent } from '../src/parser/markdown.js';
// runner-core from `src/`, not `dist/`: the root build compiles neither, so a
// guard reading `dist/` can be asserting against bytes older than the source
// the extension bundles. Same reasoning as tests/data-rows-sections.test.ts.
import { buildSectionIndex } from '../runner-core/src/section-index.ts';
import { extractSections, findWrappedStepLines } from '../runner-core/src/step-lines.ts';
import { matchText } from '../src/parser/section-match.js';
import { expandSkills } from '../src/skills/expander.js';

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

/**
 * Shapes the CLI refuses outright, so it gives no answer for the index to
 * agree or disagree with (see `cliCalls`). Pinned as refused rather than
 * listed in SHAPES, where a refusal would pass with nothing compared: the
 * markdown parser and the line scanner count a different number of steps,
 * and the alignment guard turns that into a loud error.
 */
const REFUSED: { name: string; after: string[] }[] = [
  { name: 'unindented bullet immediately', after: ['- detail'] },
];

describe('buildSectionIndex vs the CLI parser', () => {
  for (const shape of SHAPES) {
    it(`${shape.agree ? 'agrees' : 'is conservative'}: ${shape.name}`, () => {
      const text = doc(shape.after);
      const cli = cliCalls(text);
      const index = indexCalls(text);

      // Every row's answer was measured against marked, so the CLI must give
      // one. `cliCalls` excuses a refused document for the fuzz, where one is
      // expected; here it would let a row pass with nothing compared.
      expect(cli, 'the CLI refused this row: re-measure it').not.toBeNull();

      // The invariant, in both branches: never claim a call the CLI won't make.
      if (index) expect(cli).toBe(true);
      expect(index === cli).toBe(shape.agree);
    });
  }

  for (const shape of REFUSED) {
    it(`is refused by the CLI: ${shape.name}`, () => {
      expect(() => parseTestContent(doc(shape.after), 'parity.md')).toThrow(
        /Step\/line mismatch/,
      );
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

// ---------------------------------------------------------------------------
// Control lines — the same question, one rung further down
// ---------------------------------------------------------------------------

/**
 * Which section a CONTROL line calls, taken from the expander itself.
 *
 * The set above (`allCliCalls`) reads only the parse, which is enough while
 * every call site is the whole step — but a control line's call site is its
 * TAIL, and that resolution happens during expansion. So this side is derived
 * from the frames `expandSkills` really builds: a `section` frame's
 * `invocationLine` is the line that called it, tail or not. Nothing here
 * restates the rule under test; it reports what ran.
 */
async function expandedSectionCalls(text: string): Promise<Set<string>> {
  const parsed = parseTestContent(text, 'parity.md');
  const expansion = await expandSkills(
    parsed.steps,
    undefined,
    undefined,
    'parity.md',
    parsed.stepLines,
    { sections: parsed.sections, rawSteps: parsed.rawSteps, warnDeadSections: false },
  );
  const out = new Set<string>();
  for (const frame of Object.values(expansion.frames)) {
    if (frame.kind !== 'section' || frame.invocationLine === null) continue;
    out.add(`${frame.invocationLine}:${matchText(frame.skillName ?? '')}`);
  }
  return out;
}

/**
 * A control line's call site is its TAIL — unless the whole line names a
 * section, in which case rung 2 makes it an ordinary call (decision 3 of
 * stories/control-flow.md).
 *
 * That order is the whole of this block. The index applied the control split
 * FIRST, so a section named `While waiting, keep the page open` was reported
 * never used while the runtime called it on every run, and the call site got a
 * "did you mean" squiggle naming a section that does not exist. Exactly the
 * divergence class this file exists for, and the hand-written table above
 * could not see it: it never writes a control line.
 */
const CONTROL_CASES: { name: string; lines: string[] }[] = [
  {
    name: 'a resolved tail is the call site',
    lines: [
      '## Steps',
      '',
      '1. If the Cash checkbox is ticked, then Pay with cash',
      '',
      '### Pay with cash',
      '',
      '1. Click Pay now',
    ],
  },
  {
    name: 'a section named after the whole While line is a call, tail or no tail',
    lines: [
      '## Steps',
      '',
      '1. While waiting, keep the page open',
      '',
      '### While waiting, keep the page open',
      '',
      '1. Click A',
    ],
  },
  {
    name: 'a section named after a whole Otherwise line',
    lines: [
      '## Steps',
      '',
      '1. Otherwise, Pay by card',
      '',
      '### Otherwise, Pay by card',
      '',
      '1. Click B',
    ],
  },
  {
    name: 'both readings resolve: the whole line wins',
    lines: [
      '## Steps',
      '',
      '1. If a, then Pay with cash',
      '',
      '### If a, then Pay with cash',
      '',
      '1. Click the whole-line section',
      '',
      '### Pay with cash',
      '',
      '1. Click Pay now',
    ],
  },
  {
    name: 'a claim that does not complete falls back to the whole line',
    lines: ['## Steps', '', '1. While waiting', '', '### While waiting', '', '1. Wait'],
  },
  {
    name: 'every chain form, tail resolved',
    lines: [
      '## Steps',
      '',
      '1. If a, then Pay with cash',
      '2. Else if b, then Pay with cash',
      '3. Otherwise, Pay with cash',
      '',
      '### Pay with cash',
      '',
      '1. Click Pay now',
    ],
  },
  {
    name: 'every loop form, tail resolved',
    lines: [
      '## Steps',
      '',
      '1. While a, Pay with cash',
      '2. Repeat Pay with cash until b',
      '3. For each {{x}} in {{y}}, Pay with cash',
      '',
      '### Pay with cash',
      '',
      '1. Click Pay now',
    ],
  },
  {
    name: 'a tail in a section body',
    lines: [
      '## Steps',
      '',
      '1. Outer',
      '',
      '### Outer',
      '',
      '1. If a, then Inner',
      '',
      '### Inner',
      '',
      '1. Click',
    ],
  },
  {
    name: 'a near-miss tail is a call on neither side',
    lines: [
      '## Steps',
      '',
      '1. If a, then Pay with cache',
      '',
      '### Pay with cash',
      '',
      '1. Click Pay now',
    ],
  },
  {
    name: 'a bracket-directive tail is a call on neither side',
    lines: [
      '## Steps',
      '',
      '1. If a, then [tool: pay_now]',
      '',
      '### Pay with cash',
      '',
      '1. Click Pay now',
    ],
  },
];

describe('buildSectionIndex vs the CLI expander (control lines)', () => {
  for (const testCase of CONTROL_CASES) {
    it(testCase.name, async () => {
      const text = testCase.lines.join('\n');
      const ran = await expandedSectionCalls(text);
      // Exact equality, not just the safe direction: every one of these is a
      // single-line step, so the wrapped-item allowance that makes the table
      // above one-directional does not apply.
      expect([...allIndexCalls(text)].sort()).toEqual([...ran].sort());
    });
  }

  it('the whole-line cases really do resolve as calls (not vacuously equal)', async () => {
    const text = CONTROL_CASES[1]!.lines.join('\n');
    expect([...(await expandedSectionCalls(text))]).toEqual([
      '3:while waiting, keep the page open',
    ]);
    expect([...allIndexCalls(text)]).toEqual(['3:while waiting, keep the page open']);
  });

  it('and a resolved TAIL really does call, at the guard`s line', async () => {
    const text = CONTROL_CASES[0]!.lines.join('\n');
    expect([...(await expandedSectionCalls(text))]).toEqual(['3:pay with cash']);
    expect([...allIndexCalls(text)]).toEqual(['3:pay with cash']);
  });
});
