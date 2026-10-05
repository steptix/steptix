/**
 * `{{name.property}}` — the grammar, its copies, and what it substitutes into
 * (docs/specs/SPEC-structured-table-reads.md §8.3, §9.1; §12 item 18).
 *
 * The feature is one character wide and spread across five modules, which is
 * exactly the shape that goes wrong quietly: widen the substituter and forget
 * the checker and a step's text resolves while its actions do not; widen the
 * checker and forget the code-behind accounting and a compiled step inlines a
 * row's value as a literal. So the first half of this file is parity — one
 * corpus through every module that reads a reference — and the second is the
 * behaviour each of them owns.
 *
 * Parity is by SHARED SOURCE here rather than by hand-copied regex, which is
 * why these are behavioural assertions and not a string comparison: every
 * module in `src/` imports `PLACEHOLDER_SOURCE` from
 * `src/parser/parameters.ts`, so the corpus below proves the import is
 * actually in use rather than that two literals happen to match today.
 *
 * Two copies deliberately stay FLAT, and a test says so out loud further down:
 * a `Set {{name}} to …` target and a `For each {{item}} in {{list}}` header
 * are DEFINITIONS. A step writes a variable; it never writes one property of
 * one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleSteps } from '../src/mcp/assemble.js';
import { resolveProject } from '../src/mcp/project.js';
import {
  PLACEHOLDER_SOURCE,
  WIDE_PLACEHOLDER_SOURCE,
  interpolate,
  placeholderProperty,
  placeholderRoot,
} from '../src/parser/parameters.js';
import {
  collectReferences,
  dottedReferenceError,
  mapActionStrings,
  substituteAction,
  substituteAsLiterals,
  substituteText,
  walkActionStrings,
} from '../src/runner/placeholder-substitution.js';
import { referencedVariableNames } from '../src/skills/expander.js';
import { placeholderNamesIn } from '../src/codebehind/generate.js';
import { controlLineDefines, parseControlLine } from '../src/parser/control-line.js';
import { logger } from '../src/utils/logger.js';
// runner-core's SOURCE, not its `dist/` — the same reason
// tests/control-line-parity.test.ts states at its own import. Nothing on the
// root `npm test` path builds runner-core, so the compiled copy answers for
// whatever the mirror used to be: measured, putting `if (instruction) return
// null;` at the top of `parseControlLine` in runner-core/src/control-line.ts
// and running this file left it 53/53 green. Vitest transforms the `.ts` on
// the way in.
import { parseControlLine as coreParseControlLine } from '../runner-core/src/control-line.ts';
import { parseSetStep } from '../src/parser/set-step.js';
import type { AIAction } from '../src/ai/types.js';

// ───────────────────────────────────────────────────────────────────────────
// The grammar itself
// ───────────────────────────────────────────────────────────────────────────

/** `[text, the name it should be read as, or null for "not a reference"]`. */
const CORPUS: Array<[string, string | null]> = [
  // ── flat, exactly as before ───────────────────────────────────────────
  ['{{email}}', 'email'],
  ['{{__skill1_username}}', '__skill1_username'],
  ['{{a}}', 'a'],
  // `\w+` accepts a leading digit and always has — see the note on
  // `PLACEHOLDER_NAME_SOURCE`. Pinned so a later tightening is a decision
  // rather than a side effect.
  ['{{1st}}', '1st'],

  // ── one property segment ──────────────────────────────────────────────
  ['{{order.id}}', 'order.id'],
  ['{{order._row}}', 'order._row'],
  ['{{payment.next_payment}}', 'payment.next_payment'],
  ['{{_a._b}}', '_a._b'],
  ['{{o.p2}}', 'o.p2'],

  // ── and no more than one ──────────────────────────────────────────────
  ['{{order.address.city}}', null],
  // The property segment follows the identifier rule even though the root
  // does not: nothing accepted `{{order.1}}` before, so nothing is preserved
  // by accepting it now.
  ['{{order.1}}', null],
  ['{{order.}}', null],
  ['{{.id}}', null],
  ['{{order-id}}', null],
  ['{{order id}}', null],
];

describe('the grammar', () => {
  it('reads one property segment and no more', () => {
    const re = new RegExp(`^${PLACEHOLDER_SOURCE}$`);
    for (const [text, expected] of CORPUS) {
      expect(re.exec(text)?.[1] ?? null, text).toBe(expected);
    }
  });

  it('carries no whitespace inside the braces', () => {
    const re = new RegExp(`^${PLACEHOLDER_SOURCE}$`);
    expect(re.test('{{ order.id }}')).toBe(false);
    expect(re.test('{{order . id}}')).toBe(false);
    // The WIDE grammar is the checker's, and sees the spaced form on purpose
    // so a refusal can name the key rather than say nothing.
    expect(new RegExp(`^${WIDE_PLACEHOLDER_SOURCE}$`).exec('{{ order.id }}')?.[1]).toBe(
      'order.id',
    );
  });

  it('splits a name into its root and its property', () => {
    expect(placeholderRoot('order.id')).toBe('order');
    expect(placeholderProperty('order.id')).toBe('id');
    expect(placeholderRoot('order')).toBe('order');
    expect(placeholderProperty('order')).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Parity across the copies
// ───────────────────────────────────────────────────────────────────────────

describe('every module that reads a reference reads the same one', () => {
  /**
   * The names each module finds in one string.
   *
   * `token` is the corpus entry itself — `{{order.address.city}}` — which
   * `interpolate` needs and the rest ignore. See its own comment for why.
   */
  const readers: Array<
    [string, (text: string, expected: string | null, token: string) => string[]]
  > = [
    // src/parser/parameters.ts — the step text every run loop resolves.
    // Probed by SUBSTITUTION rather than by matching, because substituting is
    // what it is for: a name it recognises is replaced, one it does not is
    // left as written.
    //
    // The map is POPULATED for the negatives too, keyed on the token's own
    // inner text, and that is the only thing making the negative half of this
    // corpus mean anything. With `expected === null` handed an EMPTY map,
    // `interpolate` had nothing it could possibly substitute, so every
    // rejection passed for the wrong reason: a grammar widened to admit
    // `{{a.b.c}}` would have gone on passing this test, which is exactly the
    // mutation the corpus exists to catch. Keyed here, a widened grammar
    // substitutes `SUBSTITUTED` and the assertion fails.
    [
      'interpolate',
      (text, expected, token) => {
        const key = expected ?? token.replace(/^\{\{|\}\}$/g, '');
        const params = { [key]: 'SUBSTITUTED' };
        return interpolate(text, params).includes('SUBSTITUTED') ? [key] : [];
      },
    ],
    // src/runner/placeholder-substitution.ts — the checker's own reading.
    ['collectReferences', (text) => collectReferences(text).placeholders.map((p) => p.name)],
    // src/skills/expander.ts — what a step references, for scoping and for
    // the step prompt's `## Values` block.
    ['referencedVariableNames', (text) => referencedVariableNames(text).placeholders],
    // src/codebehind/generate.ts — the accounting and leak checks.
    ['placeholderNamesIn', (text) => placeholderNamesIn(text)],
  ];

  it('agrees on the whole corpus', () => {
    for (const [text, expected] of CORPUS) {
      const wrapped = `Verify ${text} is shown`;
      for (const [label, read] of readers) {
        expect(read(wrapped, expected, text), `${label} on ${text}`).toEqual(
          expected === null ? [] : [expected],
        );
      }
    }
  });

  it('substitutes the same names interpolate does', () => {
    const values = { order: '{"id":"A"}', 'order.id': 'A', email: 'a@b.c' };
    const text = 'Click {{order.id}} for {{email}} in {{order}} but not {{order.address.city}}';
    const expected = 'Click A for a@b.c in {"id":"A"} but not {{order.address.city}}';
    expect(interpolate(text, values)).toBe(expected);
    expect(substituteText(text, { parameters: values })).toBe(expected);
  });
});

/**
 * The fifth copy, `src/mcp/assemble.ts`, reached through the tool entry point
 * rather than by importing its private helper — the "will reach the AI
 * literally" pre-flight is the only thing that copy is for.
 *
 * The rule it needed is a subtraction, not an addition: `{{order.id}}` is
 * answered by a `For each` PASS, and a pre-flight over a step list has no
 * passes, so measuring it against the parameter map would warn on every
 * correct table loop (§8.2). What is still worth saying is that no loop in the
 * list binds the root at all.
 */
describe('the MCP pre-flight knows a dotted reference comes from a loop', () => {
  let root: string;
  const created: string[] = [];
  /** Whatever the environment held before; restored, not just deleted. */
  let savedRoots: string | undefined;

  beforeEach(() => {
    savedRoots = process.env['STEPTIX_MCP_ROOTS'];
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'steptix-dotted-')));
    created.push(root);
    writeFileSync(
      path.join(root, 'steptix.config.json'),
      JSON.stringify({}),
    );
    writeFileSync(path.join(root, '.env'), 'STEPTIX_SERVER_URL=http://127.0.0.1:3100\n');
    process.env['STEPTIX_MCP_ROOTS'] = root;
  });

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (savedRoots === undefined) delete process.env['STEPTIX_MCP_ROOTS'];
    else process.env['STEPTIX_MCP_ROOTS'] = savedRoots;
  });

  const warningsFor = async (steps: string[]): Promise<string> => {
    const run = await assembleSteps({ steps, resolveProject, projectRoot: root });
    return run.warnings.join('\n');
  };

  it('says nothing about a property of an item a For each in the list binds', async () => {
    const text = await warningsFor([
      'For each {{order}} in {{orders}}, Check the order',
      'Verify the row for "{{order.id}}" shows "{{order.status}}"',
    ]);
    expect(text).not.toContain('order.id');
    expect(text).not.toContain('order.status');
  });

  it('still reports a dotted reference whose root no loop binds', async () => {
    const text = await warningsFor(['Verify the row for "{{customer.id}}"']);
    expect(text).toContain('will reach the AI literally');
    expect(text).toContain('{{customer.id}}');
  });
});

/**
 * A `For each` header's item name is a DEFINITION, so it is not an unresolved
 * reference (`controlLineDefines`, src/parser/control-line.ts).
 *
 * Seen in a live Steptix run: the server logged
 * `[warn] Unresolved placeholder: {{payment}}` against the
 * `For each {{payment}} in {{payments}}` line, once per table loop, because
 * the Sessions API and the Electron loop resolve every step's text before the
 * control dispatch and the item is not bound until the first pass begins. It
 * is noise that reads like a diagnosis, on a line that is working correctly.
 *
 * All three loops that dispatch guards pass the set now — the CLI got it last,
 * and `tests/run-loop-contracts.test.ts` is what stops the next one shipping
 * in two of three. The CLI's own reachable case is narrower and its suite
 * spells it out: its guard branch `continue`s before the interpolation, so the
 * line only goes through this path when the run has no expanded controls.
 */
describe('a For each header does not warn about the item it is about to bind', () => {
  const warnings = (fn: () => void): string[] => {
    const seen: string[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation((message: string) => {
      seen.push(message);
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return seen;
  };

  it('names the item, and only the item', () => {
    expect(controlLineDefines('For each {{payment}} in {{payments}}, Review it')).toEqual(
      new Set(['payment']),
    );
    // Every other form defines nothing: an `If`'s condition and a `While`'s
    // are references like any other text.
    expect(controlLineDefines('If {{plan}} is "pro", then Upgrade')).toBeUndefined();
    expect(controlLineDefines('While {{more}} is "yes", Click Next')).toBeUndefined();
    expect(controlLineDefines('Click the Pay now button')).toBeUndefined();
  });

  it('stays silent on the header while the list is bound and the item is not', () => {
    const header = 'For each {{payment}} in {{payments}}, Review the payment';
    const params = { payments: '[{"id":"A"}]' };
    expect(warnings(() => interpolate(header, params, controlLineDefines(header)))).toEqual([]);
    // The exemption is the ONLY thing quietening it — without the set, this is
    // the line the live run produced.
    expect(warnings(() => interpolate(header, params))).toEqual([
      'Unresolved placeholder: {{payment}}',
    ]);
  });

  it('still warns about a genuinely unresolved name in an ordinary step', () => {
    expect(warnings(() => interpolate('Click {{nope}}', {}))).toEqual([
      'Unresolved placeholder: {{nope}}',
    ]);
    // …and in the header's own tail, where a reference is a reference.
    const header = 'For each {{payment}} in {{payments}}, Review {{nope}}';
    expect(warnings(() => interpolate(header, { payments: '[]' }, controlLineDefines(header)))).toEqual(
      ['Unresolved placeholder: {{nope}}'],
    );
  });

  it('exempts the warning without changing what is substituted', () => {
    // A previous loop over the same name leaves its last value in the map
    // (§8.2). What the header resolves to is unchanged by the exemption —
    // only the log line differs — because the loops use the interpolated text
    // for a partial-re-run probe and the authored text for the guard row.
    const header = 'For each {{payment}} in {{payments}}, Review it';
    const params = { payment: 'LEFTOVER', payments: '[]' };
    expect(interpolate(header, params, controlLineDefines(header))).toBe(
      interpolate(header, params),
    );
  });
});

describe('the two flat copies stay flat, because they are definitions', () => {
  it('`Set {{name}} to …` takes no dotted target', () => {
    expect(parseSetStep('Set {{summary}} to "done"')).toMatchObject({ name: 'summary' });
    // A step assigns a variable, never one property of one. Left unparsed, the
    // line is prose and the runtime says so — which is the honest answer to a
    // form that does not exist.
    expect(parseSetStep('Set {{order.id}} to "A"')).toBeNull();
  });

  it('`For each {{item}} in {{list}}` names two variables, not two paths', () => {
    expect(parseControlLine('For each {{order}} in {{orders}}, Check the order')).toMatchObject({
      kind: 'foreach',
      item: 'order',
      list: 'orders',
    });
    expect(parseControlLine('For each {{o.id}} in {{orders}}, Check')).toBeNull();
    expect(parseControlLine('For each {{order}} in {{rows.orders}}, Check')).toBeNull();
  });

  /**
   * runner-core's only braces are the `For each` header's — a hand mirror of
   * `src/parser/control-line.ts` that `tests/control-line-parity.test.ts`
   * already compares field by field. It carries NO copy of the reference
   * grammar (nothing in the extension resolves a `{{name}}`; the server does),
   * so there was nothing there to widen. This is the tripwire that says so: if
   * a mirror ever appears, these two answers diverge and someone comes back
   * here to add a real parity corpus.
   */
  it('runner-core"s mirror stays flat too, on the same lines', () => {
    expect(coreParseControlLine('For each {{order}} in {{orders}}, Check the order')).toMatchObject(
      { kind: 'foreach', item: 'order', list: 'orders' },
    );
    expect(coreParseControlLine('For each {{o.id}} in {{orders}}, Check')).toBeNull();
    expect(coreParseControlLine('For each {{order}} in {{rows.orders}}, Check')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Substitution: step text, action leaves, and the one field that is a name
// ───────────────────────────────────────────────────────────────────────────

describe('dotted placeholders substitute in every string leaf of an action', () => {
  const values = {
    parameters: {
      order: '{"id":"ORD-1001","status":"Completed"}',
      'order.id': 'ORD-1001',
      'order.status': 'Completed',
    },
  };

  it('reaches selector, value, url, expected and a nested body', () => {
    const action = {
      action: 'type',
      selector: 'tr:has-text("{{order.id}}") input',
      value: '{{order.status}}',
      url: 'https://example.com/orders/{{order.id}}',
      expected: 'Order {{order.id}} is {{order.status}}',
      body: { id: '{{order.id}}', nested: { status: '{{order.status}}' } },
    } as unknown as AIAction;

    expect(substituteAction(action, values)).toEqual({
      action: 'type',
      selector: 'tr:has-text("ORD-1001") input',
      value: 'Completed',
      url: 'https://example.com/orders/ORD-1001',
      expected: 'Order ORD-1001 is Completed',
      body: { id: 'ORD-1001', nested: { status: 'Completed' } },
    });
  });

  it('leaves `as` alone, because it names the variable the step writes', () => {
    const action = { action: 'read', selector: '#x', as: 'order.id' } as unknown as AIAction;
    expect(substituteAction(action, values)).toBe(action);
  });

  /**
   * §9.1: substitution walks `columns[].header`, never `columns[].key`.
   *
   * Hand-built, because the `readTable` action type is the other half of phase
   * 1 and may not exist yet. That is also why the exclusion keys on the field
   * name rather than on `action === 'readTable'` — this object proves the rule
   * without the vocabulary.
   */
  it('walks columns[].header but never columns[].key', () => {
    const action = {
      action: 'readTable',
      selector: 'table[aria-label="Orders"]',
      columns: [
        { header: 'Order for {{order.id}}', key: 'id' },
        // A key that LOOKS like a reference is still a name. Substituting it
        // would rename the property every later `{{row.key}}` reads.
        { header: 'Status', key: '{{order.status}}' },
        { index: 3, key: 'amount' },
      ],
      as: 'orders',
    } as unknown as AIAction;

    const out = substituteAction(action, values) as unknown as {
      columns: Array<{ header?: string; key: string; index?: number }>;
    };
    expect(out.columns).toEqual([
      { header: 'Order for ORD-1001', key: 'id' },
      { header: 'Status', key: '{{order.status}}' },
      { index: 3, key: 'amount' },
    ]);
  });

  it('never OFFERS columns[].key to the walk, so the checker cannot refuse it', () => {
    const action = {
      action: 'readTable',
      selector: '#orders',
      columns: [{ header: '{{order.id}}', key: '{{nobody}}' }],
      as: 'orders',
    } as unknown as AIAction;

    const seen: string[] = [];
    walkActionStrings(action, (text) => seen.push(text));
    expect(seen).toContain('{{order.id}}');
    expect(seen).not.toContain('{{nobody}}');
  });

  it('keeps the identity-preserving contract with the exclusion in place', () => {
    const action = {
      action: 'readTable',
      selector: '#orders',
      columns: [{ header: 'Status', key: 'status' }],
      as: 'orders',
    } as unknown as AIAction;
    expect(mapActionStrings(action, (t) => t)).toBe(action);
  });
});

describe('the empty-value rule (§8.3)', () => {
  it('an empty binding substitutes to nothing, and nothing else changes', () => {
    const values = { parameters: { payment: '{"reference":""}', 'payment.reference': '' } };
    expect(substituteText('If "{{payment.reference}}" is empty', values)).toBe(
      'If "" is empty',
    );
    // Unquoted, the condition reads oddly and that is the documented v1
    // answer: `Type {{payment.reference}} into the field` typing two quote
    // marks would be worse (§14, first deferred item).
    expect(substituteText('If {{payment.reference}} is empty', values)).toBe(
      'If  is empty',
    );
  });

  it('an empty binding is a value, not a missing one', () => {
    expect(
      dottedReferenceError('If "{{payment.reference}}" is empty', {
        'payment.reference': '',
      }),
    ).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The strict path: a dotted reference with no binding
// ───────────────────────────────────────────────────────────────────────────

describe('a missing dotted binding fails before the model is asked', () => {
  const ROW = {
    order: '{"id":"ORD-1001","customer":"Alice Smith","status":"Completed"}',
    'order.id': 'ORD-1001',
    'order.customer': 'Alice Smith',
    'order.status': 'Completed',
  };

  it('uses the spec"s sentence, naming the pass and the properties it has', () => {
    expect(
      dottedReferenceError('Verify {{order.statuz}} equals "Completed"', ROW, () => 2),
    ).toBe(
      '{{order.statuz}} has no value in For each item 2; available properties are id, customer, status',
    );
  });

  it('leaves the pass clause out when nothing can say which pass it is', () => {
    expect(dottedReferenceError('Verify {{order.statuz}}', ROW)).toBe(
      '{{order.statuz}} has no value; available properties are id, customer, status',
    );
  });

  it('says so plainly when nothing binds the root at all', () => {
    expect(dottedReferenceError('Verify {{customer.name}}', ROW)).toBe(
      '{{customer.name}} has no value; nothing in this run binds {{customer}}',
    );
  });

  it('distinguishes a root that is bound but holds no properties', () => {
    expect(dottedReferenceError('Verify {{name.id}}', { name: 'Alice' })).toBe(
      '{{name.id}} has no value; {{name}} holds no properties — it is not an object',
    );
  });

  /**
   * A key the loop DROPPED, named where the author will look for it.
   *
   * `content-type` binds nothing — no placeholder can spell it — so without
   * this the message lists the properties that do exist and leaves the author
   * hunting for a typo in a name that was never going to work. The row's own
   * JSON is the base binding, so the keys are in hand here with nothing
   * threaded through the loops to fetch them.
   */
  it('names the keys a placeholder cannot spell, beside the ones it can', () => {
    const MIXED = {
      order: '{"id":"A","status":"x","content-type":"t","Order ID":"1"}',
      'order.id': 'A',
      'order.status': 'x',
    };
    expect(dottedReferenceError('Verify {{order.contenttype}}', MIXED, () => 1)).toBe(
      '{{order.contenttype}} has no value in For each item 1; available properties are ' +
        'id, status (content-type, Order ID cannot be spelled as placeholders)',
    );
  });

  it('says so plainly when NO key of the row can be spelled', () => {
    expect(
      dottedReferenceError('Verify {{order.contenttype}}', {
        order: '{"content-type":"t"}',
      }),
    ).toBe(
      '{{order.contenttype}} has no value; {{order}} has no properties that can be ' +
        'spelled as placeholders (content-type)',
    );
  });

  it('is silent on a dotted reference that resolves', () => {
    expect(dottedReferenceError('Verify {{order.status}}', ROW, () => 2)).toBeUndefined();
    expect(dottedReferenceError('Click Review', ROW)).toBeUndefined();
  });

  /**
   * The asymmetry is the design, not an oversight: an unresolved FLAT name is
   * old ground with its own warning and its own callers, and failing it here
   * would fail runs this feature never touched.
   */
  it('leaves an unresolved FLAT name exactly as it was', () => {
    expect(dottedReferenceError('Verify {{nothing_at_all}}', ROW)).toBeUndefined();
    expect(interpolate('Verify {{nothing_at_all}}', ROW)).toBe('Verify {{nothing_at_all}}');
  });

  it('reports the FIRST unanswerable reference, so one refusal names one fix', () => {
    expect(dottedReferenceError('{{order.statuz}} and {{order.custmer}}', ROW, () => 1)).toBe(
      '{{order.statuz}} has no value in For each item 1; available properties are id, customer, status',
    );
  });

  /**
   * A root whose NAME is a key of `Object.prototype`.
   *
   * `parameters[root]` is a plain object index, so `{{constructor.id}}` got
   * the `Object` function back from a map that binds nothing of the sort, and
   * `rootValue.startsWith('{')` threw a TypeError. The throw escaped: this
   * function is called from `runTest`'s try/finally with no catch, and from
   * the guard loop OUTSIDE `evaluateGuard`'s try — so a step or a condition
   * naming one of four ordinary English words killed the run with no report,
   * where every other unanswerable reference is a refusal.
   *
   * Nothing exotic reaches it. `{{constructor.name}}` is a plausible thing to
   * write about a page, and `{{valueOf.x}}` needs only a typo.
   */
  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'refuses {{%s.id}} with the ordinary sentence rather than throwing',
    (root) => {
      expect(dottedReferenceError(`Verify {{${root}.id}} is shown`, ROW)).toBe(
        `{{${root}.id}} has no value; nothing in this run binds {{${root}}}`,
      );
    },
  );

  it('reads the ROOT"s own binding by own-property too, not off the prototype', () => {
    // The same index one level in: the root IS bound here, so the refusal
    // reaches `unspellableKeysOf` — which is where the throw happened.
    expect(
      dottedReferenceError('Verify {{toString.id}}', { toString: '{"a-b":"1"}' }),
    ).toBe(
      '{{toString.id}} has no value; {{toString}} has no properties that can be ' +
        'spelled as placeholders (a-b)',
    );
  });

  /**
   * The same hazard at the SUBSTITUTION sites, which is how it reaches the
   * page rather than the log: `{{constructor}}` typed
   * `function Object() { [native code] }` into a field, and
   * `substituteAsLiterals` threw `value.includes is not a function` deciding
   * a condition.
   */
  it('leaves a prototype-named FLAT reference literal at every substitution site', () => {
    expect(substituteText('Verify {{constructor}} is shown', { parameters: {} })).toBe(
      'Verify {{constructor}} is shown',
    );
    expect(substituteAsLiterals('If {{constructor}} is "x"', { parameters: {} })).toEqual({
      text: 'If {{constructor}} is "x"',
      references: 1,
      unspellable: false,
    });
    // `interpolate` is the step text's own copy of the rule (`key in params`
    // walked the prototype chain there too).
    expect(interpolate('Verify {{toString}} is shown', {})).toBe(
      'Verify {{toString}} is shown',
    );
  });

  it('warns about a prototype-named reference exactly as about any other unresolved one', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      interpolate('Verify {{constructor}} is shown', {});
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        'Unresolved placeholder: {{constructor}}',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * `{}` is a record. It just has nothing in it.
   *
   * The catch-all said `{{order}} holds no properties — it is not an object`,
   * whose second clause is false about the one value it is asserting over —
   * and false in the direction that sends the author looking for the wrong
   * mistake (a `readTable` that returned rows, when what they have is a row
   * that matched no columns).
   */
  it('says what is true about a root bound to an empty record', () => {
    expect(dottedReferenceError('Verify {{order.id}}', { order: '{}' })).toBe(
      '{{order.id}} has no value; {{order}} is a record with no properties',
    );
  });

  /**
   * A root that was CAPTURED rather than bound by a `For each`.
   *
   * `[store as: order]` over a `readTable` row, or a tool that returns one
   * object, puts a RECORD under a flat name and no dotted keys beside it —
   * because only a loop pass writes those (§8.2). Both of the sentences the
   * catch-all reached for were then false about the value in hand: `{"id":"A"}`
   * was refused as "holds no properties — it is not an object", and
   * `{"content-type":"t","id":"A"}` as "has no properties that can be spelled
   * as placeholders (content-type)" — while `id` is spellable and is the very
   * property the author asked for. Either sends the reader to look for a typo
   * or a broken capture, when the real rule is that a record's properties are
   * only addressable inside the loop that binds them.
   */
  it('tells a captured record the true rule, rather than denying it is an object', () => {
    expect(dottedReferenceError('Verify {{order.id}}', { order: '{"id":"A"}' })).toBe(
      '{{order.id}} has no value; {{order}} holds a record, but only a For each ' +
        "item's properties can be referenced as {{order.<property>}}",
    );
  });

  it('keeps the unspellable aside for the keys that genuinely cannot be spelled', () => {
    expect(
      dottedReferenceError('Verify {{order.id}}', {
        order: '{"content-type":"t","id":"A"}',
      }),
    ).toBe(
      '{{order.id}} has no value; {{order}} holds a record, but only a For each ' +
        "item's properties can be referenced as {{order.<property>}} " +
        '(content-type cannot be spelled as a placeholder)',
    );
  });

  it('pluralises that aside, and still says nothing untrue about the spellable keys', () => {
    expect(
      dottedReferenceError('Verify {{order.id}}', {
        order: '{"content-type":"t","Order ID":"1","id":"A"}',
      }),
    ).toBe(
      '{{order.id}} has no value; {{order}} holds a record, but only a For each ' +
        "item's properties can be referenced as {{order.<property>}} " +
        '(content-type, Order ID cannot be spelled as placeholders)',
    );
  });

  it('keeps the existing sentence for a root that really is not an object', () => {
    expect(dottedReferenceError('Verify {{order.id}}', { order: 'Alice' })).toBe(
      '{{order.id}} has no value; {{order}} holds no properties — it is not an object',
    );
    expect(dottedReferenceError('Verify {{order.id}}', { order: '[1,2]' })).toBe(
      '{{order.id}} has no value; {{order}} holds no properties — it is not an object',
    );
    // Not-JSON-at-all is the same answer: there is no record here either.
    expect(dottedReferenceError('Verify {{order.id}}', { order: '{not json' })).toBe(
      '{{order.id}} has no value; {{order}} holds no properties — it is not an object',
    );
  });
});

/**
 * The refusal is written from the run's VALUES, so it is masked
 * (stories/placeholder-preserving-actions.md; `src/utils/secrets.ts`).
 *
 * It names the properties the row does hold and the keys the loop dropped,
 * and a key can carry a secret — `{"hunter2 header": "…"}` where `hunter2` is
 * what `{{password}}` holds. Round 2 masked `evaluateGuard`'s `… cannot be
 * referenced as a placeholder` line for exactly this and left the refusal,
 * which is the louder of the two: it is a `logger.error`, a `StepResult.error`
 * and (on the server) a `step:fail` wire payload.
 */
describe('the refusal is masked', () => {
  const SECRET_KEY = {
    password: 'hunter2',
    order: '{"id":"A","hunter2 header":"t"}',
    'order.id': 'A',
  };

  it('masks a secret value that turns up in a dropped key, with no masker passed', () => {
    expect(dottedReferenceError('Verify {{order.contenttype}}', SECRET_KEY)).toBe(
      '{{order.contenttype}} has no value; available properties are id ' +
        '(*** header cannot be spelled as a placeholder)',
    );
  });

  it('uses the masker the run loop hands it, when one is handed', () => {
    // Each loop has its own — the server's counts a section row's frame
    // inputs as well as the parameter map — so the argument is what decides,
    // not the fallback.
    expect(
      dottedReferenceError('Verify {{order.contenttype}}', SECRET_KEY, undefined, (text) =>
        text.replace(/hunter2/g, '[MASKED]'),
      ),
    ).toBe(
      '{{order.contenttype}} has no value; available properties are id ' +
        '([MASKED] header cannot be spelled as a placeholder)',
    );
  });

  it('leaves a refusal with no secret in it exactly as it was', () => {
    expect(
      dottedReferenceError('Verify {{order.statuz}}', {
        password: 'hunter2',
        order: '{"id":"A"}',
        'order.id': 'A',
      }),
    ).toBe('{{order.statuz}} has no value; available properties are id');
  });
});

/**
 * `{{ order.id }}` — the right name, the wrong spelling.
 *
 * `WIDE_PLACEHOLDER_SOURCE`'s docstring promises exactly this: a reference
 * with spaces inside its braces is "seen here and refused with the correct key
 * named, rather than slipping through and being typed into the page as literal
 * text". `checkOneString` and `resolveSetTemplate` both keep that promise for
 * what the MODEL wrote; this is the same sentence for what the AUTHOR wrote,
 * which nothing checked — `interpolate` substitutes on the NARROW grammar and
 * leaves it alone, and the refusal `continue`d past it the moment the name
 * happened to resolve. The braces reached the model, which is the failure this
 * whole module exists to prevent.
 *
 * DOTTED only, for the reason the rest of the file gives: a flat `{{ name }}`
 * is old ground, it has behaved this way since before any of this existed, and
 * tightening it would fail runs this feature never touched. The test below
 * pins that behaviour rather than improving it.
 */
describe('a dotted reference spelled with spaces is refused, not left literal', () => {
  const ROW = {
    order: '{"id":"ORD-1001","status":"Completed"}',
    'order.id': 'ORD-1001',
    'order.status': 'Completed',
  };

  it('refuses the spelling even when the name itself resolves', () => {
    expect(dottedReferenceError('Verify {{ order.id }} is shown', ROW)).toBe(
      'This line wrote `{{ order.id }}`. A placeholder carries no spaces inside ' +
        'its braces — write `{{order.id}}`.',
    );
  });

  it('refuses it when the name does NOT resolve, naming the same spelling', () => {
    // Before the spelling is worth talking about, the name has to be one the
    // author can act on — so the spacing sentence comes first either way,
    // rather than a "has no value" about a name they did not write.
    expect(dottedReferenceError('Verify {{ order.statuz }} is shown', ROW)).toBe(
      'This line wrote `{{ order.statuz }}`. A placeholder carries no spaces inside ' +
        'its braces — write `{{order.statuz}}`.',
    );
  });

  it('leaves the canonical spelling alone, substitution included', () => {
    expect(dottedReferenceError('Verify {{order.id}} is shown', ROW)).toBeUndefined();
    expect(interpolate('Verify {{order.id}} is shown', ROW)).toBe(
      'Verify ORD-1001 is shown',
    );
  });

  it('leaves a FLAT `{{ name }}` exactly as it is today', () => {
    // Pinned, not endorsed: no refusal, no substitution, no warning — the
    // legacy answer for a flat name, unchanged by this feature.
    expect(dottedReferenceError('Verify {{ name }} is shown', { name: 'Alice' })).toBeUndefined();
    expect(interpolate('Verify {{ name }} is shown', { name: 'Alice' })).toBe(
      'Verify {{ name }} is shown',
    );
  });
});

/**
 * `{{order.address.city}}` matches NEITHER grammar, so before this it was
 * neither substituted nor warned about as unresolved — it simply stayed in the
 * step text and reached the model as six literal braces.
 *
 * That is the quietest possible failure for what is obviously an attempt at a
 * reference: the author reads a step that did not do what it says and nothing
 * anywhere says why. One property segment is the v1 rule (§8.2), so the
 * warning names the rule rather than guessing at a typo.
 */
describe('a brace token with more than one property segment says so', () => {
  const warnings = (fn: () => void): string[] => {
    const seen: string[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation((message: string) => {
      seen.push(message);
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return seen;
  };

  it('warns once per name, and still leaves the text alone', () => {
    expect(warnings(() => interpolate('Check {{a.b.c}}', {}))).toEqual([
      '{{a.b.c}} is not a placeholder: only one property segment is supported',
    ]);
    expect(interpolate('Check {{a.b.c}}', {})).toBe('Check {{a.b.c}}');
    // The same reference twice on one line is one mistake.
    expect(warnings(() => interpolate('{{a.b.c}} then {{a.b.c}}', {}))).toEqual([
      '{{a.b.c}} is not a placeholder: only one property segment is supported',
    ]);
    // Two different ones are two.
    expect(warnings(() => interpolate('{{a.b.c}} and {{x.y.z.w}}', {}))).toEqual([
      '{{a.b.c}} is not a placeholder: only one property segment is supported',
      '{{x.y.z.w}} is not a placeholder: only one property segment is supported',
    ]);
  });

  it('says nothing about the forms that ARE placeholders', () => {
    expect(warnings(() => interpolate('Check {{a.b}}', { 'a.b': 'x' }))).toEqual([]);
    expect(warnings(() => interpolate('Check {{a}}', { a: 'x' }))).toEqual([]);
    // A one-segment name with no value keeps its own, older warning and gains
    // no second one.
    expect(warnings(() => interpolate('Check {{a.b}}', {}))).toEqual([
      'Unresolved placeholder: {{a.b}}',
    ]);
  });

  it('says nothing about braces that were never a reference', () => {
    expect(warnings(() => interpolate('Verify the page shows {{ a b c }}', {}))).toEqual([]);
    expect(warnings(() => interpolate('Verify the JSON {"a":{"b":1}}', {}))).toEqual([]);
  });
});
