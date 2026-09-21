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

describe('every run loop tells interpolate what a control line DEFINES', () => {
  // `For each {{payment}} in {{payments}}` READS the list and WRITES the item.
  // Without the third argument, `interpolate` warns
  // `Unresolved placeholder: {{payment}}` on every visit to a correct loop —
  // noise in the one output that reads like a diagnosis.
  it.each(RUN_LOOPS)('%s passes controlLineDefines', (file) => {
    expect(source(file)).toContain('controlLineDefines(');
  });
});
