/**
 * The Electron runner's control-flow emission (stories/control-flow.md
 * §Runtime).
 *
 * The adapter is the fourth run loop, and the only one whose results reach a
 * renderer over an IPC channel with a typed status. That type used to be
 * `'passed' | 'failed'`, so a skipped step — the untaken half of a chain — was
 * reported to the renderer as **passed** while the report kept the truth. The
 * one thing a decision leaves for a reader is which way it went, and painting
 * both branches green loses exactly that.
 *
 * Driven through the adapter's public `start()`, with the browser, the step
 * executor and the judge replaced; the parser, the expander, the planner and
 * the adapter's own loop are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { StepResult } from '../src/report/types.js';

const launchBrowserMock = vi.fn();
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: vi.fn().mockResolvedValue(undefined),
}));

const executeStepMock = vi.fn();
const evaluateConditionsMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
  evaluateConditions: (...args: unknown[]) => evaluateConditionsMock(...args),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
  },
}));

vi.mock('../src/config/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/loader.js')>()),
  loadConfig: async () => structuredClone(DEFAULT_CONFIG),
}));

/** Every report the adapter handed the generator, so the loop markers — which
 *  never reach the renderer — can be asserted. */
const generatedReports: Array<{ steps: StepResult[] }> = [];
vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn(async (report: { steps: StepResult[] }) => {
    generatedReports.push(report);
    return '';
  }),
}));

import { UIRunnerAdapter } from '../src/ui/main/runner-adapter.js';
// Not mocked: the adapter calls through to the real logger, so the lines a run
// prints are asserted by spying on it.
import { logger } from '../src/utils/logger.js';

const CHAIN = `
# Pay

## Steps
1. If the Cash checkbox is ticked, then Pay with cash
2. Otherwise, Pay by card
3. Verify the receipt

### Pay with cash
1. Click Pay now

### Pay by card
1. Enter the card details
2. Click Pay now
`;

type Emitted = { channel: string; data: Record<string, unknown> };

function writeTest(root: string, body: string): string {
  writeFileSync(path.join(root, '.env'), 'SHARED=x\n');
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  const file = path.join(root, 'tests', 'pay.md');
  writeFileSync(file, body);
  return file;
}

async function runAdapter(file: string): Promise<Emitted[]> {
  const events: Emitted[] = [];
  const adapter = new UIRunnerAdapter((channel, data) => {
    events.push({ channel, data: data as Record<string, unknown> });
  });
  await adapter.start(file, []);
  return events;
}

/** `stepIndex → status`, in the order the renderer would receive them. */
function completions(events: Emitted[]): Array<[unknown, unknown]> {
  return events
    .filter((e) => e.channel === 'runner:step-complete')
    .map((e) => [e.data['stepIndex'], e.data['status']]);
}

const originalCwd = process.cwd();
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aiui-ui-control-')));
  process.chdir(root);
  generatedReports.length = 0;
  executeStepMock.mockReset();
  executeStepMock.mockImplementation(
    async (index: number, _total: number, instruction: string): Promise<StepResult> => ({
      index,
      instruction,
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
    }),
  );
  evaluateConditionsMock.mockReset();
  launchBrowserMock.mockReset();
  launchBrowserMock.mockResolvedValue({
    page: { url: () => 'about:blank', goto: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('UIRunnerAdapter reports a skipped step as skipped', () => {
  it('the untaken branch of a chain, not painted as a pass', async () => {
    // The `If` holds, so `Pay by card` never runs.
    evaluateConditionsMock.mockResolvedValue({ selected: 0, reasoning: 'ticked', aiInteractions: [] });
    const events = await runAdapter(writeTest(root, CHAIN));

    // Expanded indices, 1-based on the wire:
    //   1 If …           2 Click Pay now
    //   3 Otherwise …    4 Enter the card details   5 Click Pay now
    //   6 Verify the receipt
    expect(completions(events)).toEqual([
      [1, 'passed'],
      [2, 'passed'],
      [3, 'skipped'],
      [4, 'skipped'],
      [5, 'skipped'],
      [6, 'passed'],
    ]);
    // Only the taken tail and the step after the chain were performed.
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual([
      'Click Pay now',
      'Verify the receipt',
    ]);
    expect(events.at(-1)).toMatchObject({
      channel: 'runner:complete',
      data: { status: 'passed' },
    });
  });

  it('and a guard that decided nothing held is skipped too', async () => {
    // No `Otherwise` this time, and nothing holds: the guard's own row is the
    // only trace of the one decision the run made.
    const noElse = `
# Pay

## Steps
1. If the Cash checkbox is ticked, then Pay with cash
2. Verify the receipt

### Pay with cash
1. Click Pay now
`;
    evaluateConditionsMock.mockResolvedValue({
      selected: null,
      reasoning: 'not ticked',
      aiInteractions: [],
    });
    const events = await runAdapter(writeTest(root, noElse));

    expect(completions(events)).toEqual([
      [1, 'skipped'],
      [2, 'skipped'],
      [3, 'passed'],
    ]);
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual(['Verify the receipt']);
  });
});

// ─── Every path that advances the pointer ───────────────────────────────────

/** The judge holds `holds` times, then stops. */
function judgeHoldsThenStops(holds: number): void {
  for (let n = 0; n < holds; n++) {
    evaluateConditionsMock.mockResolvedValueOnce({
      selected: 0,
      reasoning: 'still enabled',
      aiInteractions: [],
    });
  }
  evaluateConditionsMock.mockResolvedValue({
    selected: null,
    reasoning: 'gone',
    aiInteractions: [],
  });
}

const LOOP_ENDING_IN = (last: string): string => `
# Loop

## Steps
1. While the Next button is enabled, Go to the next page
2. Verify the last page

### Go to the next page
1. Click Next
2. ${last}
`;

describe('a loop body whose LAST step is not an ordinary step', () => {
  it('re-enters the loop after a Set, exactly as after an ordinary step', async () => {
    // The `Set`, `[input:]` and `[interactive]` paths all used to advance with
    // a bare `i++`, which walks past the guard instead of back to it — so a
    // loop whose body ends in one ran a single pass and left silently. All
    // three now go through the same `advance(i)` the ordinary path uses.
    judgeHoldsThenStops(2);
    await runAdapter(writeTest(root, LOOP_ENDING_IN('Set {{seen}} to "yes"')));

    expect(evaluateConditionsMock.mock.calls).toHaveLength(3);
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual([
      'Click Next',
      'Click Next',
      'Verify the last page',
    ]);
  });

  it('control: the same loop ending in an ordinary step behaves identically', async () => {
    judgeHoldsThenStops(2);
    await runAdapter(writeTest(root, LOOP_ENDING_IN('Click Again')));

    expect(evaluateConditionsMock.mock.calls).toHaveLength(3);
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual([
      'Click Next',
      'Click Again',
      'Click Next',
      'Click Again',
      'Verify the last page',
    ]);
  });
});

// ─── The debugger's jump ────────────────────────────────────────────────────

describe('movePointer into a loop body', () => {
  it('seeds the pass counter, so the pass after the jump is not pass 1 again', async () => {
    const md = `
# Jump

## Steps
1. Verify the start
2. While the Next button is enabled, Go to the next page
3. Verify the last page

### Go to the next page
1. Click Next
`;
    judgeHoldsThenStops(2);
    const file = writeTest(root, md);

    const events: Emitted[] = [];
    const adapter = new UIRunnerAdapter((channel, data) => {
      events.push({ channel, data: data as Record<string, unknown> });
      // Paused on step 1; jump straight into the loop's body (step 3), which
      // is what the debugger's "move pointer here" does.
      if (channel === 'runner:paused') {
        adapter.movePointer(3);
        adapter.resume();
      }
    });
    await adapter.start(file, [1]);

    // The jump landed inside the body, so the partial pass IS pass 1 — the
    // next one is 2. Without `planForStart` the counter stayed at 0 and the
    // loop reported two passes both numbered 1, of a total of 2.
    const steps = generatedReports.at(-1)!.steps;
    const body = steps.filter((s) => s.instruction === 'Click Next');
    expect(body.map((s) => (s.loop ? [s.loop.index, s.loop.count] : null))).toEqual([
      // The pass the run jumped into opened no band of its own.
      null,
      [2, 3],
      [3, 3],
    ]);
    // The step before the jump was never run.
    expect(executeStepMock.mock.calls.map((c) => c[2])).not.toContain('Verify the start');
  });
});

// ─── Start and complete come in pairs ───────────────────────────────────────

/**
 * The renderer's row spins on `runner:step-start` and settles on
 * `runner:step-complete`, so a start with no completion is a row that spins
 * for the rest of the run — the same defect the server's `step:start` had on
 * TestBench's gutter (stories/control-flow.md §"What the live run found").
 *
 * `runner:step-complete` for a guard lives inside `if (rows.guard)`, and a
 * visit that asks nobody produces no row: a `Repeat`'s first pass, and every
 * revisit of a `For each` including the one that finds the list exhausted.
 */
describe('a guard emits start and complete in pairs', () => {
  /** `[starts, completes]` for one 1-based step index. */
  function pairing(events: Emitted[], stepIndex: number): [number, number] {
    const own = events.filter(
      (e) =>
        (e.channel === 'runner:step-start' || e.channel === 'runner:step-complete') &&
        e.data['stepIndex'] === stepIndex,
    );
    return [
      own.filter((e) => e.channel === 'runner:step-start').length,
      own.filter((e) => e.channel === 'runner:step-complete').length,
    ];
  }

  it("does not announce a Repeat's first pass, which asks nobody", async () => {
    const md = `
# Repeat

## Steps
1. Repeat Load more alerts until every alert is shown
2. Verify the alert count

### Load more alerts
1. Click Load more
`;
    // `Repeat` stops when the condition HOLDS, so "nothing held" carries on.
    evaluateConditionsMock.mockResolvedValueOnce({
      selected: null, reasoning: 'more to come', aiInteractions: [],
    });
    evaluateConditionsMock.mockResolvedValue({
      selected: 0, reasoning: 'all shown', aiInteractions: [],
    });
    const events = await runAdapter(writeTest(root, md));

    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual([
      'Click Load more',
      'Click Load more',
      'Verify the alert count',
    ]);
    // Three visits, two of which asked — and two announcements.
    expect(evaluateConditionsMock.mock.calls).toHaveLength(2);
    expect(pairing(events, 1)).toEqual([2, 2]);
    for (const idx of [1, 2, 3]) {
      const [starts, completes] = pairing(events, idx);
      expect([idx, starts]).toEqual([idx, completes]);
    }
  });

  it('announces a For each guard once, however many items the list holds', async () => {
    const md = `
# For each

## Parameters
- accounts: ["Everyday","Savings","Travel"]

## Steps
1. For each {{account}} in {{accounts}}, Check the account
2. Sign out

### Check the account
1. Click the account row
`;
    const events = await runAdapter(writeTest(root, md));

    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual([
      'Click the account row',
      'Click the account row',
      'Click the account row',
      'Sign out',
    ]);
    // The list is the bound — no judge was asked anything.
    expect(evaluateConditionsMock.mock.calls).toHaveLength(0);
    // One announcement for the visit that read the list; the three revisits
    // that advance the cursor announce nothing and record nothing.
    expect(pairing(events, 1)).toEqual([1, 1]);
    expect(pairing(events, 2)).toEqual([3, 3]);
  });

  it('control: a While announces every visit, because every visit asks', async () => {
    judgeHoldsThenStops(2);
    const events = await runAdapter(writeTest(root, LOOP_ENDING_IN('Click Again')));

    // Three visits, three asks, three announcements — the rule is "no start
    // without a complete", not "fewer starts".
    expect(pairing(events, 1)).toEqual([3, 3]);
  });
});

// ─── The debugger's pointer, moved more than once ───────────────────────────

/**
 * `movePointer` is the only way a run's pointer goes BACKWARDS, and it can be
 * used any number of times in one run. `planForStart` — the planner hook the
 * jump applies so the chain's other members are marked skipped and the loop's
 * pass counter is seeded — was written for the server's single `startAt`
 * call, against an empty state, and both of its effects were absolute rather
 * than incremental (review 3, findings 3 and 4).
 */
describe('a debugger jump into a structure the run has already been through', () => {
  it('does not reset the loop pass counter', async () => {
    const md = `
# Jump twice

## Steps
1. Verify the start
2. While the Next button is enabled, Go to the next page
3. Verify the last page

### Go to the next page
1. Click Next
`;
    let holds = 0;
    evaluateConditionsMock.mockImplementation(async () => {
      holds += 1;
      return holds <= 4
        ? { selected: 0, reasoning: 'holds', aiInteractions: [] }
        : { selected: null, reasoning: 'done', aiInteractions: [] };
    });

    let pauses = 0;
    const adapter = new UIRunnerAdapter((channel) => {
      if (channel !== 'runner:paused') return;
      pauses += 1;
      // Jump to the body line on the 1st and the 3rd pause — a second jump
      // into a loop that has already run passes.
      if (pauses === 1 || pauses === 3) adapter.movePointer(3);
      adapter.resume();
    });
    await adapter.start(writeTest(root, md), [3]);

    const bands = generatedReports
      .at(-1)!
      .steps.filter((s) => s.loop)
      .map((s) => s.loop!.index);
    // Four passes, numbered 1 2 3 4. Setting rather than seeding gave
    // `1 1 2 2 2 2 3 3` — one number repeated and one pass never counted.
    expect([...new Set(bands)]).toEqual([1, 2, 3, 4]);
  });

  it('does not restart a For each`s list either', async () => {
    // The counter was seeded and the cursor was not, which for this loop kind
    // is the same bug wearing a different hat: the next visit finds no list,
    // asks for it again, and `planForEach` SETS the pass count from the fresh
    // cursor — so `Math.max` never survives and a second jump replays a band
    // (review 4, finding 4).
    const md = `
# Jump into a For each

## Parameters
- accounts: ["One","Two","Three","Four"]

## Steps
1. For each {{account}} in {{accounts}}, Check the account
2. Sign out

### Check the account
1. Click the {{account}} row
`;
    let pauses = 0;
    const adapter = new UIRunnerAdapter((channel) => {
      if (channel !== 'runner:paused') return;
      pauses += 1;
      // The body line, on the 1st and the 3rd pause — a second jump into a
      // list this loop is already part-way through.
      if (pauses === 1 || pauses === 3) adapter.movePointer(2);
      adapter.resume();
    });
    await adapter.start(writeTest(root, md), [2]);

    // Every element bound once, in order. The pause is BEFORE the step runs,
    // so a jump to the body line re-enters it rather than re-running it — and
    // resetting the cursor re-read the list from the top on each jump, which
    // gave `One Two Two Three Four`: the second element twice and one pass
    // never counted.
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual([
      'Click the One row',
      'Click the Two row',
      'Click the Three row',
      'Click the Four row',
      'Sign out',
    ]);
    const bands = generatedReports
      .at(-1)!
      .steps.filter((s) => s.instruction.startsWith('Click the'))
      .map((s) => s.loop?.index);
    expect(bands).toEqual([1, 2, 3, 4]);
  });

  it('re-owes the skipped rows of a loop body it jumps back into', async () => {
    // `addOnce` closed the duplicate-row finding and opened its mirror image:
    // `released` is a memory of the whole RUN, so a jump into a body whose
    // chain skipped those indices on an earlier pass reported the taken rows
    // and none of the skipped ones. A pass owes what every other pass emits
    // (review 4, finding 5).
    const md = `
# Jump into a loop body

## Steps
1. Verify the start
2. While the Next button is enabled, Pay for the page
3. Verify the last page

### Pay for the page
1. If the Cash checkbox is ticked, then Pay with cash
2. Otherwise, Pay by card
3. Click Next

### Pay with cash
1. Click Pay now

### Pay by card
1. Enter the card details
`;
    let loopAsks = 0;
    evaluateConditionsMock.mockImplementation(async (conditions: string[]) => {
      if (conditions[0] === 'the Next button is enabled') {
        loopAsks += 1;
        // Two passes, then the loop is done — and done again after the jump.
        return loopAsks <= 2
          ? { selected: 0, reasoning: 'enabled', aiInteractions: [] }
          : { selected: null, reasoning: 'disabled', aiInteractions: [] };
      }
      return { selected: 0, reasoning: 'cash', aiInteractions: [] };
    });

    const events: Emitted[] = [];
    let paused = 0;
    const adapter = new UIRunnerAdapter((channel, data) => {
      events.push({ channel, data: data as Record<string, unknown> });
      if (channel !== 'runner:paused') return;
      paused += 1;
      // Pause AFTER the loop (8, `Verify the last page`) and jump back into
      // the taken tail inside the body (4, `Click Pay now`).
      if (paused === 1) adapter.movePointer(4);
      adapter.resume();
    });
    await adapter.start(writeTest(root, md), [8]);

    // 5 (`Otherwise, Pay by card`) and 6 (`Enter the card details`) are the
    // untaken branch. Three visits to the body, three pairs of skipped rows.
    expect(
      completions(events)
        .filter(([, status]) => status === 'skipped')
        .map(([index]) => index),
    ).toEqual([5, 6, 5, 6, 5, 6]);
    // ...and the third pair belongs to the visit the jump made, not to a
    // late flush of the first two: they sit between the tail the jump landed
    // on and the `Click Next` that follows it, exactly as in the two passes.
    expect(completions(events).slice(-6)).toEqual([
      [4, 'passed'],
      [5, 'skipped'],
      [6, 'skipped'],
      [7, 'passed'],
      [2, 'passed'],
      [8, 'passed'],
    ]);
  });

  it('does not re-record the skipped rows it already recorded', async () => {
    evaluateConditionsMock.mockResolvedValue({
      selected: 0,
      reasoning: 'ticked',
      aiInteractions: [],
    });

    const events: Emitted[] = [];
    let paused = 0;
    const adapter = new UIRunnerAdapter((channel, data) => {
      events.push({ channel, data: data as Record<string, unknown> });
      if (channel !== 'runner:paused') return;
      paused += 1;
      // Pause on `Verify the receipt` (6) and jump BACK into the taken tail
      // (2, `Click Pay now`), which has already run.
      if (paused === 1) adapter.movePointer(2);
      adapter.resume();
    });
    await adapter.start(writeTest(root, CHAIN), [6]);

    // `Click Pay now` twice is what the jump asked for. The untaken branch —
    // 3, 4, 5 — is skipped once, however many times the pointer passes it.
    expect(completions(events)).toEqual([
      [1, 'passed'],
      [2, 'passed'],
      [2, 'passed'],
      [3, 'skipped'],
      [4, 'skipped'],
      [5, 'skipped'],
      [6, 'passed'],
    ]);
    const rows = generatedReports.at(-1)!.steps.map((s) => [s.instruction, s.status]);
    expect(rows.filter(([, status]) => status === 'skipped')).toEqual([
      ['Otherwise, Pay by card', 'skipped'],
      ['Enter the card details', 'skipped'],
      ['Click Pay now', 'skipped'],
    ]);
  });
});

describe('the Runner UI reports both kinds of skip the same way', () => {
  const RETURN_MID_BODY = `
# Return mid-body

## Steps
1. Open the statements page
2. While the Next button is enabled, Go to the next page
3. Verify the last page is shown

### Go to the next page
1. Click Next
2. Return
3. Record the page
`;

  it('stamps the loop band on a skipped-by-return row, as it does on a passed one', async () => {
    // The third copy of the same defect: `flushSkips` stamped the marker and
    // the return path did not, so a report drawn from this runner showed one
    // kind of skip inside the iteration band and the other outside it.
    judgeHoldsThenStops(2);
    await runAdapter(writeTest(root, RETURN_MID_BODY));
    const steps = generatedReports.at(-1)!.steps;

    expect(
      steps
        .filter((s) => s.instruction === 'Record the page')
        .map((s) => [s.status, s.loop?.index]),
    ).toEqual([
      ['skipped', 1],
      ['skipped', 2],
    ]);
    expect(
      steps.filter((s) => s.instruction === 'Click Next').map((s) => [s.status, s.loop?.index]),
    ).toEqual([
      ['passed', 1],
      ['passed', 2],
    ]);
  });

  it('sends a reason with a decision skip, which the renderer turns into one sentence', async () => {
    // `runner:step-complete` carries `reason` for both producers now. The
    // renderer builds its log line from `skipLogLine` (src/ui/step-skip.ts),
    // which strips the leading `Skipped:` this sentence carries for the
    // report cell — pinned in tests/ui-skip-line-parity.test.ts.
    evaluateConditionsMock.mockResolvedValue({
      selected: 0,
      reasoning: 'ticked',
      aiInteractions: [],
    });
    const events = await runAdapter(writeTest(root, CHAIN));
    const skips = events
      .filter((e) => e.channel === 'runner:step-complete' && e.data['status'] === 'skipped')
      .map((e) => e.data['reason']);
    expect(skips).toEqual([
      'Skipped: another branch of this decision was taken',
      'Skipped: another branch of this decision was taken',
      'Skipped: another branch of this decision was taken',
    ]);
  });

  it('sends one with the GUARD row too, when nothing in the chain held', async () => {
    // The guard's `runner:step-complete` is emitted from its own site, not
    // through `flushSkips`, and it sent no reason — so the renderer printed
    // `◌ Step 1 skipped` for the guard and `◌ Step 2 skipped — no condition in
    // this decision held` for the row under it, from one decision. The
    // sentence was already in scope on the line above.
    const noElse = `
# Pay

## Steps
1. If the Cash checkbox is ticked, then Pay with cash
2. Verify the receipt

### Pay with cash
1. Click Pay now
`;
    evaluateConditionsMock.mockResolvedValue({
      selected: null,
      reasoning: 'not ticked',
      aiInteractions: [],
    });
    const events = await runAdapter(writeTest(root, noElse));
    const skips = events
      .filter((e) => e.channel === 'runner:step-complete' && e.data['status'] === 'skipped')
      .map((e) => [e.data['stepIndex'], e.data['reason']]);
    expect(skips).toEqual([
      [1, 'Skipped: no condition in this decision held'],
      [2, 'Skipped: no condition in this decision held'],
    ]);
  });
});

// ─── A dotted reference the pass cannot answer ──────────────────────────────

/**
 * `{{order.missing}}` inside a `For each` body, through the adapter's loop
 * (docs/specs/SPEC-structured-table-reads.md §8.3).
 *
 * The helper that decides this is shared with the CLI and the Sessions API,
 * and each of the three wires it in itself — so each of the three needs a
 * loop-level test saying the refusal lands EARLY, before the executor is
 * reached. That is the whole claim: `executeStepMock` is the model, and what
 * it was never handed is the assertion.
 *
 * The list is seeded through `## Parameters`, the way this file's other
 * `For each` test seeds one. Where it comes from is not the planner's
 * business: a `readTable`, a tool returning an array and a declared parameter
 * all put the same JSON in the same map.
 */
describe('a dotted reference inside a For each body', () => {
  const doc = (bodyStep: string): string => `
# Orders

## Parameters
- orders: [{"id":"ORD-1001","status":"Completed"},{"id":"ORD-1002","status":"Pending"}]

## Steps
1. For each {{order}} in {{orders}}, Check the order
2. Sign out

### Check the order
1. ${bodyStep}
`;

  /** Every instruction the executor was actually given. */
  const asked = (): unknown[] => executeStepMock.mock.calls.map((c) => c[2]);

  it('fails the step before any model call, naming the pass and the properties', async () => {
    const events = await runAdapter(writeTest(root, doc('Verify {{order.missing}} is shown')));

    const message =
      '{{order.missing}} has no value in For each item 1; available properties are id, status';
    const failure = events.find(
      (e) => e.channel === 'runner:step-complete' && e.data['status'] === 'failed',
    );
    expect(failure?.data['error']).toBe(message);
    // …and the renderer's own error channel carries the same sentence, so the
    // Runner UI shows it rather than a bare red line.
    expect(
      events.find((e) => e.channel === 'runner:error')?.data['message'],
    ).toBe(message);

    // Nothing was planned for a line carrying six literal braces, and the run
    // stopped rather than going on to `Sign out`.
    expect(asked()).toEqual([]);
  });

  /**
   * …and the refusal is MASKED before it becomes an IPC event.
   *
   * It is written from the run's own values — the properties the row holds,
   * the keys the loop dropped — and a key can carry one: `hunter2 header`,
   * where `hunter2` is what `{{password}}` holds. Round 2 masked
   * `evaluateGuard`'s `cannot be referenced as a placeholder` line for exactly
   * this case and left the louder sentence beside it in the clear, in all
   * three loops at once.
   */
  it('masks a secret value the refusal would otherwise emit', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const md = `
# Orders

## Parameters
- password: hunter2
- orders: [{"id":"A","hunter2 header":"t"}]

## Steps
1. For each {{order}} in {{orders}}, Check the order
2. Sign out

### Check the order
1. Verify the row shows "{{order.contenttype}}"
`;
      const events = await runAdapter(writeTest(root, md));

      const expected =
        '{{order.contenttype}} has no value in For each item 1; available properties are id ' +
        '(*** header cannot be spelled as a placeholder)';
      const failure = events.find(
        (e) => e.channel === 'runner:step-complete' && e.data['status'] === 'failed',
      );
      expect(failure?.data['error']).toBe(expected);
      expect(events.find((e) => e.channel === 'runner:error')?.data['message']).toBe(expected);
      // The raw value reaches neither the log nor either event.
      const emitted = JSON.stringify([
        failure,
        events.find((e) => e.channel === 'runner:error'),
        error.mock.calls.map((c) => String(c[0])),
      ]);
      expect(emitted).not.toContain('hunter2');
    } finally {
      error.mockRestore();
    }
  });

  it('substitutes a real property into the text the model receives, per pass', async () => {
    await runAdapter(writeTest(root, doc('Verify the row for "{{order.id}}" is {{order.status}}')));

    expect(asked()).toEqual([
      'Verify the row for "ORD-1001" is Completed',
      'Verify the row for "ORD-1002" is Pending',
      'Sign out',
    ]);
  });

  /**
   * The header's own tail, naming a property of the item it defines — §4.6's
   * recommended form.
   *
   * `resolveStepText` runs on every line before the control dispatch, so the
   * header is interpolated on the visit that has not begun a pass yet.
   * `controlLineDefines` exempted `{{order}}` and nothing else, so
   * `{{order.id}}` was logged as `Unresolved placeholder` on every entry to
   * every correct table loop — in this runner and in the Sessions API alike.
   */
  it('does not warn about a property of the item the header binds', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const md = `
# Orders

## Parameters
- orders: [{"id":"ORD-1001","status":"Completed"},{"id":"ORD-1002","status":"Pending"}]

## Steps
1. For each {{order}} in {{orders}}, Click the row whose Order ID is "{{order.id}}"
2. Sign out
`;
      await runAdapter(writeTest(root, md));
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('Unresolved placeholder'))).toEqual([]);
      // The loop ran: the silence is about a working line.
      expect(asked()).toEqual([
        'Click the row whose Order ID is "ORD-1001"',
        'Click the row whose Order ID is "ORD-1002"',
        'Sign out',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('still warns about a dotted name no loop binds', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const md = `
# Orders

## Steps
1. Verify the row for "{{other.id}}" is shown
`;
      await runAdapter(writeTest(root, md));
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
        'Unresolved placeholder: {{other.id}}',
      );
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * Rows differ in shape, and a pass must not answer from the last one
 * (docs/specs/SPEC-structured-table-reads.md §8.2, §8.3).
 *
 * All three run loops wrote a pass's bindings with `Object.assign`, which
 * cannot delete. This runner is where it is worst, because `movePointer` can
 * rebuild a live `For each` cursor: the rebuild used to drop `properties`, so
 * after a jump no pass bound `{{order.x}}` at all — and with a merging write
 * that is not an error, it is the pre-jump row's value on every remaining
 * pass, silently, with a confident green row.
 */
describe('a For each pass binds its own row and no other', () => {
  it('refuses the pass whose row lacks the property, rather than reusing the last', async () => {
    const md = `
# Rows

## Parameters
- rows: [{"_row":"1","id":"A","note":"first"},{"_row":"2","id":"B"}]

## Steps
1. For each {{row}} in {{rows}}, Check the row
2. Sign out

### Check the row
1. Verify the note says "{{row.note}}"
`;
    const events = await runAdapter(writeTest(root, md));

    const failure = events.find(
      (e) => e.channel === 'runner:step-complete' && e.data['status'] === 'failed',
    );
    expect(failure?.data['error']).toBe(
      '{{row.note}} has no value in For each item 2; available properties are _row, id',
    );
    // Pass 1 ran on its own row; nothing leaked forward.
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual([
      'Verify the note says "first"',
    ]);
  });

  it('keeps every row"s properties across a debugger jump into the body', async () => {
    // `planForStart` rebuilds the cursor on every `movePointer`, and the
    // rebuild wrote `{items, index, resumed}` — dropping `properties`, the
    // only place the rows' dotted values live.
    const md = `
# Jump into a table loop

## Parameters
- orders: [{"id":"A"},{"id":"B"},{"id":"C"}]

## Steps
1. For each {{order}} in {{orders}}, Check the order
2. Sign out

### Check the order
1. Verify the row for "{{order.id}}" is shown
`;
    let pauses = 0;
    const adapter = new UIRunnerAdapter((channel) => {
      if (channel !== 'runner:paused') return;
      pauses += 1;
      // Jump back to the body line on the first pause — the debugger's own
      // move, against a loop that is already part-way through its list.
      if (pauses === 1) adapter.movePointer(2);
      adapter.resume();
    });
    await adapter.start(writeTest(root, md), [2]);

    // Each pass on its OWN row. Dropping `properties` left `{{order.id}}`
    // unbound after the jump, so every later pass re-read row A's id.
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual([
      'Verify the row for "A" is shown',
      'Verify the row for "B" is shown',
      'Verify the row for "C" is shown',
      'Sign out',
    ]);
  });
});

/**
 * Review 5, finding 3: the fourth run loop showed the resolved line to
 * everything, not just to the executor.
 *
 * `resolveStepText` is interpolation and nothing else, and its answer went
 * three ways: to `executeStep` (right — it has to act on it), to the renderer
 * as `runner:step-start`, and into `conversationHistory` via
 * `formatStepHistoryEntry`, whose docstring asks for the MASKED text and
 * whose output is the model's `## Prior Steps`. The CLI masks at its own seam
 * (test-runner.ts) and the server at its (session-manager.ts); this loop did
 * not, so `Type {{password}} into the field` put the password in the panel
 * and then in every later step's prompt (§7.6).
 */
const SECRET_STEPS = `
# Sign in

## Parameters
- username: octocat
- password: hunter2-correct-horse

## Steps
1. Type {{password}} into the field
2. Verify {{username}} is signed in
`;

describe('UIRunnerAdapter masks the line it shows, not the one it runs', () => {
  it('the step-start event and the next step’s ## Prior Steps carry ***', async () => {
    const events = await runAdapter(writeTest(root, SECRET_STEPS));

    // What the renderer is told.
    expect(
      events
        .filter((e) => e.channel === 'runner:step-start')
        .map((e) => e.data['instruction']),
    ).toEqual(['Type *** into the field', 'Verify octocat is signed in']);

    // What the model is told about the step before it.
    const second = executeStepMock.mock.calls[1]![3] as { conversationHistory: string[] };
    const history = second.conversationHistory.join('\n');
    expect(history).toContain('Type *** into the field');
    expect(history).not.toContain('hunter2-correct-horse');

    // And what actually ran, which is the whole reason the two differ.
    expect(executeStepMock.mock.calls[0]![2]).toBe('Type hunter2-correct-horse into the field');
    // A non-secret parameter is untouched — masking is by name, not by
    // "anything interpolated".
    expect(executeStepMock.mock.calls[1]![2]).toBe('Verify octocat is signed in');
  });

  /**
   * The fourth history writer in this loop, and the one the finding did not
   * name: `guardHistoryLines`. Its `text` callback is wrapped in the CLI
   * (`redact(test.steps[k] …)`, test-runner.ts) and on the server
   * (`redact(effectiveSteps[k] …)`, session-manager.ts), and here it was not —
   * under a comment saying so deliberately, "matching every other history
   * line this runner writes", which the fix above made untrue.
   *
   * Checked at the source, in the idiom tests/run-loop-contracts.test.ts uses
   * for the same three-of-four shape: a guard row carries the AUTHORED line,
   * so staging a value the mask set holds inside one takes a test that lies
   * about how it got there.
   */
  it('masks the guard history lines too, as the other three loops do', () => {
    const src = readFileSync(new URL('../src/ui/main/runner-adapter.ts', import.meta.url), 'utf-8');
    const start = src.indexOf('guardHistoryLines({');
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, src.indexOf('}),', start))).toMatch(/text: \(k\) => shown\(/);
  });
});

/**
 * Review 5, finding 3, second half — and review 6, finding 5c: the steer.
 *
 * `steer()` is the fifth writer in this loop, and it has the same two
 * audiences as a step: `executeStep` gets the RESOLVED text because it has to
 * act on it, and the panel (`runner:step-start`) and the model
 * (`conversationHistory` → `## Prior Steps`) get the masked one. Round 5 added
 * `shownSteer` for exactly that and nothing pinned it, so removing it left the
 * suite green while a `{{password}}` typed into the steer box went to the
 * renderer and into every later prompt in clear.
 */
describe('UIRunnerAdapter masks a steer the same way', () => {
  it('the steering step-start and the history carry ***, the executor gets the value', async () => {
    const file = writeTest(root, SECRET_STEPS);
    const events: Emitted[] = [];
    let steered = false;
    const adapter = new UIRunnerAdapter((channel, data) => {
      events.push({ channel, data: data as Record<string, unknown> });
      if (channel === 'runner:paused' && !steered) {
        steered = true;
        // Paused at the breakpoint on step 1; the author types a steer that
        // names a secret parameter, then lets the run go on.
        void adapter
          .steer('Type {{password}} into the field')
          .then(() => { adapter.resume(); });
      }
    });
    await adapter.start(file, [1]);

    // What the renderer is told about the steering step.
    const starts = events
      .filter((e) => e.channel === 'runner:step-start')
      .map((e) => String(e.data['instruction']));
    expect(starts).toContain('(steering) Type *** into the field');
    expect(starts.join('\n')).not.toContain('hunter2-correct-horse');

    // What the executor was handed, which is the whole reason the two differ.
    expect(executeStepMock.mock.calls[0]![2]).toBe('Type hunter2-correct-horse into the field');

    // And what the model is told about it on the step that follows.
    const next = executeStepMock.mock.calls[1]![3] as { conversationHistory: string[] };
    const history = next.conversationHistory.join('\n');
    expect(history).toContain('(steering) Type *** into the field');
    expect(history).not.toContain('hunter2-correct-horse');
  });
});
