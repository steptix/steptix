import { describe, it, expect } from 'vitest';
import {
  chainMembers,
  createControlState,
  forEachPassOf,
  parseListValue,
  planAfterGuard,
  planAfterStep,
  planAtGuard,
  planForStart,
  snapEndAt,
  type ControlRecord,
  type ControlState,
  type GuardVerdict,
} from '../src/runner/control-flow.js';

/**
 * The pure planner (stories/control-flow.md §Runtime).
 *
 * Four run loops will call this and none of them should have an opinion of
 * its own, so every question they can ask is answered here against
 * hand-written `controls` arrays. The layouts in each block are the ones the
 * expander really produces — see tests/expander-control-flow.test.ts, which
 * asserts the same ranges from the other end.
 */

/**
 * ```
 * 0  Sign in
 * 1  If cash, then Pay with cash        body 2..3   chain ends 8
 * 2    Click Pay now
 * 3    Verify the receipt
 * 4  Else if card, then Pay by card     body 5..6
 * 5    Enter the card details
 * 6    Click Pay now
 * 7  Otherwise, Verify …                body 8..8
 * 8    Verify the Pay now button is disabled
 * 9  Sign out
 * ```
 */
const CHAIN: (ControlRecord | null)[] = [
  null,
  { kind: 'if', chainId: 'c1', condition: 'cash', bodyStart: 2, bodyEnd: 3, chainEnd: 8 },
  null,
  null,
  { kind: 'elseif', chainId: 'c1', condition: 'card', bodyStart: 5, bodyEnd: 6, chainEnd: 8 },
  null,
  null,
  { kind: 'else', chainId: 'c1', bodyStart: 8, bodyEnd: 8, chainEnd: 8 },
  null,
  null,
];

/** The same chain with no `Otherwise` (drop the last member). */
const CHAIN_NO_ELSE: (ControlRecord | null)[] = [
  null,
  { kind: 'if', chainId: 'c1', condition: 'cash', bodyStart: 2, bodyEnd: 3, chainEnd: 6 },
  null,
  null,
  { kind: 'elseif', chainId: 'c1', condition: 'card', bodyStart: 5, bodyEnd: 6, chainEnd: 6 },
  null,
  null,
  null,
];

describe('a chain', () => {
  it('asks every condition in order, and names the fallback', () => {
    expect(planAtGuard(CHAIN, 1, createControlState())).toEqual({
      ask: 'chain',
      conditions: [
        { index: 1, condition: 'cash' },
        { index: 4, condition: 'card' },
      ],
      fallback: 7,
    });
  });

  it('runs the selected member and skips every other member WITH its body', () => {
    const plan = planAfterGuard(CHAIN, 1, { kind: 'chain', selected: 1 }, createControlState());
    expect(plan).toEqual({ skip: [[4, 8]], next: 2, selected: 1 });
  });

  it('skips the members before the one that held, too', () => {
    const plan = planAfterGuard(CHAIN, 1, { kind: 'chain', selected: 4 }, createControlState());
    // The `If` guard and its body, then the `Otherwise` and its body.
    expect(plan).toEqual({ skip: [[1, 3], [7, 8]], next: 5, selected: 4 });
  });

  it('"none" selects the Otherwise without the caller having to know', () => {
    const plan = planAfterGuard(CHAIN, 1, { kind: 'chain', selected: null }, createControlState());
    expect(plan).toEqual({ skip: [[1, 6]], next: 8, selected: 7 });
  });

  it('"none" with no Otherwise skips the whole chain and carries on after it', () => {
    const plan = planAfterGuard(
      CHAIN_NO_ELSE,
      1,
      { kind: 'chain', selected: null },
      createControlState(),
    );
    expect(plan).toEqual({ skip: [[1, 6]], next: 7, selected: null });
  });

  it('leaves the chain when the taken body ends', () => {
    const state = createControlState();
    expect(planAfterStep(CHAIN, 3, state)).toEqual({ next: 9 });
    expect(planAfterStep(CHAIN, 6, state)).toEqual({ next: 9 });
    expect(planAfterStep(CHAIN, 8, state)).toEqual({ next: 9 });
    // An ordinary step inside a body says nothing.
    expect(planAfterStep(CHAIN, 2, state)).toBeNull();
    expect(planAfterStep(CHAIN, 0, state)).toBeNull();
  });

  it('finds a chain`s members from any of them', () => {
    expect(chainMembers(CHAIN, 4)).toEqual([1, 4, 7]);
  });

  it('evaluated from a mid-chain member, only that member and the ones after it', () => {
    // What a `startAt` landing on the `Else if` line means: the members above
    // are not in the batch, so they are neither asked nor skipped.
    expect(planAtGuard(CHAIN, 4, createControlState())).toEqual({
      ask: 'chain',
      conditions: [{ index: 4, condition: 'card' }],
      fallback: 7,
    });
    const plan = planAfterGuard(CHAIN, 4, { kind: 'chain', selected: 4 }, createControlState());
    expect(plan).toEqual({ skip: [[7, 8]], next: 5, selected: 4 });
  });
});

/**
 * ```
 * 0  While the Next button is enabled, Go to the next page   body 1..2
 * 1    Click Next
 * 2    Verify the page changed
 * 3  Sign out
 * ```
 */
const WHILE_LOOP: (ControlRecord | null)[] = [
  {
    kind: 'while',
    condition: 'the Next button is enabled',
    bodyStart: 1,
    bodyEnd: 2,
    label: 'Go to the next page',
  },
  null,
  null,
  null,
];

describe('While', () => {
  it('asks its condition every time it is reached', () => {
    expect(planAtGuard(WHILE_LOOP, 0, createControlState())).toEqual({
      ask: 'condition',
      condition: 'the Next button is enabled',
    });
  });

  it('counts passes, and each one enters the body', () => {
    const state = createControlState();
    const first = planAfterGuard(WHILE_LOOP, 0, { kind: 'condition', holds: true }, state);
    expect(first).toEqual({ skip: [], next: 1, pass: { iteration: 1 } });
    // The body ends, and the guard is re-entered rather than the next step.
    expect(planAfterStep(WHILE_LOOP, 2, state)).toEqual({ next: 0, reevaluate: 0 });
    const second = planAfterGuard(WHILE_LOOP, 0, { kind: 'condition', holds: true }, state);
    expect(second).toEqual({ skip: [], next: 1, pass: { iteration: 2 } });
  });

  it('a condition false the first time skips the body — the guard still decided', () => {
    const plan = planAfterGuard(WHILE_LOOP, 0, { kind: 'condition', holds: false }, createControlState());
    expect(plan).toEqual({ skip: [[1, 2]], next: 3, loopEnded: { guard: 0, count: 0 } });
  });

  it('exiting after N passes skips nothing and reports the count for back-fill', () => {
    const state = createControlState();
    for (let i = 0; i < 3; i++) {
      planAfterGuard(WHILE_LOOP, 0, { kind: 'condition', holds: true }, state);
    }
    const plan = planAfterGuard(WHILE_LOOP, 0, { kind: 'condition', holds: false }, state);
    expect(plan).toEqual({ skip: [], next: 3, loopEnded: { guard: 0, count: 3 } });
  });

  it('reaching the cap with the condition still true is a distinct outcome', () => {
    const state = createControlState(2);
    planAfterGuard(WHILE_LOOP, 0, { kind: 'condition', holds: true }, state);
    planAfterGuard(WHILE_LOOP, 0, { kind: 'condition', holds: true }, state);
    const plan = planAfterGuard(WHILE_LOOP, 0, { kind: 'condition', holds: true }, state);
    expect(plan.capBreached).toEqual({ cap: 2, source: 'config' });
    expect(plan.pass).toBeUndefined();
  });

  it('a cap written on the line beats the config default, and says so', () => {
    const capped: (ControlRecord | null)[] = [
      { ...(WHILE_LOOP[0] as ControlRecord & { kind: 'while' }), cap: 1 },
      null,
      null,
      null,
    ];
    const state = createControlState(25);
    planAfterGuard(capped, 0, { kind: 'condition', holds: true }, state);
    const plan = planAfterGuard(capped, 0, { kind: 'condition', holds: true }, state);
    expect(plan.capBreached).toEqual({ cap: 1, source: 'line' });
  });
});

/**
 * ```
 * 0  Repeat Click Load more until it is gone   body 1..1
 * 1    Click Load more
 * 2  Sign out
 * ```
 */
const REPEAT_LOOP: (ControlRecord | null)[] = [
  { kind: 'repeat', condition: 'it is gone', bodyStart: 1, bodyEnd: 1, label: 'Click Load more' },
  null,
  null,
];

describe('Repeat … until', () => {
  it('runs its body before there is anything to decide', () => {
    const state = createControlState();
    expect(planAtGuard(REPEAT_LOOP, 0, state)).toEqual({ ask: 'nothing' });
    const plan = planAfterGuard(REPEAT_LOOP, 0, { kind: 'resume' }, state);
    expect(plan).toEqual({ skip: [], next: 1, pass: { iteration: 1 } });
  });

  it('asks from the second visit on, and stops when the condition HOLDS', () => {
    const state = createControlState();
    planAfterGuard(REPEAT_LOOP, 0, { kind: 'resume' }, state);
    expect(planAtGuard(REPEAT_LOOP, 0, state)).toEqual({
      ask: 'condition',
      condition: 'it is gone',
    });
    const plan = planAfterGuard(REPEAT_LOOP, 0, { kind: 'condition', holds: true }, state);
    expect(plan).toEqual({ skip: [], next: 2, loopEnded: { guard: 0, count: 1 } });
  });

  it('carries on while the condition does not hold', () => {
    const state = createControlState();
    planAfterGuard(REPEAT_LOOP, 0, { kind: 'resume' }, state);
    const plan = planAfterGuard(REPEAT_LOOP, 0, { kind: 'condition', holds: false }, state);
    expect(plan).toEqual({ skip: [], next: 1, pass: { iteration: 2 } });
  });

  it('breaches its cap like a While does', () => {
    const state = createControlState(1);
    planAfterGuard(REPEAT_LOOP, 0, { kind: 'resume' }, state);
    const plan = planAfterGuard(REPEAT_LOOP, 0, { kind: 'condition', holds: false }, state);
    expect(plan.capBreached).toEqual({ cap: 1, source: 'config' });
  });
});

/**
 * ```
 * 0  For each {{account}} in {{accounts}}, Check the account   body 1..1
 * 1    Check the account
 * 2  Sign out
 * ```
 */
const FOREACH_LOOP: (ControlRecord | null)[] = [
  {
    kind: 'foreach',
    item: 'account',
    list: 'accounts',
    bodyStart: 1,
    bodyEnd: 1,
    label: 'Check the account',
  },
  null,
  null,
];

describe('For each', () => {
  it('reads its list once, then walks a cursor with no further questions', () => {
    const state = createControlState();
    expect(planAtGuard(FOREACH_LOOP, 0, state)).toEqual({ ask: 'list', list: 'accounts' });

    const first = planAfterGuard(
      FOREACH_LOOP,
      0,
      { kind: 'list', items: ['Savings', 'Everyday'] },
      state,
    );
    expect(first).toEqual({
      skip: [],
      next: 1,
      pass: { iteration: 1, count: 2, bindings: { account: 'Savings' } },
    });

    expect(planAfterStep(FOREACH_LOOP, 1, state)).toEqual({ next: 0, reevaluate: 0 });
    expect(planAtGuard(FOREACH_LOOP, 0, state)).toEqual({ ask: 'nothing' });

    const second = planAfterGuard(FOREACH_LOOP, 0, { kind: 'resume' }, state);
    expect(second).toEqual({
      skip: [],
      next: 1,
      pass: { iteration: 2, count: 2, bindings: { account: 'Everyday' } },
    });

    const done = planAfterGuard(FOREACH_LOOP, 0, { kind: 'resume' }, state);
    expect(done).toEqual({ skip: [], next: 2, loopEnded: { guard: 0, count: 2 } });
  });

  it('an empty list skips the body, the way a false While does', () => {
    const state = createControlState();
    const plan = planAfterGuard(FOREACH_LOOP, 0, { kind: 'list', items: [] }, state);
    expect(plan).toEqual({ skip: [[1, 1]], next: 2, loopEnded: { guard: 0, count: 0 } });
  });

  it('the count is known from the start, unlike a While`s', () => {
    const state = createControlState();
    const plan = planAfterGuard(FOREACH_LOOP, 0, { kind: 'list', items: ['a'] }, state);
    expect(plan.pass?.count).toBe(1);
  });
});

/**
 * A list whose elements are OBJECTS
 * (docs/specs/SPEC-structured-table-reads.md §8.2; §12 items 16 and 17).
 *
 * The scalar block above is the regression half of §12 item 15 and must stay
 * exactly as it was: an object list is an ADDITION to what a pass binds, never
 * a replacement. Every assertion here therefore names the base binding too.
 */
describe('For each over objects', () => {
  const ROWS =
    '[{"_row":"1","id":"ORD-1001","customer":"Alice Smith","status":"Completed"},' +
    '{"_row":"2","id":"ORD-1002","customer":"Bob Jones","status":"Pending"}]';

  const enter = (raw: string, state: ControlState) => {
    const parsed = parseListValue('orders', raw);
    if ('error' in parsed) throw new Error(parsed.error);
    return planAfterGuard(
      FOREACH_LOOP,
      0,
      { kind: 'list', items: parsed.items, properties: parsed.properties },
      state,
    );
  };

  it('binds the base JSON and every direct property, in the record"s order', () => {
    const state = createControlState();
    const first = enter(ROWS, state);
    // Base first, then the properties in the order the record wrote them —
    // `_row` leads because `readTable` writes it first (§7.4), which is what
    // makes the Variables panel show the row number at the top.
    expect(Object.entries(first.pass!.bindings!)).toEqual([
      ['account', '{"_row":"1","id":"ORD-1001","customer":"Alice Smith","status":"Completed"}'],
      ['account._row', '1'],
      ['account.id', 'ORD-1001'],
      ['account.customer', 'Alice Smith'],
      ['account.status', 'Completed'],
    ]);

    planAfterStep(FOREACH_LOOP, 1, state);
    const second = planAfterGuard(FOREACH_LOOP, 0, { kind: 'resume' }, state);
    expect(second.pass).toMatchObject({
      iteration: 2,
      count: 2,
      bindings: {
        'account._row': '2',
        'account.id': 'ORD-1002',
        'account.status': 'Pending',
      },
    });
  });

  it('converts each property the way §8.2 says', () => {
    const parsed = parseListValue(
      'n',
      '[{"s":"text","n":42,"b":true,"z":null,"o":{"a":1},"a":[1,"two"]}]',
    );
    expect(parsed).toEqual({
      items: ['{"s":"text","n":42,"b":true,"z":null,"o":{"a":1},"a":[1,"two"]}'],
      properties: [
        {
          s: 'text',
          n: '42',
          b: 'true',
          z: 'null',
          o: '{"a":1}',
          a: '[1,"two"]',
        },
      ],
    });
  });

  it('an empty cell binds "" and is not dropped', () => {
    const parsed = parseListValue('p', '[{"payee":"Netflix","reference":""}]');
    expect(parsed).toEqual({
      items: ['{"payee":"Netflix","reference":""}'],
      properties: [{ payee: 'Netflix', reference: '' }],
    });
  });

  it('a mixed list binds properties only where there are any', () => {
    const parsed = parseListValue('m', '["plain",{"id":"A"},7]');
    expect(parsed).toEqual({
      items: ['plain', '{"id":"A"}', '7'],
      properties: [undefined, { id: 'A' }, undefined],
    });
  });

  it('one property segment only — a nested object is text, not more bindings', () => {
    const state = createControlState();
    const plan = enter('[{"id":"A","address":{"city":"Perth"}}]', state);
    expect(plan.pass!.bindings).toEqual({
      account: '{"id":"A","address":{"city":"Perth"}}',
      'account.id': 'A',
      'account.address': '{"city":"Perth"}',
    });
    expect(plan.pass!.bindings).not.toHaveProperty('account.address.city');
  });

  it('a record from a tool with no _row simply has no {{item._row}}', () => {
    const state = createControlState();
    const plan = enter('[{"id":"A"}]', state);
    expect(Object.keys(plan.pass!.bindings!)).toEqual(['account', 'account.id']);
  });

  /**
   * A key no placeholder can spell is DROPPED, not fatal.
   *
   * It failed the whole guard until review 2, which is a regression against
   * §2's promise that existing `For each` behaviour is preserved: a loop over
   * a tool's or an API's array of objects, using `{{item}}` as JSON text and
   * no dotted binding at all, stopped running the moment one record carried a
   * `content-type`. Nothing about that loop asked for a binding the key
   * cannot have. So the unspellable keys are reported once, and the rest of
   * the record binds exactly as before.
   */
  it('an unspellable key is not bound, and does not fail the guard', () => {
    for (const [raw, key] of [
      ['[{"id":"A"},{"id":"B","order id":"x"}]', 'order id'],
      ['[{"id":"A"},{"id":"B","1st":"x"}]', '1st'],
      ['[{"id":"A"},{"id":"B","content-type":"x"}]', 'content-type'],
      ['[{"id":"A"},{"id":"B","__proto__":"x"}]', '__proto__'],
      ['[{"id":"A"},{"id":"B","constructor":"x"}]', 'constructor'],
      ['[{"id":"A"},{"id":"B","prototype":"x"}]', 'prototype'],
    ] as const) {
      const parsed = parseListValue('orders', raw);
      expect(parsed, raw).not.toHaveProperty('error');
      const ok = parsed as {
        items: string[];
        properties: Array<Record<string, string> | undefined>;
        unspellable?: string[];
      };
      // Both items are there, the spellable key binds, and the other does not.
      expect(ok.items, raw).toHaveLength(2);
      expect(ok.properties[1], raw).toEqual({ id: 'B' });
      // Named once, for the caller to log.
      expect(ok.unspellable, raw).toEqual([key]);
    }
  });

  it('names each unspellable key once, in first-seen order, across the whole list', () => {
    const parsed = parseListValue(
      'orders',
      '[{"id":"A","content-type":"x","Order ID":"1"},{"id":"B","content-type":"y"}]',
    ) as { properties: Array<Record<string, string>>; unspellable?: string[] };
    expect(parsed.unspellable).toEqual(['content-type', 'Order ID']);
    expect(parsed.properties).toEqual([{ id: 'A' }, { id: 'B' }]);
  });

  it('says nothing at all when every key is spellable', () => {
    const parsed = parseListValue('orders', '[{"id":"A"}]');
    expect(parsed).not.toHaveProperty('unspellable');
  });

  it("an inner loop's dotted bindings do not disturb an outer loop's", () => {
    // ```
    // 0  For each {{order}} in {{orders}}, …     body 1..3
    // 1    For each {{line}} in {{lines}}, …     body 2..2
    // 2      Check the line
    // 3    Verify the order
    // ```
    const NESTED: (ControlRecord | null)[] = [
      { kind: 'foreach', item: 'order', list: 'orders', bodyStart: 1, bodyEnd: 3, label: 'o' },
      { kind: 'foreach', item: 'line', list: 'lines', bodyStart: 2, bodyEnd: 2, label: 'l' },
      null,
      null,
    ];
    const state = createControlState();
    const outer = planAfterGuard(
      NESTED,
      0,
      { kind: 'list', items: ['{"id":"A"}'], properties: [{ id: 'A' }] },
      state,
    );
    const inner = planAfterGuard(
      NESTED,
      1,
      { kind: 'list', items: ['{"id":"L1"}'], properties: [{ id: 'L1' }] },
      state,
    );
    // Different item names, so the live map holds both at once; the planner
    // writes only its own, exactly as the scalar binding always has.
    expect(outer.pass!.bindings).toEqual({ order: '{"id":"A"}', 'order.id': 'A' });
    expect(inner.pass!.bindings).toEqual({ line: '{"id":"L1"}', 'line.id': 'L1' });
  });

  it('forEachPassOf answers with the pass the item is on, innermost first', () => {
    const state = createControlState();
    expect(forEachPassOf(FOREACH_LOOP, state, 'account')).toBeUndefined();
    enter(ROWS, state);
    expect(forEachPassOf(FOREACH_LOOP, state, 'account')).toBe(1);
    planAfterStep(FOREACH_LOOP, 1, state);
    planAfterGuard(FOREACH_LOOP, 0, { kind: 'resume' }, state);
    expect(forEachPassOf(FOREACH_LOOP, state, 'account')).toBe(2);
    expect(forEachPassOf(FOREACH_LOOP, state, 'nobody')).toBeUndefined();
  });
});

describe('what {{list}} must hold', () => {
  it('a JSON array of strings', () => {
    // `properties` rides alongside for object support
    // (SPEC-structured-table-reads.md §8.2); a scalar element has none, and
    // its entry is `undefined` rather than absent so the array stays parallel
    // to `items` and can be indexed by the cursor.
    expect(parseListValue('accounts', '["Savings","Everyday"]')).toEqual({
      items: ['Savings', 'Everyday'],
      properties: [undefined, undefined],
    });
  });

  it('a non-string element is bound as its JSON text', () => {
    expect(parseListValue('n', '[1, true, null, {"a":1}]')).toEqual({
      items: ['1', 'true', 'null', '{"a":1}'],
      // The object element keeps its base JSON binding AND gains a property
      // one — the base half is what this test has always asserted.
      properties: [undefined, undefined, undefined, { a: '1' }],
    });
  });

  it('anything else fails the line, quoting what it actually held', () => {
    const bad = parseListValue('accounts', 'Savings, Everyday');
    expect(bad).toHaveProperty('error');
    expect((bad as { error: string }).error).toContain('holds `Savings, Everyday`, not a list');
    expect((bad as { error: string }).error).toContain('a tool that returns an array');
  });

  it('a JSON scalar is not a list either', () => {
    expect(parseListValue('n', '"just a string"')).toHaveProperty('error');
    expect(parseListValue('n', '{"a":1}')).toHaveProperty('error');
  });

  it('an unset variable says so rather than quoting "undefined"', () => {
    const missing = parseListValue('accounts', undefined);
    expect((missing as { error: string }).error).toContain('has no value');
  });

  it('a long value is truncated in the message', () => {
    const err = (parseListValue('x', 'y'.repeat(200)) as { error: string }).error;
    expect(err).toContain('…');
    expect(err.length).toBeLessThan(300);
  });
});

describe('runs that start mid-structure', () => {
  it('starting inside a tail treats that guard as taken and skips its siblings', () => {
    const state = createControlState();
    // Line 5 is the first step of `Pay by card`.
    const plan = planForStart(CHAIN, 5, state);
    expect(plan.next).toBe(5);
    // The `Otherwise` and its body are ahead of us and must not run. The `If`
    // and its body are BEHIND us — outside the batch entirely — so they are
    // not re-reported here.
    expect(plan.skip).toEqual([[7, 8]]);
  });

  it('starting inside a loop body counts the partial pass as pass 1', () => {
    const state = createControlState();
    planForStart(WHILE_LOOP, 2, state);
    expect(state.passes.get(0)).toBe(1);
    // So the next time round is pass 2 — the count that lived in the batch
    // that was paused does not come back, and nothing pretends it did.
    const plan = planAfterGuard(WHILE_LOOP, 0, { kind: 'condition', holds: true }, state);
    expect(plan.pass).toEqual({ iteration: 2 });
  });

  it('starting inside a For each body resumes at the second element', () => {
    const state = createControlState();
    planForStart(FOREACH_LOOP, 1, state);
    expect(planAtGuard(FOREACH_LOOP, 0, state)).toEqual({ ask: 'list', list: 'accounts' });
    const plan = planAfterGuard(
      FOREACH_LOOP,
      0,
      { kind: 'list', items: ['a', 'b', 'c'] },
      state,
    );
    expect(plan.pass).toEqual({ iteration: 2, count: 3, bindings: { account: 'b' } });
  });

  it('starting outside every structure plans nothing', () => {
    expect(planForStart(CHAIN, 0, createControlState())).toEqual({ skip: [], next: 0 });
    expect(planForStart(CHAIN, 9, createControlState())).toEqual({ skip: [], next: 9 });
  });

  /**
   * The Electron debugger's jump-to-step calls `planForStart` against LIVE
   * state, and the rebuild it does there used to write `{items, index,
   * resumed}` — dropping `properties`, which is the only place the row's
   * dotted values live.
   *
   * Nothing failed at the jump. Every pass AFTER it bound the base name and no
   * dotted key, so `{{order.id}}` in the body resolved to whatever the last
   * pass before the jump had left in the map: the pre-jump row's id, on every
   * remaining row, silently.
   */
  it('a jump into a For each body keeps the rows properties', () => {
    const state = createControlState();
    const parsed = parseListValue('accounts', '[{"id":"A"},{"id":"B"},{"id":"C"}]');
    if ('error' in parsed) throw new Error(parsed.error);
    planAfterGuard(
      FOREACH_LOOP,
      0,
      { kind: 'list', items: parsed.items, properties: parsed.properties },
      state,
    );

    // The debugger jumps back into the body.
    planForStart(FOREACH_LOOP, 1, state);
    expect(state.cursors.get(0)!.properties).toEqual([{ id: 'A' }, { id: 'B' }, { id: 'C' }]);

    // …and the next pass binds its own row's property, not the previous one's.
    const next = planAfterGuard(FOREACH_LOOP, 0, { kind: 'resume' }, state);
    expect(next.pass!.bindings).toEqual({ account: '{"id":"B"}', 'account.id': 'B' });
  });
});

describe('nested structures', () => {
  /**
   * ```
   * 0  If cash, then Pay with cash        body 1..1   chain ends 6
   * 1    Click Pay now
   * 2  Otherwise, Pay by card             body 3..6
   * 3    Enter the card details
   * 4    If 3-D Secure, then Complete …   body 5..5   chain ends 5
   * 5      Click Confirm
   * 6    Click Pay now
   * ```
   */
  const NESTED: (ControlRecord | null)[] = [
    { kind: 'if', chainId: 'c1', condition: 'cash', bodyStart: 1, bodyEnd: 1, chainEnd: 6 },
    null,
    { kind: 'else', chainId: 'c1', bodyStart: 3, bodyEnd: 6, chainEnd: 6 },
    null,
    { kind: 'if', chainId: 'c2', condition: '3-D Secure', bodyStart: 5, bodyEnd: 5, chainEnd: 5 },
    null,
    null,
  ];

  it('the inner chain resolves without touching the outer one', () => {
    const plan = planAfterGuard(NESTED, 4, { kind: 'chain', selected: null }, createControlState());
    expect(plan).toEqual({ skip: [[4, 5]], next: 6, selected: null });
  });

  it('leaving the inner body continues inside the outer one', () => {
    expect(planAfterStep(NESTED, 5, createControlState())).toEqual({ next: 6 });
  });

  it('starting inside the inner body skips the outer chain`s siblings too', () => {
    const plan = planForStart(NESTED, 5, createControlState());
    // Nothing ahead of index 5 belongs to a sibling: the `If` member is behind.
    expect(plan.skip).toEqual([]);
    const fromOuter = planForStart(NESTED, 3, createControlState());
    expect(fromOuter.skip).toEqual([]);
  });

  /**
   * A loop whose body ends where the enclosing chain member's body ends. The
   * loop must win: the pass has ended, but the decision has not.
   * ```
   * 0  If a, then Helper       body 1..3   chain ends 3
   * 1    Click Start
   * 2    While b, Click More   body 3..3
   * 3      Click More
   * ```
   */
  const LOOP_IN_CHAIN: (ControlRecord | null)[] = [
    { kind: 'if', chainId: 'c1', condition: 'a', bodyStart: 1, bodyEnd: 3, chainEnd: 3 },
    null,
    { kind: 'while', condition: 'b', bodyStart: 3, bodyEnd: 3, label: 'Click More' },
    null,
  ];

  it('the innermost structure decides where a shared last step goes', () => {
    expect(planAfterStep(LOOP_IN_CHAIN, 3, createControlState())).toEqual({
      next: 2,
      reevaluate: 2,
    });
  });
});

describe('endAt snapping', () => {
  it('a guard snaps to the end of the structure it opens', () => {
    expect(snapEndAt(CHAIN, 1)).toBe(8);
    expect(snapEndAt(CHAIN, 4)).toBe(8);
    expect(snapEndAt(WHILE_LOOP, 0)).toBe(2);
    expect(snapEndAt(FOREACH_LOOP, 0)).toBe(1);
  });

  it('an ordinary step is left where it is', () => {
    expect(snapEndAt(CHAIN, 0)).toBe(0);
    expect(snapEndAt(CHAIN, 3)).toBe(3);
    expect(snapEndAt(CHAIN, 9)).toBe(9);
  });

  it('an index past the end is left alone', () => {
    expect(snapEndAt(CHAIN, 99)).toBe(99);
  });
});

/**
 * Every way a structure can END, checked from inside another structure.
 *
 * A guard's own record says where its body stops, and `bodyEnd + 1` /
 * `chainEnd + 1` is the right answer only at the top level. Inside anything it
 * walks OUT of the container: review 1 found all four exit paths doing that,
 * and every symptom was silent — a decision whose two branches both ran, an
 * outer loop that ran exactly one pass, an `Otherwise` evaluated after the run
 * had already decided against it. `exitFrom` is the one walk they all take now.
 */
describe('exits from inside a structure', () => {
  /**
   * The reviewer's shape (a): an inner chain with nothing holding and no
   * `Otherwise`, as the LAST step of an outer chain member.
   * ```
   * 0  If cash, then Pay by card          body 1..3   chain c1 ends 5
   * 1    Enter the card details
   * 2    If 3-D Secure, then Complete …   body 3..3   chain c2 ends 3
   * 3      Click Confirm
   * 4  Otherwise, Pay with cash           body 5..5   chain c1 ends 5
   * 5    Click Pay now
   * ```
   */
  const CHAIN_IN_CHAIN: (ControlRecord | null)[] = [
    { kind: 'if', chainId: 'c1', condition: 'cash', bodyStart: 1, bodyEnd: 3, chainEnd: 5 },
    null,
    { kind: 'if', chainId: 'c2', condition: '3-D Secure', bodyStart: 3, bodyEnd: 3, chainEnd: 3 },
    null,
    { kind: 'else', chainId: 'c1', bodyStart: 5, bodyEnd: 5, chainEnd: 5 },
    null,
  ];

  it('an inner chain that selects nothing leaves the OUTER chain too', () => {
    const plan = planAfterGuard(
      CHAIN_IN_CHAIN,
      2,
      { kind: 'chain', selected: null },
      createControlState(),
    );
    // NOT 4: index 4 is the outer `Otherwise`, already marked skipped when the
    // outer `If` was taken. Resuming there evaluates one decision twice and
    // runs both of its branches.
    expect(plan).toEqual({ skip: [[2, 3]], next: 6, selected: null });
  });

  /**
   * Shape (b): a `While` as the last step of a taken chain member, with an
   * `Otherwise` after it.
   * ```
   * 0  If cash, then Pay by card      body 1..3   chain ends 5
   * 1    Enter the card details
   * 2    While more, Click More       body 3..3
   * 3      Click More
   * 4  Otherwise, Pay with cash       body 5..5
   * 5    Click Pay now
   * ```
   */
  const LOOP_IN_TAKEN_MEMBER: (ControlRecord | null)[] = [
    { kind: 'if', chainId: 'c1', condition: 'cash', bodyStart: 1, bodyEnd: 3, chainEnd: 5 },
    null,
    { kind: 'while', condition: 'more', bodyStart: 3, bodyEnd: 3, label: 'Click More' },
    null,
    { kind: 'else', chainId: 'c1', bodyStart: 5, bodyEnd: 5, chainEnd: 5 },
    null,
  ];

  it('a loop that ends inside a taken member does not wake the Otherwise', () => {
    const state = createControlState();
    state.passes.set(2, 1);
    const plan = planAfterGuard(
      LOOP_IN_TAKEN_MEMBER,
      2,
      { kind: 'condition', holds: false },
      state,
    );
    expect(plan).toEqual({ skip: [], next: 6, loopEnded: { guard: 2, count: 1 } });
  });

  it('a cap breach leaves by the same door', () => {
    const state = createControlState(1);
    state.passes.set(2, 1);
    const plan = planAfterGuard(LOOP_IN_TAKEN_MEMBER, 2, { kind: 'condition', holds: true }, state);
    expect(plan).toEqual({
      skip: [],
      next: 6,
      capBreached: { cap: 1, source: 'config' },
    });
  });

  /**
   * Shape (c): a section whose LAST step is a `While`, called from another
   * loop's body — the natural shape of `While the list is loading, Refresh
   * page` where `### Refresh page` ends with a loop of its own.
   * ```
   * 0  While loading, Refresh page     body 1..3
   * 1    Click Refresh
   * 2    While spinner, Click Dismiss  body 3..3
   * 3      Click Dismiss
   * ```
   */
  const LOOP_IN_LOOP: (ControlRecord | null)[] = [
    { kind: 'while', condition: 'loading', bodyStart: 1, bodyEnd: 3, label: 'Refresh page' },
    null,
    { kind: 'while', condition: 'spinner', bodyStart: 3, bodyEnd: 3, label: 'Click Dismiss' },
    null,
  ];

  it('an inner loop that ends hands control back to the outer GUARD', () => {
    const state = createControlState();
    state.passes.set(0, 1);
    state.passes.set(2, 2);
    const plan = planAfterGuard(LOOP_IN_LOOP, 2, { kind: 'condition', holds: false }, state);
    // Not 4 (past the outer body): the outer loop has a pass to decide about.
    expect(plan).toEqual({ skip: [], next: 0, loopEnded: { guard: 2, count: 2 } });
  });

  /**
   * A `For each` in the same position: the exhausted exit is the fourth path.
   * ```
   * 0  While loading, Refresh page          body 1..3
   * 1    Click Refresh
   * 2    For each {{a}} in {{list}}, Check  body 3..3
   * 3      Check
   * ```
   */
  const FOREACH_IN_LOOP: (ControlRecord | null)[] = [
    { kind: 'while', condition: 'loading', bodyStart: 1, bodyEnd: 3, label: 'Refresh page' },
    null,
    { kind: 'foreach', item: 'a', list: 'list', bodyStart: 3, bodyEnd: 3, label: 'Check' },
    null,
  ];

  it('an exhausted For each hands control back to the outer guard', () => {
    const state = createControlState();
    state.cursors.set(2, { items: ['one'], index: 0, resumed: false });
    const plan = planAfterGuard(FOREACH_IN_LOOP, 2, { kind: 'resume' }, state);
    expect(plan).toEqual({ skip: [], next: 0, loopEnded: { guard: 2, count: 1 } });
  });

  it('an empty For each at the top of a loop body still skips its body', () => {
    const state = createControlState();
    const plan = planAfterGuard(FOREACH_IN_LOOP, 2, { kind: 'list', items: [] }, state);
    expect(plan).toEqual({ skip: [[3, 3]], next: 0, loopEnded: { guard: 2, count: 0 } });
  });

  it('at the top level the exit is still the next step', () => {
    expect(
      planAfterGuard(CHAIN_NO_ELSE, 1, { kind: 'chain', selected: null }, createControlState()),
    ).toEqual({ skip: [[1, 6]], next: 7, selected: null });
  });
});

/**
 * Re-entering a structure: the flat list does not grow when a loop runs again,
 * so a nested guard's pass counter and `For each` cursor are read a second time
 * at the same index. Both are cleared when a pass starts, or the second pass of
 * an outer loop runs a `For each` over nothing and counts a `While` from where
 * the previous pass left off — straight into its cap.
 */
describe('re-entering a structure', () => {
  const OUTER_WHILE_INNER_WHILE: (ControlRecord | null)[] = [
    { kind: 'while', condition: 'outer', bodyStart: 1, bodyEnd: 3, label: 'Outer' },
    { kind: 'while', condition: 'inner', bodyStart: 2, bodyEnd: 2, label: 'Inner' },
    null,
    null,
  ];

  const OUTER_WHILE_INNER_FOREACH: (ControlRecord | null)[] = [
    { kind: 'while', condition: 'outer', bodyStart: 1, bodyEnd: 3, label: 'Outer' },
    { kind: 'foreach', item: 'a', list: 'list', bodyStart: 2, bodyEnd: 2, label: 'Check' },
    null,
    null,
  ];

  /** Drive a records array to exhaustion, answering each guard as told. */
  function drive(
    controls: (ControlRecord | null)[],
    answer: (guard: number, ask: string) => GuardVerdict,
  ): { log: string[]; state: ControlState } {
    const state = createControlState();
    const log: string[] = [];
    let i = 0;
    for (let budget = 0; budget < 60 && i < controls.length; budget++) {
      if (controls[i]) {
        const request = planAtGuard(controls, i, state);
        const plan = planAfterGuard(controls, i, answer(i, request.ask), state);
        if (plan.pass) log.push(`guard ${i} pass ${plan.pass.iteration}`);
        if (plan.loopEnded) log.push(`guard ${i} ended after ${plan.loopEnded.count}`);
        if (plan.capBreached) log.push(`guard ${i} cap ${plan.capBreached.cap}`);
        i = plan.next;
        continue;
      }
      log.push(`exec ${i}`);
      const after = planAfterStep(controls, i, state);
      i = after ? after.next : i + 1;
    }
    return { log, state };
  }

  it('a nested While counts its passes per ENTRY, not per run', () => {
    let outer = 0;
    let inner = 0;
    const { log, state } = drive(OUTER_WHILE_INNER_WHILE, (guard) => {
      if (guard === 0) return { kind: 'condition', holds: ++outer <= 2 };
      // Holds on the first ask of each outer pass, false on the second.
      return { kind: 'condition', holds: ++inner % 2 === 1 };
    });
    expect(log).toEqual([
      'guard 0 pass 1',
      'guard 1 pass 1',
      'exec 2',
      'guard 1 ended after 1',
      'exec 3',
      'guard 0 pass 2',
      // …and not `pass 2`: this is the inner loop's first pass of this entry.
      'guard 1 pass 1',
      'exec 2',
      'guard 1 ended after 1',
      'exec 3',
      'guard 0 ended after 2',
    ]);
    expect(state.passes.get(1)).toBe(1);
  });

  it('a nested While gets its whole cap on every entry', () => {
    const state = createControlState(2);
    // Two passes already spent on the outer loop's first pass.
    state.passes.set(1, 2);
    const outerPass = planAfterGuard(
      OUTER_WHILE_INNER_WHILE,
      0,
      { kind: 'condition', holds: true },
      state,
    );
    expect(outerPass.pass).toEqual({ iteration: 1 });
    expect(state.passes.get(1)).toBeUndefined();
    const innerPass = planAfterGuard(
      OUTER_WHILE_INNER_WHILE,
      1,
      { kind: 'condition', holds: true },
      state,
    );
    expect(innerPass.capBreached).toBeUndefined();
    expect(innerPass.pass).toEqual({ iteration: 1 });
  });

  it('a nested For each runs its whole list on every outer pass', () => {
    let outer = 0;
    const { log } = drive(OUTER_WHILE_INNER_FOREACH, (guard, ask) => {
      if (guard === 0) return { kind: 'condition', holds: ++outer <= 2 };
      return ask === 'list' ? { kind: 'list', items: ['one', 'two'] } : { kind: 'resume' };
    });
    expect(log).toEqual([
      'guard 0 pass 1',
      'guard 1 pass 1',
      'exec 2',
      'guard 1 pass 2',
      'exec 2',
      'guard 1 ended after 2',
      'exec 3',
      'guard 0 pass 2',
      // The cursor was cleared, so the list is read again and BOTH items run.
      'guard 1 pass 1',
      'exec 2',
      'guard 1 pass 2',
      'exec 2',
      'guard 1 ended after 2',
      'exec 3',
      'guard 0 ended after 2',
    ]);
  });

  it('the second entry asks for the list again', () => {
    const state = createControlState();
    state.cursors.set(1, { items: ['one', 'two'], index: 2, resumed: false });
    expect(planAtGuard(OUTER_WHILE_INNER_FOREACH, 1, state).ask).toBe('nothing');
    planAfterGuard(OUTER_WHILE_INNER_FOREACH, 0, { kind: 'condition', holds: true }, state);
    expect(planAtGuard(OUTER_WHILE_INNER_FOREACH, 1, state)).toEqual({
      ask: 'list',
      list: 'list',
    });
  });
});

/**
 * A malformed `controls` array — a second `Otherwise`, a verdict naming a step
 * outside the chain — reaches the planner from the wire path or from a caller
 * bug, not from a file the parser accepted. None of it may hang a run or throw.
 */
describe('a malformed controls array', () => {
  /** Two `Otherwise` members in one chain. The parser refuses this and the
   *  expander does now too; the planner must still answer it the same way in
   *  both halves of its own API. */
  const TWO_ELSES: (ControlRecord | null)[] = [
    { kind: 'if', chainId: 'c1', condition: 'cash', bodyStart: 1, bodyEnd: 1, chainEnd: 5 },
    null,
    { kind: 'else', chainId: 'c1', bodyStart: 3, bodyEnd: 3, chainEnd: 5 },
    null,
    { kind: 'else', chainId: 'c1', bodyStart: 5, bodyEnd: 5, chainEnd: 5 },
    null,
  ];

  it('the fallback the request names is the fallback the plan takes', () => {
    const request = planAtGuard(TWO_ELSES, 0, createControlState());
    expect(request).toMatchObject({ ask: 'chain', fallback: 2 });
    const plan = planAfterGuard(
      TWO_ELSES,
      0,
      { kind: 'chain', selected: null },
      createControlState(),
    );
    expect(plan.selected).toBe(2);
    expect(plan.next).toBe(3);
  });

  it('a selection outside the chain is read as "none"', () => {
    // A backwards jump is an endless run, which is how this was found.
    const plan = planAfterGuard(CHAIN, 4, { kind: 'chain', selected: 1 }, createControlState());
    expect(plan).toEqual({ skip: [[4, 6]], next: 8, selected: 7 });
  });

  it('a selection past the end of the array does not throw', () => {
    const plan = planAfterGuard(
      CHAIN_NO_ELSE,
      1,
      { kind: 'chain', selected: 99 },
      createControlState(),
    );
    expect(plan).toEqual({ skip: [[1, 6]], next: 7, selected: null });
  });
});
