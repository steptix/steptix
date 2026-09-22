/**
 * The computer-mode executor
 * (docs/specs/SPEC-use-computer.md §5.4, §5.5, §10.2; acceptance §13 item 3:
 * "a `click` at image (x, y) reaches the adapter at the logical screen point
 * §5.2 defines … with and without downscale, and after a zoom").
 *
 * Everything here drives the fake adapter, and not only for speed: the machine
 * this was built on cannot capture the screen from a spawned process at all
 * (§5.1 item 4), so a test that asked for a real grab would fail for a reason
 * that has nothing to do with the code. The real adapter is proved by the live
 * run in §13.2.
 *
 * `sleep` and `now` are injected throughout. A `wait_window` that polls a real
 * 15 seconds proves the same thing as one that polls a virtual 15 seconds and
 * costs 15 seconds of everyone's suite.
 */
import { describe, it, expect } from 'vitest';
import { executeComputerAction, WINDOW_POLL_INTERVAL_MS } from '../src/desktop/executor.js';
import { viewFromGrab, type ImageView } from '../src/desktop/capture.js';
import { FakeDesktopAdapter, fakeWindow, makeFakeGrab } from '../src/desktop/fake-adapter.js';
import type { ComputerAction } from '../src/desktop/actions.js';
import type { ScreenGrab } from '../src/desktop/adapter.js';

/** A view with no PNG behind it — nothing the executor does reads the bytes,
 *  except `zoom`, which gets a real one below. */
function view(grab: Partial<ScreenGrab>, imageWidth: number, imageHeight: number): ImageView {
  return {
    pngBase64: '',
    imageWidth,
    imageHeight,
    kind: 'full',
    grab: {
      width: grab.width ?? imageWidth,
      height: grab.height ?? imageHeight,
      scaleX: grab.scaleX ?? 1,
      scaleY: grab.scaleY ?? 1,
      rgba: Buffer.alloc(0),
    },
  };
}

/** A virtual clock: `sleep` advances it instead of waiting. */
function clock() {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

function ctx(adapter: FakeDesktopAdapter, current: ImageView, overrides: Record<string, unknown> = {}) {
  const c = clock();
  const lines: string[] = [];
  return {
    clock: c,
    lines,
    context: {
      adapter,
      view: current,
      settleMs: 300,
      sleep: c.sleep,
      now: c.now,
      log: (message: string) => lines.push(message),
      ...overrides,
    },
  };
}

describe('executeComputerAction — pointer actions map through §5.2', () => {
  it('clicks at the LOGICAL screen point, with the button and count', async () => {
    // 3440×1440 grab shown at 1600×670: the measured display this was built on.
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({ width: 3440, height: 1440 }, 1600, 670));
    const action: ComputerAction = {
      action: 'click',
      x: 812,
      y: 544,
      button: 'left',
      count: 1,
      description: 'Cancel',
    };

    const result = await executeComputerAction(action, harness.context);

    expect(result.performed).toBe(true);
    expect(result.ok).toBe(true);
    // 812 × 3440/1600 = 1745.8 → 1746; 544 × 1440/670 = 1169.2 → 1169.
    // §10.2's worked line prints 1170 for the y. It is an illustration, and
    // the 670-row image the encoder actually produces puts the point one pixel
    // higher; the mapping is the contract, not the prose.
    expect(result.screenPoint).toEqual({ x: 1746, y: 1169 });
    expect(adapter.callsOf('click')).toEqual([
      { name: 'click', args: { point: { x: 1746, y: 1169 }, button: 'left', count: 1 } },
    ]);
  });

  it('logs §10.2\'s line, verbatim, with the [computer] prefix', async () => {
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({ width: 3440, height: 1440 }, 1600, 670));
    await executeComputerAction(
      { action: 'click', x: 812, y: 544, button: 'left', count: 1, description: '' },
      harness.context,
    );
    expect(harness.lines).toContain('[computer] click image(812,544) → screen(1746,1169)');
  });

  it('halves the point again at density 2', async () => {
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({ width: 3440, height: 1440, scaleX: 2, scaleY: 2 }, 1600, 670));
    const result = await executeComputerAction(
      { action: 'click', x: 800, y: 335, button: 'left', count: 1, description: '' },
      harness.context,
    );
    expect(result.screenPoint).toEqual({ x: 860, y: 360 });
  });

  it('clicks where the model pointed AFTER a zoom', async () => {
    // §13 item 3's last clause. The zoom is built for real, out of real
    // pixels, because the mapping it produces is the thing under test.
    const adapter = new FakeDesktopAdapter({ width: 320, height: 160 });
    const full = await viewFromGrab(makeFakeGrab({ width: 320, height: 160 }), {
      maxImageWidth: 160,
    });
    const zoomHarness = ctx(adapter, full, { maxImageWidth: 160 });
    const zoomed = await executeComputerAction(
      { action: 'zoom', region: { x: 10, y: 10, width: 40, height: 20 }, description: '' },
      zoomHarness.context,
    );

    const clickHarness = ctx(adapter, zoomed.view);
    const result = await executeComputerAction(
      { action: 'click', x: 40, y: 20, button: 'left', count: 1, description: '' },
      clickHarness.context,
    );
    expect(result.screenPoint).toEqual({ x: 40, y: 30 });
  });

  it('moves without clicking', async () => {
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({ width: 200, height: 100 }, 100, 50));
    await executeComputerAction({ action: 'move', x: 10, y: 5, description: '' }, harness.context);
    expect(adapter.callsOf('move')).toEqual([{ name: 'move', args: { point: { x: 20, y: 10 } } }]);
    expect(adapter.callsOf('click')).toEqual([]);
  });

  it('drags between two mapped points', async () => {
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({ width: 200, height: 100 }, 100, 50));
    const result = await executeComputerAction(
      { action: 'drag', from: { x: 10, y: 5 }, to: { x: 30, y: 15 }, description: '' },
      harness.context,
    );
    expect(adapter.callsOf('drag')).toEqual([
      { name: 'drag', args: { from: { x: 20, y: 10 }, to: { x: 60, y: 30 } } },
    ]);
    // The report's click marker wants the point the pointer ended at.
    expect(result.screenPoint).toEqual({ x: 60, y: 30 });
  });

  it('scrolls at a mapped point, with the direction and tick count', async () => {
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({ width: 200, height: 100 }, 100, 50));
    await executeComputerAction(
      { action: 'scroll', x: 10, y: 5, direction: 'down', amount: 5, description: '' },
      harness.context,
    );
    expect(adapter.callsOf('scroll')).toEqual([
      { name: 'scroll', args: { point: { x: 20, y: 10 }, direction: 'down', ticks: 5 } },
    ]);
  });
});

describe('executeComputerAction — keyboard', () => {
  it('types the text through the adapter', async () => {
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({}, 100, 100));
    await executeComputerAction({ action: 'type', text: 'hunter2', description: '' }, harness.context);
    expect(adapter.callsOf('type')).toEqual([{ name: 'type', args: { text: 'hunter2' } }]);
  });

  it('does NOT log the typed text', async () => {
    // There is no field name on this surface to match against the secret
    // vocabulary — a password box and a filename box look the same — so the
    // only safe thing to print is the length.
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({}, 100, 100));
    await executeComputerAction({ action: 'type', text: 'hunter2', description: '' }, harness.context);
    expect(harness.lines.join('\n')).not.toContain('hunter2');
    expect(harness.lines).toContain('[computer] type 7 characters');
  });

  it('hands the chord to the adapter unchanged', async () => {
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({}, 100, 100));
    await executeComputerAction({ action: 'key', key: 'ctrl+shift+s', description: '' }, harness.context);
    expect(adapter.callsOf('key')).toEqual([{ name: 'key', args: { chord: 'ctrl+shift+s' } }]);
  });
});

describe('executeComputerAction — settle (§5.5)', () => {
  it('waits settleMs after an action that touches the screen', async () => {
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({}, 100, 100), { settleMs: 300 });
    await executeComputerAction(
      { action: 'click', x: 1, y: 1, button: 'left', count: 1, description: '' },
      harness.context,
    );
    expect(harness.clock.slept).toEqual([300]);
  });

  it('does not settle after a zoom — nothing was touched', async () => {
    const adapter = new FakeDesktopAdapter({ width: 320, height: 160 });
    const full = await viewFromGrab(makeFakeGrab({ width: 320, height: 160 }), {
      maxImageWidth: 160,
    });
    const harness = ctx(adapter, full, { maxImageWidth: 160 });
    await executeComputerAction(
      { action: 'zoom', region: { x: 0, y: 0, width: 40, height: 20 }, description: '' },
      harness.context,
    );
    expect(harness.clock.slept).toEqual([]);
    expect(adapter.calls).toEqual([]);
  });

  it('does not double the wait on a `wait` action', async () => {
    // A `wait` IS a settle; adding settleMs on top would stretch every
    // author-requested pause by 300ms without saying so.
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({}, 100, 100), { settleMs: 300 });
    await executeComputerAction({ action: 'wait', seconds: 2, description: '' }, harness.context);
    expect(harness.clock.slept).toEqual([2000]);
  });

  it('skips the settle entirely when it is configured to 0', async () => {
    const adapter = new FakeDesktopAdapter();
    const harness = ctx(adapter, view({}, 100, 100), { settleMs: 0 });
    await executeComputerAction({ action: 'key', key: 'enter', description: '' }, harness.context);
    expect(harness.clock.slept).toEqual([]);
  });
});

describe('executeComputerAction — zoom (§5.3)', () => {
  it('returns a new view and touches nothing', async () => {
    const adapter = new FakeDesktopAdapter({ width: 320, height: 160 });
    const full = await viewFromGrab(makeFakeGrab({ width: 320, height: 160 }), {
      maxImageWidth: 160,
    });
    const harness = ctx(adapter, full, { maxImageWidth: 160 });

    const result = await executeComputerAction(
      { action: 'zoom', region: { x: 10, y: 10, width: 40, height: 20 }, description: '' },
      harness.context,
    );

    expect(result.performed).toBe(true);
    expect(result.view).not.toBe(full);
    expect(result.view.kind).toBe('zoom');
    expect(result.view.region).toEqual({ x: 20, y: 20, width: 80, height: 40 });
    expect(adapter.calls).toEqual([]);
  });
});

describe('executeComputerAction — windows (§5.4)', () => {
  it('focus_window succeeds when a title matches', async () => {
    const adapter = new FakeDesktopAdapter({ windows: [fakeWindow('Save As')] });
    const harness = ctx(adapter, view({}, 100, 100));
    const result = await executeComputerAction(
      { action: 'focus_window', title: 'save as', description: '' },
      harness.context,
    );
    expect(result).toMatchObject({ performed: true, ok: true });
    expect(adapter.callsOf('focusWindow')).toEqual([
      { name: 'focusWindow', args: { titleSubstring: 'save as', found: true } },
    ]);
  });

  it('focus_window FAILS when nothing matches, and names what is open', async () => {
    const adapter = new FakeDesktopAdapter({
      windows: [fakeWindow('statement.pdf — Chromium'), fakeWindow('Visual Studio Code')],
    });
    const harness = ctx(adapter, view({}, 100, 100));
    const result = await executeComputerAction(
      { action: 'focus_window', title: 'Save As', description: '' },
      harness.context,
    );
    expect(result.performed).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No window\'s title contains "Save As"');
    // Listing them is the difference between a model that guesses again and
    // one that picks the right title on its next turn.
    expect(result.message).toContain('statement.pdf — Chromium');
  });

  it('wait_window open: satisfied as soon as the window appears', async () => {
    const adapter = new FakeDesktopAdapter({
      windowsSequence: [[], [], [fakeWindow('Print')]],
    });
    const harness = ctx(adapter, view({}, 100, 100));
    const result = await executeComputerAction(
      { action: 'wait_window', title: 'print', state: 'open', timeoutMs: 15_000, description: '' },
      harness.context,
    );
    expect(result).toMatchObject({ performed: true, ok: true });
    expect(adapter.callsOf('windows')).toHaveLength(3);
    // Two polls of 250ms, then the settle (§5.4 / §5.5).
    expect(harness.clock.slept).toEqual([
      WINDOW_POLL_INTERVAL_MS,
      WINDOW_POLL_INTERVAL_MS,
      300,
    ]);
  });

  it('wait_window open: satisfied on the FIRST look when it is already there', async () => {
    const adapter = new FakeDesktopAdapter({ windows: [fakeWindow('Print')] });
    const harness = ctx(adapter, view({}, 100, 100));
    await executeComputerAction(
      { action: 'wait_window', title: 'Print', state: 'open', timeoutMs: 15_000, description: '' },
      harness.context,
    );
    expect(adapter.callsOf('windows')).toHaveLength(1);
    expect(harness.clock.slept).toEqual([300]);
  });

  it('wait_window gone: satisfied when the window disappears', async () => {
    const adapter = new FakeDesktopAdapter({
      windowsSequence: [[fakeWindow('Save As')], [fakeWindow('Save As')], []],
    });
    const harness = ctx(adapter, view({}, 100, 100));
    const result = await executeComputerAction(
      { action: 'wait_window', title: 'Save As', state: 'gone', timeoutMs: 15_000, description: '' },
      harness.context,
    );
    expect(result.ok).toBe(true);
    expect(adapter.callsOf('windows')).toHaveLength(3);
  });

  it('wait_window times out with the budget in the message', async () => {
    const adapter = new FakeDesktopAdapter({ windows: [] });
    const harness = ctx(adapter, view({}, 100, 100));
    const result = await executeComputerAction(
      { action: 'wait_window', title: 'Never', state: 'open', timeoutMs: 1000, description: '' },
      harness.context,
    );
    expect(result.performed).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Timed out after 1000ms .* "Never" to be open/);
    // 1000ms at 250ms a poll: five looks, four sleeps.
    expect(adapter.callsOf('windows')).toHaveLength(5);
  });

  it('matches a title case-insensitively, as a substring', async () => {
    const adapter = new FakeDesktopAdapter({ windows: [fakeWindow('Confirm Save As')] });
    const harness = ctx(adapter, view({}, 100, 100));
    const result = await executeComputerAction(
      { action: 'wait_window', title: 'CONFIRM save', state: 'open', timeoutMs: 1000, description: '' },
      harness.context,
    );
    expect(result.ok).toBe(true);
  });
});

describe('executeComputerAction — what the run loop owns (§5.4)', () => {
  it.each([
    ['read', { action: 'read', as: 'a', value: 'b', description: '' }],
    ['assert', { action: 'assert', condition: 'c', holds: true, evidence: '', description: '' }],
    ['noop', { action: 'noop', description: '' }],
    ['prompt', { action: 'prompt', question: 'q', description: '' }],
    ['return', { action: 'return', description: '' }],
    ['fail', { action: 'fail', description: '' }],
    ['api_call', { action: 'api_call', raw: {}, description: '' }],
    ['extract_value', { action: 'extract_value', raw: {}, description: '' }],
  ])('%s comes back performed: false, having touched nothing', async (_name, action) => {
    const adapter = new FakeDesktopAdapter();
    const current = view({}, 100, 100);
    const harness = ctx(adapter, current);
    const result = await executeComputerAction(action as ComputerAction, harness.context);
    expect(result.performed).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.view).toBe(current);
    expect(adapter.calls).toEqual([]);
    expect(harness.clock.slept).toEqual([]);
  });
});
