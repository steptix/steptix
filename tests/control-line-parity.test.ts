import { describe, it, expect } from 'vitest';
import {
  parseControlLineAt as cliParse,
  isControlLineClaim as cliClaims,
  claimedControlForm as cliForm,
  closedChainMemberMessage as cliClosed,
  danglingChainMemberMessage as cliDangling,
  chainMemberWord as cliWord,
  chainAfterFlowControlMessage as cliAfterFlow,
  isFlowControlLine as cliFlowLine,
} from '../src/parser/control-line.js';
import { parseFlowControlStep } from '../src/parser/flow-control-step.js';
import {
  parseControlLine as coreParse,
  closedChainMemberMessage as coreClosed,
  danglingChainMemberMessage as coreDangling,
  chainMemberWord as coreWord,
  chainAfterFlowControlMessage as coreAfterFlow,
  isFlowControlLine as coreFlowLine,
  // runner-core's SOURCE, not its `dist/`. Nothing in this repo's `npm test`
  // path builds runner-core, so importing the compiled copy asked this corpus
  // about whatever the mirror used to be: measured, changing `'Else if'` to
  // `'Elseif'` in runner-core/src/control-line.ts and running this file left
  // it 16/16 green. Vitest transforms the `.ts` on the way in.
} from '../runner-core/src/control-line.ts';

/**
 * The CLI's control-line grammar and runner-core's mirror of it, fed one
 * corpus and compared field by field.
 *
 * runner-core cannot import `src/`, so the six forms are implemented twice —
 * which is the shape steptix/steptix#49 already tracks for the step
 * span scanner, and the shape stories/test-script-sections-contract.md exists
 * because of. What makes drift here expensive is that the two answers are used
 * for different halves of the same promise: the CLI's decides what RUNS, the
 * mirror's decides what the editor UNDERLINES and what the "never used"
 * diagnostic believes. Disagreement means a tail that links to a section the
 * runtime never calls, or a section reported dead while it runs on every pass.
 *
 * Both sides are compared including `tailStart`, because the offset is what
 * the editor draws with and an off-by-one there underlines the wrong words.
 */

const CORPUS = [
  // ── the six forms, plainly ────────────────────────────────────────────
  'If the Cash checkbox is ticked, then Pay with cash',
  'If {{plan}} is "pro" then [skill: enable_pro_features]',
  'Else if the Card checkbox is ticked, then Pay by card',
  'Otherwise if the Card checkbox is ticked, then Pay by card',
  'Otherwise, Pay by card',
  'Else, Pay by card',
  'Else Pay by card',
  'While the Next button is enabled, Go to the next page',
  'Repeat Click Load more until the Load more button is gone',
  'For each {{account}} in {{accounts}}, Check the account',

  // ── casing and markers ────────────────────────────────────────────────
  'IF x, THEN Y',
  'ELSE IF x, THEN Y',
  'OTHERWISE, Y',
  'WHILE x, Y',
  'REPEAT Y UNTIL x',
  'FOR EACH {{a}} IN {{b}}, Y',
  '[no-hooks] If x, then Login',
  '[NO-HOOKS] While x, Login',
  '   If x, then Login   ',

  // ── where the split falls ─────────────────────────────────────────────
  'If a then b, then c then d',
  'While a, do b, and then c',
  'Repeat a until b until c',
  'For each {{a}} in {{b}}, do c, and d',
  'While a, do b, up to 20 times',
  'Repeat do b until a, up to 3 times',
  'While a, do b, up to 3 times a day',
  'While a, do b, up to 0 times',
  'While a, do b, up to 1 times',
  'For each {{a}} in {{b}}, c, up to 3 times',
  // An invalid cap on the OTHER cap-taking form: `Repeat` strips the suffix
  // before it looks for ` until `, so a bad cap changes what the rest of the
  // line even is.
  'Repeat b until a, up to 0 times',
  'Repeat b until a, up to 9007199254740993 times',
  'While a, do b, up to 9007199254740993 times',
  // Whitespace that is not a space. `\s` matches a tab on both sides, or it
  // does not on one of them — and nothing else in the corpus would say.
  'If a,\tthen b',
  'Repeat b\tuntil\ta',
  'While a,\tdo b',
  'For each {{a}}\tin\t{{b}},\tdo c',
  // A `For each` whose tail is empty after the comma: the fixed shape's last
  // capture is `\S.*`, so this is the branch that distinguishes "no tail" from
  // "no comma".
  'For each {{a}} in {{b}},',
  'For each {{a}} in {{b}}, ',

  // ── claims that do not complete ───────────────────────────────────────
  'Else if the card box is ticked',
  'If then Pay by card',
  'Otherwise',
  'Otherwise,',
  'Else',
  'While the Next button is enabled',
  'While , do b',
  'While a,',
  'Repeat until the Load more button is gone',
  'For each {{ account }} in {{accounts}}, Check it',
  'For each {{2nd}} in {{accounts}}, Check it',
  'For each {{account}}, Check it',
  'For each {{a}} in {{b}} Check it',

  // ── the overlap with `If … then return` (stories/step-flow-control.md) ──
  //
  // Both grammars claim these, and flow control wins them — in the CLI parser
  // by calling `parseFlowControlStep`, in the mirror by a hand copy of that
  // regex, which is exactly the drift this suite exists to catch. The mirror
  // is what decides whether the editor underlines `return` as a section call
  // site, so a disagreement here shows up as a squiggle under a keyword.
  'If the page title contains "Dashboard", then return',
  'If the page title contains "Dashboard" then return',
  'If the balance is zero, then stop here',
  'If the list is empty, then stop running the remaining steps',
  'When the dashboard is shown, then return',
  // Case, and the `[no-hooks]` marker, on the same overlap.
  'If X, then Return',
  'IF X, THEN STOP HERE',
  '[no-hooks] If X, then return',
  // One trailing full stop, which the flow-control grammar drops and this one
  // keeps — so the two normalisations have to agree about the claim anyway.
  'If X, then return.',
  // The near miss, and the whole reason the flow-control grammar is anchored:
  // the trailing words leave it unmatched, so this IS a chain whose tail is
  // the prose "return to the dashboard".
  'If X, then return to the dashboard',
  'If X, then stop the upload',
  'If X, then retun',
  // ── the same overlap for the third verb, `fail` (decision 1) ──────────
  // The mirror carries a SECOND hand copy, and `fail` has a joiner the other
  // two verbs do not — a bare space — the easiest asymmetry to mirror wrongly.
  'If the balance is zero, then fail',
  'If the balance is zero then fail the test with error "No balance was shown"',
  'When the list is empty, then fail the run with message "empty"',
  "If X, then fail with reason 'boom'",
  'IF X, THEN FAIL THE TEST',
  '[no-hooks] If X, then fail',
  'If X, then fail.',
  // The bare-space joiner, which needs a tail that earns it — the noun, the
  // message, or both, so all three shapes are here.
  'If {{a}} is "peanuts" fail the test with error "Expected apples"',
  'If X fail the test',
  'If X fail with error "boom"',
  // …and the near misses: `fail the order` is prose after a `then` so the line
  // stays a chain, while `If X return` has no ` then ` and neither claims it.
  'If X, then fail the order',
  'If X, then fail the tests',
  'If X return',
  'If X stop here',
  // A BARE `fail` behind a bare space claimed prose ending in the word, turning
  // a BDD expectation into a step that ends the run when it is MET.
  'If X fail',
  'When I submit with bad data, the save should fail',
  'If the upload does not fail',
  'If the login attempts fail',
  // The joiner-only body: a malformed `If` in BOTH, so the mirror has to copy a
  // guard and not just a regex.
  'If then fail',
  'If and fail the test with error "x"',
  // …and the second such guard: a body ending in the head of an `otherwise`
  // tail, which is a step with a failure TAIL and no claim at all.
  'If the banner is visible, dismiss it, otherwise fail the test with message "No banner"',
  'If x then fail the test with error "M" otherwise fail',
  'If the banner is visible, dismiss it, or else fail the test',
  // A bare return is claimed by neither: no control-line head matches it.
  'Return',
  'Stop here',
  'Stop running the remaining steps',
  'Fail',
  'Fail the test with error "boom"',
  // …but a bare return as somebody else's TAIL is a control line, because the
  // guard is on the HEAD. The body is then an unconditional flow-control step,
  // which is a sentence with one meaning.
  'Otherwise, return',
  'While the banner is visible, return',
  'For each {{a}} in {{b}}, return',
  // The same for `fail` — the story's own example: a chain's else whose tail is
  // the unconditional `Fail … with error "…"`.
  'Otherwise fail the test with error "No balance was shown"',
  'Otherwise, fail',

  // ── prose, which must stay prose in both ──────────────────────────────
  'If a Remember this device prompt appears, click Not now',
  'If x, then',
  'If x,then y',
  'Repeat the search',
  'For each product in the list, verify its price',
  'Ifs are hard',
  'Otherwiseraise the limit',
  'Whiletext',
  'Repeatedly click',
  'Click the Login button',
  'Set {{x}} to "y"',
  '[skill: login]',
  '[tool: fetch_orders]',
  '[input: pin] Enter your PIN',
  '[interactive]',
  'While waiting',
  'Login as admin',
  '',
  '   ',
];

describe('src/parser/control-line.ts and runner-core/src/control-line.ts agree', () => {
  // The parse is the whole comparison: runner-core mirrors no claim test, since
  // no client asks whether a line claimed a form, only whether it parsed. The
  // CLI's claim functions still steer the corpus self-check below.
  it('on what parses, and on every field including the tail offset', () => {
    for (const line of CORPUS) {
      expect(coreParse(line), line).toEqual(cliParse(line));
    }
  });

  it('the corpus covers every form on every branch, not just every label', () => {
    // Six labels appearing says nothing about which side of each form was
    // exercised. What keeps this corpus honest is that every form is present
    // BOTH parsing and claiming-without-completing: a branch added to one
    // implementation and not the other is only caught if some line reaches it.
    const FORMS = ['if', 'elseif', 'else', 'while', 'repeat', 'foreach'] as const;
    const missing: string[] = [];
    for (const form of FORMS) {
      const claimed = CORPUS.filter((l) => cliForm(l) === form);
      if (!claimed.some((l) => cliParse(l) !== null)) missing.push(`${form}: no line parses`);
      if (!claimed.some((l) => cliParse(l) === null)) {
        missing.push(`${form}: no line claims and fails`);
      }
    }
    // The cap suffix is its own branch on the two forms that take one, and a
    // refused cap is a third state beside present and absent.
    for (const form of ['while', 'repeat'] as const) {
      const claimed = CORPUS.filter((l) => cliForm(l) === form);
      const parsed = claimed.map((l) => cliParse(l)).filter((p) => p !== null);
      if (!parsed.some((p) => 'cap' in p && p.cap !== undefined)) missing.push(`${form}: no cap`);
      if (!parsed.some((p) => !('cap' in p) || p.cap === undefined)) {
        missing.push(`${form}: never capless`);
      }
      if (!claimed.some((l) => /up to (0|9007199254740993) times$/.test(l))) {
        missing.push(`${form}: no refused cap`);
      }
    }
    expect(missing).toEqual([]);

    // …and prose, the fourth state: a line that claims nothing at all.
    expect(CORPUS.some((l) => !cliClaims(l))).toBe(true);
    // …and the `[no-hooks]` strip, which both sides duplicate.
    expect(CORPUS.some((l) => /^\[no-hooks\]/i.test(l) && cliParse(l) !== null)).toBe(true);
    // …and non-space whitespace at each keyword split.
    expect(CORPUS.some((l) => l.includes('\t') && cliParse(l) !== null)).toBe(true);
  });
});

/**
 * The dangling-member wording, which is mirrored where `controlLineError`
 * deliberately is not.
 *
 * Three places refuse a dangling `Else if` / `Otherwise` — the CLI parser, the
 * expander (the wire path's only parser) and runner-core's pre-flight — and an
 * author who meets the refusal in Steptix and then again from the CLI has to
 * read the same sentence about the same line, or all three lose their
 * authority. `src/parser/control-line.ts` owns the text; runner-core copies it.
 */
describe('the dangling-member message is one wording, mirrored', () => {
  const CASES = [
    { line: 'Otherwise, Pay by card', word: 'Otherwise', flow: '## Steps', where: 'tests/t.md:7' },
    { line: 'Else if b, then Y', word: 'Else if', flow: '### Pay', where: 'Line 11' },
    // No location: the expander has one, but a caller without a line number
    // must still get a sentence that reads.
    { line: 'Otherwise, Y', word: 'Otherwise', flow: '## Steps' },
  ];

  it('character for character, on both sides', () => {
    for (const args of CASES) {
      expect(coreDangling(args), args.line).toBe(cliDangling(args));
    }
  });

  it('and says the three things it has to say', () => {
    const message = cliDangling(CASES[0]!);
    expect(message).toContain('tests/t.md:7 — ');
    expect(message).toContain('"Otherwise, Pay by card"');
    expect(message).toContain('`Otherwise` line must follow an `If … then …`');
    expect(message).toContain('(## Steps)');
    // Without a location it opens with the line itself, not a stray dash.
    expect(cliDangling(CASES[2]!).startsWith('"Otherwise, Y"')).toBe(true);
  });

  it('the word is chosen the same way on both sides', () => {
    expect(coreWord('elseif')).toBe(cliWord('elseif'));
    expect(coreWord('else')).toBe(cliWord('else'));
    expect(cliWord('elseif')).toBe('Else if');
    expect(cliWord('else')).toBe('Otherwise');
  });
});

describe('the closed-chain message is one wording, mirrored', () => {
  // The other half of the same rule: `Otherwise` is the last member, so an
  // `Else if` or a second `Otherwise` under one is refused. It lived in the
  // CLI parser alone, so a file Steptix and the Sessions API ran happily was
  // rejected by `steptix run`.
  const CASES = [
    { line: 'Else if b, then Sec3', where: 'tests/t.md:6' },
    { line: 'Otherwise, Sec3', where: 'Line 7' },
    { line: 'Otherwise, Sec3' },
  ];

  it('character for character, on both sides', () => {
    for (const args of CASES) {
      expect(coreClosed(args), args.line).toBe(cliClosed(args));
    }
  });

  it('and says what is wrong and what to do instead', () => {
    const message = cliClosed(CASES[0]!);
    expect(message).toContain('tests/t.md:6 — ');
    expect(message).toContain('"Else if b, then Sec3"');
    expect(message).toContain('follows an `Otherwise`, which ends a chain');
    expect(message).toContain('put any further alternative in an `Else if` above it');
    expect(cliClosed(CASES[2]!).startsWith('"Otherwise, Sec3"')).toBe(true);
  });
});

describe('flow control wins the overlap, identically on both sides', () => {
  // Rung 0 of the resolution order. The CLI parser asks
  // `parseFlowControlStep`; the mirror carries a hand copy of that regex,
  // because runner-core cannot import `src/`. The CORPUS above already
  // compares the two on the overlapping lines — this says out loud WHICH way
  // the overlap goes, so a future reader cannot mistake agreement for
  // agreement on the wrong answer.
  const FLOW_CONTROL = [
    'If the page title contains "Dashboard", then return',
    'If the page title contains "Dashboard" then return',
    'If the balance is zero, then stop here',
    'If the list is empty, then stop running the remaining steps',
    'When the dashboard is shown, then return',
    'If X, then Return',
    'IF X, THEN STOP HERE',
    '[no-hooks] If X, then return',
    'If X, then return.',
    // The third verb (decision 1), with the bare-space joiner only it has.
    'If the balance is zero, then fail',
    'If the balance is zero then fail the test with error "No balance was shown"',
    "If X, then fail with reason 'boom'",
    'IF X, THEN FAIL THE TEST',
    '[no-hooks] If X, then fail',
    'If X, then fail.',
    'If {{a}} is "peanuts" fail the test with error "Expected apples"',
    'If X fail the test',
    'If X fail with error "boom"',
  ];
  // Claimed by NEITHER grammar, so both implementations answer "prose". Read as
  // a claim, the reviewer's line had the condition `I submit with bad data, the
  // save should` — the run went red exactly when the expectation was met.
  const PROSE_IN_BOTH = [
    'If X fail',
    'If X fail the',
    'When I submit with bad data, the save should fail',
    'If the upload does not fail',
    'If the login attempts fail',
  ];
  const STILL_CONTROL_LINES = [
    // `$`-anchored, so the trailing words leave the flow-control grammar
    // unmatched and this stays a chain whose tail is prose.
    'If X, then return to the dashboard',
    'If X, then stop the upload',
    'If X, then retun',
    'If X, then fail the order',
    'If X, then fail the tests',
    'Otherwise fail the test with error "No balance was shown"',
    // The guard is on the HEAD, so a bare return as a BODY is untouched.
    'Otherwise, return',
    'While the banner is visible, return',
    'For each {{a}} in {{b}}, return',
  ];

  it('a flow-control line is no control line, in either implementation', () => {
    for (const line of FLOW_CONTROL) {
      expect(cliParse(line), line).toBeNull();
      expect(coreParse(line), line).toBeNull();
      expect(cliClaims(line), line).toBe(false);
      expect(cliForm(line), line).toBeNull();
      // …and it really is claimed by the other grammar, or this suite would
      // pass just as well on a typo nobody claims.
      expect(parseFlowControlStep(line.replace(/^\[no-hooks\]\s*/i, '')), line).not.toBeNull();
      // …in BOTH implementations of it, the half the corpus cannot see: a
      // mirror that declined for the wrong reason still agrees with the CLI.
      expect(cliFlowLine(line), line).toBe(true);
      expect(coreFlowLine(line), line).toBe(true);
    }
  });

  it('a bare `fail` behind a bare space is prose in both', () => {
    for (const line of PROSE_IN_BOTH) {
      expect(cliFlowLine(line), line).toBe(false);
      expect(coreFlowLine(line), line).toBe(false);
      expect(parseFlowControlStep(line), line).toBeNull();
      // …and no control line picks them up on the rebound.
      expect(cliParse(line), line).toBeNull();
      expect(coreParse(line), line).toBeNull();
      expect(cliClaims(line), line).toBe(false);
    }
  });

  it('a near miss stays a control line, in either implementation', () => {
    for (const line of STILL_CONTROL_LINES) {
      expect(cliParse(line), line).not.toBeNull();
      expect(coreParse(line), line).not.toBeNull();
      expect(coreParse(line), line).toEqual(cliParse(line));
    }
    // The one the anchor exists for, spelled out: the tail is the prose, and
    // it is the whole prose.
    expect(cliParse('If X, then return to the dashboard')).toMatchObject({
      kind: 'if',
      condition: 'X',
      tail: 'return to the dashboard',
    });
  });

  it('a bare Return is neither: no control-line head matches it', () => {
    for (const line of ['Return', 'Stop here', 'Stop running the remaining steps', 'Fail',
      'Fail the test with error "boom"']) {
      expect(cliClaims(line), line).toBe(false);
      expect(parseFlowControlStep(line), line).not.toBeNull();
    }
  });

  it('the bare-space joiner is `fail`-only, on both sides', () => {
    // Pinned as an answer rather than as agreement: `\s+` grown into the
    // return/stop expression would keep the corpus passing, both sides wrong
    // together. Both halves, since the mirror copies both.
    expect(parseFlowControlStep('If X fail the test')).toEqual({ verb: 'fail', body: 'X' });
    expect(coreFlowLine('If X fail the test')).toBe(true);
    expect(parseFlowControlStep('If X fail')).toBeNull();
    expect(coreFlowLine('If X fail')).toBe(false);
    expect(parseFlowControlStep('If X return')).toBeNull();
    expect(parseFlowControlStep('If X stop here')).toBeNull();
    // …so the last two stay ordinary prose: no ` then `, so no chain either.
    for (const line of ['If X return', 'If X stop here']) {
      expect(cliClaims(line), line).toBe(false);
    }
  });
});

describe('the chain-after-flow-control message is one wording, mirrored', () => {
  // The third refusal wording, added when the two features met. An `Otherwise`
  // under an `If … then return` is refused in all three places the dangling
  // rule is refused in, and has to read the same in each.
  const CASES = [
    {
      line: 'Otherwise, Pay by card',
      word: 'Otherwise',
      previous: 'If the balance is zero then return',
      where: 'tests/t.md:7',
    },
    {
      line: 'Else if b, then Y',
      word: 'Else if',
      previous: 'If the list is empty, then stop here',
      where: 'Line 11',
    },
    { line: 'Otherwise, Y', word: 'Otherwise', previous: 'Return' },
  ];

  it('character for character, on both sides', () => {
    for (const args of CASES) {
      expect(coreAfterFlow(args), args.line).toBe(cliAfterFlow(args));
    }
  });

  it('and teaches the fix rather than restating the rule', () => {
    const message = cliAfterFlow(CASES[0]!);
    expect(message).toContain('tests/t.md:7 — ');
    expect(message).toContain('"Otherwise, Pay by card"');
    // It names the line above, which is the thing the author is looking at.
    expect(message).toContain('"If the balance is zero then return"');
    expect(message).toContain('ends the flow rather than choosing a branch');
    // The teaching half: why no alternative is needed at all.
    expect(message).toContain('already run only when the return did NOT fire');
    expect(message).toContain('write the alternative as the next step');
    expect(cliAfterFlow(CASES[2]!).startsWith('"Otherwise, Y"')).toBe(true);
  });

  it('is a different sentence from the plain dangling one', () => {
    // Or the wording would be a rename rather than a rule: the dangling
    // message says "no decision above you", which reads as a parser bug to
    // someone looking straight at an `If`.
    const after = cliAfterFlow(CASES[0]!);
    const dangling = cliDangling({
      line: CASES[0]!.line,
      word: CASES[0]!.word,
      flow: '## Steps',
      where: CASES[0]!.where,
    });
    expect(after).not.toBe(dangling);
    expect(dangling).toContain('has no decision to be the alternative of');
    expect(after).not.toContain('has no decision to be the alternative of');
  });
});
