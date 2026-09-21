/**
 * The rules every run loop has to follow identically, and the mechanical
 * proof that each of them does.
 *
 * There are three loops that dispatch control flow — the CLI
 * (`src/runner/test-runner.ts`), the Sessions API
 * (`src/server/session-manager.ts`) and the Electron UI
 * (`src/ui/main/runner-adapter.ts`) — and the recurring defect in this feature
 * is not a wrong rule, it is a right rule applied in two loops out of three.
 * `controlLineDefines` shipped in two of them and the CLI went on logging
 * `Unresolved placeholder: {{payment}}` on every table loop. The pass-binding
 * write was `Object.assign` in all three, which is how a missing property read
 * the previous row's value everywhere at once.
 *
 * So each loop's own suite asserts the BEHAVIOUR, and this file asserts the
 * shared mechanism is the one they all reach for — the cheap check that a
 * fourth loop, or a revert of one of the three, cannot pass.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyPassBindings, evaluateGuard } from '../src/runner/control-runtime.js';
import { substituteText } from '../src/runner/placeholder-substitution.js';
import {
  createControlState,
  planAfterStep,
  type ControlRecord,
  type ControlState,
} from '../src/runner/control-flow.js';
import { logger } from '../src/utils/logger.js';

const ROOT = path.resolve(__dirname, '..');

/** The three loops that own a `controls` array and visit guards. */
const RUN_LOOPS = [
  'src/runner/test-runner.ts',
  'src/server/session-manager.ts',
  'src/ui/main/runner-adapter.ts',
] as const;

const source = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// What one pass writes, and what it must therefore erase
// ───────────────────────────────────────────────────────────────────────────

describe('applyPassBindings', () => {
  it('clears the previous pass dotted keys for the root it is binding', () => {
    const map: Record<string, string> = {};
    applyPassBindings(map, { row: '{"id":"A","note":"first"}', 'row._row': '1', 'row.id': 'A', 'row.note': 'first' });
    // Pass 2's row has no `note` at all.
    applyPassBindings(map, { row: '{"id":"B"}', 'row._row': '2', 'row.id': 'B' });

    expect(map).toEqual({ row: '{"id":"B"}', 'row._row': '2', 'row.id': 'B' });
    // The point: `{{row.note}}` is now ABSENT, so §8.3's refusal can fire.
    // With `Object.assign` it held `first` — the previous row's note,
    // presented as this row's.
    expect(Object.hasOwn(map, 'row.note')).toBe(false);
  });

  it('leaves every other root alone, and every flat name', () => {
    const map: Record<string, string> = {
      email: 'a@b.c',
      'order.id': 'ORD-1',
      order: '{"id":"ORD-1"}',
      'row.id': 'A',
    };
    applyPassBindings(map, { row: 'plain' });
    expect(map).toEqual({
      email: 'a@b.c',
      'order.id': 'ORD-1',
      order: '{"id":"ORD-1"}',
      row: 'plain',
    });
  });

  it('is what makes a second loop over scalars stop answering with the first loop"s row', () => {
    // Two `For each` loops, same item name — the reachable-without-a-debugger
    // version of the bug. The first is over records, the second over strings.
    const map: Record<string, string> = {};
    applyPassBindings(map, { row: '{"id":"A"}', 'row.id': 'A' });
    applyPassBindings(map, { row: 'Everyday' });
    expect(Object.hasOwn(map, 'row.id')).toBe(false);
  });

  it('still leaves the LAST pass"s bindings in place after the loop (§8.2)', () => {
    // Nothing clears on exit: the clear happens when the same root is bound
    // AGAIN, so a step after the loop reads the last row exactly as it always
    // has — dotted keys included.
    const map: Record<string, string> = {};
    applyPassBindings(map, { row: '{"id":"A"}', 'row.id': 'A' });
    applyPassBindings(map, { row: '{"id":"B"}', 'row.id': 'B' });
    expect(map).toEqual({ row: '{"id":"B"}', 'row.id': 'B' });
  });

  /**
   * A pass whose ITEM is called `__proto__`.
   *
   * `passBindings` builds its object with a COMPUTED key, so `__proto__` is a
   * genuine own property of the bindings — and `Object.assign` then wrote it
   * through `Object.prototype`'s setter, which ignores a string. The flat
   * `{{__proto__}}` silently held nothing while `{{__proto__.id}}` (an
   * ordinary key) resolved: half a pass bound, with no error anywhere.
   *
   * `For each {{__proto__}} in {{orders}}` parses today — the item grammar is
   * `[A-Za-z_]\w*` — so nothing upstream stops it arriving here.
   */
  it('binds an item named __proto__ as an own property, not through the setter', () => {
    const map: Record<string, string> = {};
    // Computed keys, exactly as `passBindings` builds them: a plain
    // `{ __proto__: … }` literal would set the prototype instead.
    applyPassBindings(map, { ['__proto__']: '{"id":"A"}', ['__proto__.id']: 'A' });

    expect(Object.hasOwn(map, '__proto__')).toBe(true);
    expect(map['__proto__']).toBe('{"id":"A"}');
    // The map is still a plain object — nothing was written to its prototype.
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    // And the whole pass is visible, not the half of it that happened to be
    // spelled ordinarily.
    expect(substituteText('{{__proto__}} / {{__proto__.id}}', { parameters: map })).toBe(
      '{"id":"A"} / A',
    );
  });

  it('clears that root"s dotted keys on the next pass, like any other', () => {
    const map: Record<string, string> = {};
    applyPassBindings(map, { ['__proto__']: '{"id":"A","note":"first"}', ['__proto__.id']: 'A', ['__proto__.note']: 'first' });
    applyPassBindings(map, { ['__proto__']: '{"id":"B"}', ['__proto__.id']: 'B' });
    expect(Object.hasOwn(map, '__proto__.note')).toBe(false);
    expect(map['__proto__']).toBe('{"id":"B"}');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Every write into the live variable map goes through the one helper
// ───────────────────────────────────────────────────────────────────────────

/**
 * A rebind of a ROOT erases that root's dotted keys
 * (docs/specs/SPEC-structured-table-reads.md §8.2).
 *
 * `applyPassBindings` and `runSetStep` honoured it and every other write into
 * the live map was a plain `resolvedParameters[name] = value`: a `read … [store
 * as: order]` after a `For each {{order}} …` left the last pass's `order.id`
 * in place, so `{{order.id}}` went on substituting a row the author had just
 * overwritten and §8.3's refusal could not fire — the failure is silent and
 * correct-looking, which is why it needs a mechanical check rather than a
 * fixed list of the sites anyone has thought of.
 *
 * Same shape of canary as `tests/substitution-sites.test.ts`: it cannot see an
 * aliased helper or a dynamic write, only a bare indexed assignment into a map
 * this feature's rule owns. That is the write that keeps being added.
 */
describe('no run loop writes the live variable map by bare assignment', () => {
  /** The files that hold a live `{{…}}` map and write captures into it. */
  const WRITE_SITES = [
    'src/runner/step-executor.ts',
    'src/runner/test-runner.ts',
    'src/runner/set-step-runner.ts',
    'src/runner/control-runtime.ts',
    'src/server/session-manager.ts',
    'src/server/errand-runner.ts',
    'src/ui/main/runner-adapter.ts',
    'src/tools/executor.ts',
    'src/codebehind/execute.ts',
  ] as const;

  /** `resolvedParameters[x] = …` / `scope[x] = …`, however it is reached. */
  const BARE_WRITE = /\b(?:this\.|opts\.|options\.)?(?:resolvedParameters|scope)\s*\[[^\]\n]*\]\s*=[^=]/;

  it.each(WRITE_SITES)('%s writes through bindVariable', (file) => {
    const offending = source(file)
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false;
        return BARE_WRITE.test(line);
      })
      .map(([n, line]) => `${file}:${n}: ${line.trim()}`);

    expect(
      offending,
      'A bare indexed write into the live variable map. Use `bindVariable` ' +
        '(src/parser/parameters.ts), which does the own-property write AND ' +
        'clears the root"s dotted keys — otherwise a capture that rebinds a ' +
        'loop"s item name leaves the last pass"s `item.property` behind.',
    ).toEqual([]);
  });

  /**
   * …and the helper lives somewhere a `Set` step can reach.
   *
   * `runSetStep` is the "no page, no model, no cache" module all four run
   * loops share. Importing the helper from `control-runtime.ts` pulled
   * `step-executor.ts` in with it — Playwright, the AI client, the DOM
   * cleaner — into a module whose whole claim is that it needs none of them.
   */
  it('set-step-runner reaches it without importing the control runtime', () => {
    const body = source('src/runner/set-step-runner.ts');
    expect(body).toContain("from '../parser/parameters.js'");
    expect(body).not.toMatch(/from '\.\/control-runtime\.js'/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// …in every loop, not two of three
// ───────────────────────────────────────────────────────────────────────────

describe('every run loop writes a pass"s bindings through the helper', () => {
  it.each(RUN_LOOPS)('%s calls applyPassBindings', (file) => {
    const body = source(file);
    expect(body, `${file} must import applyPassBindings`).toContain('applyPassBindings');
    // The write itself, not just an import.
    expect(body).toMatch(/applyPassBindings\(\s*(this\.)?resolvedParameters,\s*plan\.pass\.bindings/);
  });

  it.each(RUN_LOOPS)('%s no longer merges bindings with Object.assign', (file) => {
    // The exact line each loop used to carry. `Object.assign` cannot delete,
    // so it cannot honour a row that omits a property.
    expect(source(file)).not.toMatch(/Object\.assign\([^)]*plan\.pass\.bindings/);
  });
});

/**
 * A flow-control condition is decided in ONE place — `executeStep` — because
 * `If {{payment.status}} is "Overdue", then return` is claimed at rung 0 of
 * `parseControlLine` and is therefore never a guard
 * (docs/specs/SPEC-structured-table-reads.md §8.3a). Each loop's part is to
 * hand the claim over, read off the AUTHORED line; the decision, local or
 * judged, is the executor's.
 *
 * So this is the pin that matters here: a loop that stopped passing the claim
 * would lose the local decision AND the model-judged return together, and the
 * step would quietly run as ordinary prose.
 */
describe('every run loop hands its flow-control claim to the executor', () => {
  // The errand runner is the fourth, and gets the same decision for free —
  // it is listed here so a reader looking for "all the loops" finds it.
  const CLAIM_SITES = [...RUN_LOOPS, 'src/server/errand-runner.ts'] as const;

  it.each(CLAIM_SITES)('%s reads the claim off the AUTHORED line', (file) => {
    const body = source(file);
    expect(body).toMatch(/parseFlowControlStep\((raw|original)[A-Za-z]*\)/);
    expect(body).toContain('flowControlClaim }');
  });
});

/**
 * A key no placeholder can spell is reported, not fatal
 * (docs/specs/SPEC-structured-table-reads.md §8.2).
 *
 * Here for the same reason as everything else in this file: `evaluateGuard` is
 * the ONE place a `For each` reads its list, in all three loops, so the line
 * is written once and cannot ship in two of three. It is also the only place
 * that knows the loop has been entered — a pass revisit asks the planner
 * nothing and reads no list, which is what makes "once per loop entry" a
 * property of the helper rather than of each caller's bookkeeping.
 */
describe('a For each list with keys a placeholder cannot spell', () => {
  const FOREACH: (ControlRecord | null)[] = [
    {
      kind: 'foreach',
      item: 'order',
      list: 'orders',
      bodyStart: 1,
      bodyEnd: 1,
      label: 'Check the order',
    },
    null,
    null,
  ];
  const ORDERS =
    '[{"id":"A","status":"x","content-type":"t","Order ID":"1"},' +
    '{"id":"B","status":"y","content-type":"t"}]';

  /** `evaluateGuard` with only what the `list` branch touches — it asks no
   *  model and reads no page, which is why a bare options object is honest
   *  here rather than a shortcut. */
  const visit = (state: ControlState, parameters: Record<string, string>) =>
    evaluateGuard({
      controls: FOREACH,
      index: 0,
      state,
      resolvedParameters: parameters,
      executorOptions: {} as never,
    });

  const infoLines = async (fn: () => Promise<void>): Promise<string[]> => {
    const seen: string[] = [];
    const spy = vi.spyOn(logger, 'info').mockImplementation((message: string) => {
      seen.push(message);
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return seen;
  };

  it('runs every pass, binds the spellable keys, and says what it dropped — once', async () => {
    const state = createControlState();
    let first: Awaited<ReturnType<typeof visit>> | undefined;
    const lines = await infoLines(async () => {
      first = await visit(state, { orders: ORDERS });
      // Pass 2, the way a run loop reaches it: the body step, then the guard
      // again. Nothing re-reads the list, so nothing logs a second time.
      planAfterStep(FOREACH, 1, state);
      await visit(state, { orders: ORDERS });
    });

    expect(first!.error).toBeUndefined();
    expect(first!.plan.pass!.bindings).toEqual({
      order: '{"id":"A","status":"x","content-type":"t","Order ID":"1"}',
      'order.id': 'A',
      'order.status': 'x',
    });
    expect(lines.filter((l) => l.includes('cannot be referenced'))).toEqual([
      'For each {{order}}: 2 properties cannot be referenced as placeholders ' +
        '(content-type, Order ID)',
    ]);
  });

  it('says nothing when every key is spellable', async () => {
    const lines = await infoLines(async () => {
      await visit(createControlState(), { orders: '[{"id":"A"}]' });
    });
    expect(lines.filter((l) => l.includes('cannot be referenced'))).toEqual([]);
  });

  it('words one dropped key in the singular', async () => {
    const lines = await infoLines(async () => {
      await visit(createControlState(), { orders: '[{"id":"A","content-type":"t"}]' });
    });
    expect(lines.filter((l) => l.includes('cannot be referenced'))).toEqual([
      'For each {{order}}: 1 property cannot be referenced as a placeholder (content-type)',
    ]);
  });

  it('masks a secret value that turns up in a key', async () => {
    // The line is written from the RECORD, so it goes through the run's
    // masker like every other string this module writes.
    const lines = await infoLines(async () => {
      await visit(createControlState(), {
        password: 'hunter2',
        orders: '[{"id":"A","hunter2 header":"t"}]',
      });
    });
    expect(lines.filter((l) => l.includes('cannot be referenced'))).toEqual([
      'For each {{order}}: 1 property cannot be referenced as a placeholder (*** header)',
    ]);
  });
});

/**
 * A guard whose condition names a root the map does not own.
 *
 * `{{constructor.id}}` indexed the parameter map with a bare `[root]` and got
 * the `Object` function back, so `rootValue.startsWith('{')` threw — and the
 * guard loop's `dottedReferenceError` call sits OUTSIDE `evaluateGuard`'s
 * try/catch, so the TypeError escaped into the run loop rather than becoming
 * the refusal every other unanswerable reference gets. The judge's own throws
 * are caught two dozen lines below; this one was not.
 */
describe('a guard condition naming a prototype key', () => {
  const chainAt = (condition: string): (ControlRecord | null)[] => [
    { kind: 'if', chainId: 'c1', condition, bodyStart: 1, bodyEnd: 1, chainEnd: 1 },
    null,
  ];

  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'refuses {{%s.id}} rather than throwing out of the run loop',
    async (root) => {
      const evaluation = await evaluateGuard({
        controls: chainAt(`If {{${root}.id}} is "x", then Do the thing`),
        index: 0,
        state: createControlState(),
        resolvedParameters: { order: '{"id":"A"}', 'order.id': 'A' },
        executorOptions: {} as never,
      });
      expect(evaluation.error).toBe(
        `{{${root}.id}} has no value; nothing in this run binds {{${root}}}`,
      );
    },
  );
});

/**
 * A `For each` whose LIST names a root the map does not own.
 *
 * The same door, one branch along: the `list` case reads the list's value out
 * of the parameter map, and a bare index answered `For each {{row}} in
 * {{constructor}}` with the `Object` FUNCTION. `parseListValue` then stopped
 * at its "not a list" refusal, which interpolates the value — so the author
 * was shown `` `{{constructor}}` holds `function Object() { [native code] }` ``
 * and told to capture it "with a read of every matching element", about a name
 * this run binds nothing to. The message they need is the other one:
 * `{{constructor}}` has NO value.
 *
 * Every root here reaches it the same way and none of them is exotic enough to
 * be somebody else's problem: `valueOf` is a plausible column name, and
 * `__proto__` answers with `Object.prototype` rather than a function.
 */
describe('a For each whose list names a prototype key', () => {
  const forEachOver = (list: string): (ControlRecord | null)[] => [
    { kind: 'foreach', item: 'row', list, bodyStart: 1, bodyEnd: 1, label: 'Check the row' },
    null,
    null,
  ];

  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'refuses `For each {{row}} in {{%s}}` as having no value, not as holding a function',
    async (root) => {
      const evaluation = await evaluateGuard({
        controls: forEachOver(root),
        index: 0,
        state: createControlState(),
        // A map with a REAL list in it, so "nothing binds this one" is the
        // claim under test rather than "the map is empty".
        resolvedParameters: { orders: '[{"id":"A"}]' },
        executorOptions: {} as never,
      });
      expect(evaluation.error).toBe(
        `\`{{${root}}}\` has no value, so there is nothing to loop over — ` +
          `capture it first with a read of every matching element, or with a ` +
          `tool that returns an array.`,
      );
      expect(evaluation.error).not.toContain('native code');
    },
  );

  it('still loops over a list the map really binds', async () => {
    const evaluation = await evaluateGuard({
      controls: forEachOver('constructor'),
      index: 0,
      state: createControlState(),
      // `[store as: constructor]` is a capture like any other, and the loop
      // must read it — dropping the name is the other way to get this wrong.
      resolvedParameters: Object.defineProperty({}, 'constructor', {
        value: '[{"id":"A"},{"id":"B"}]',
        writable: true,
        enumerable: true,
        configurable: true,
      }) as Record<string, string>,
      executorOptions: {} as never,
    });
    expect(evaluation.error).toBeUndefined();
    expect(evaluation.plan.pass!.bindings).toEqual({ row: '{"id":"A"}', 'row.id': 'A' });
  });
});

/**
 * The §8.3 refusal is masked in every loop that emits it.
 *
 * `evaluateGuard`'s `… cannot be referenced as a placeholder` line already
 * was (see the `*** header` pin above); the refusal it sits beside was not,
 * and it is the louder of the two — `logger.error`, `StepResult.error`,
 * `aiExplanation`, and on the server the `step:fail` wire payload. Each loop's
 * masker differs, so each loop has to hand its own in; this is the cheap check
 * that all three do, beside the behavioural tests in the three loop suites.
 */
describe('every run loop masks the dotted-reference refusal', () => {
  /** The argument text of `name(` at its first call in `body`, brackets
   *  balanced — so a multi-line call is read whole rather than to the first
   *  `)` that happens to be a nested one. */
  const callArgs = (body: string, name: string): string => {
    const open = body.indexOf(`${name}(`) + name.length;
    expect(open).toBeGreaterThan(name.length - 1);
    let depth = 0;
    for (let k = open; k < body.length; k++) {
      if (body[k] === '(') depth++;
      else if (body[k] === ')' && --depth === 0) return body.slice(open + 1, k);
    }
    throw new Error(`unbalanced ${name}( in source`);
  };

  it.each(RUN_LOOPS)('%s passes a masker to dottedReferenceError', (file) => {
    expect(callArgs(source(file), 'dottedReferenceError')).toMatch(/redact/);
  });

  it('the guard path masks it too, from the masker evaluateGuard was given', () => {
    expect(callArgs(source('src/runner/control-runtime.ts'), 'dottedReferenceError')).toMatch(
      /redactText/,
    );
  });
});

/**
 * `{{a.b.c}}` is warned about on a CONTROL line as well as an ordinary one.
 *
 * The CLI dispatches a guard and `continue`s before the loop reaches its
 * `interpolate` call, which is where the warning lives — so `For each
 * {{order.address.city}} in {{orders}}` was silent in this runner and loud in
 * the other two, which resolve every line's text before their control
 * dispatch. Same function, called directly.
 */
describe('every run loop warns about a multi-segment reference on a control line', () => {
  it('src/runner/test-runner.ts calls warnMultiSegment on the guard line', () => {
    const body = source('src/runner/test-runner.ts');
    expect(body).toContain('warnMultiSegment');
    expect(body).toMatch(/warnMultiSegment\(guardText\)/);
  });

  it.each(['src/server/session-manager.ts', 'src/ui/main/runner-adapter.ts'])(
    '%s gets it from interpolate, which it runs on every line',
    (file) => {
      // Not a second call site: these two resolve the text of EVERY step,
      // control lines included, before the dispatch — which is why they never
      // had the gap. The pin is that they still resolve every line.
      expect(source(file)).toMatch(/interpolate\(/);
    },
  );
});

describe('every run loop tells interpolate what a control line DEFINES', () => {
  // `For each {{payment}} in {{payments}}` READS the list and WRITES the item.
  // Without the third argument, `interpolate` warns
  // `Unresolved placeholder: {{payment}}` on every visit to a correct loop —
  // noise in the one output that reads like a diagnosis.
  it.each(RUN_LOOPS)('%s passes controlLineDefines', (file) => {
    expect(source(file)).toContain('controlLineDefines(');
  });
});
