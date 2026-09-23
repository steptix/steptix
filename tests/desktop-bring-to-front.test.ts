/**
 * `focus_window`'s policy — docs/specs/SPEC-use-computer.md §5.4, §5.8, §14
 * "focus_window: measured Win32 behaviour".
 *
 * Every case drives `FakeDesktopAdapter`, whose windows have a TRUE rect and
 * whose regions come back clipped to the main display exactly as nut.js clips
 * them — so each test states where the window really is and asserts on what
 * the policy could see of it. The display is the measured one, 3440×1440.
 *
 * What the fake models, and why each knob exists, is the measured behaviour:
 * a focus restores a minimised window (`focusRestoresMinimised`, default on),
 * activation can be refused (`refuseForeground`), and the ShowWindow helper
 * both restores and activates.
 */
import { describe, it, expect } from 'vitest';
import {
  bringWindowToFront,
  DEFAULT_BRING_TO_FRONT_SETTLE_MS,
  describeBringToFront,
  isOffMainDisplay,
  MIN_VISIBLE_PX,
} from '../src/desktop/bring-to-front.js';
import {
  FakeDesktopAdapter,
  fakeWindow,
  type FakeAdapterOptions,
  type FakeCall,
} from '../src/desktop/fake-adapter.js';
import type { WindowRegion } from '../src/desktop/adapter.js';

const DISPLAY = { width: 3440, height: 1440 };
const PDF = 'statement.pdf - Google Chrome';
/** A normal window, wholly on the main display. */
const ON_SCREEN: WindowRegion = { left: 300, top: 200, width: 1600, height: 1000 };

function harness(options: FakeAdapterOptions) {
  const adapter = new FakeDesktopAdapter({ ...DISPLAY, ...options });
  const slept: number[] = [];
  const trace: string[] = [];
  return {
    adapter,
    slept,
    trace,
    run: (title: string, settleMs?: number) =>
      bringWindowToFront(adapter, title, {
        sleep: async (ms) => {
          slept.push(ms);
        },
        trace: (line) => trace.push(line),
        platform: 'win32',
        ...(settleMs !== undefined && { settleMs }),
      }),
  };
}

const count = (adapter: FakeDesktopAdapter, name: FakeCall['name']): number =>
  adapter.callsOf(name).length;

/** The window-changing calls, in order — what the policy DID. */
const actions = (adapter: FakeDesktopAdapter): string[] =>
  adapter.calls
    .map((c) => c.name)
    .filter((n) =>
      ['focusWindowHandle', 'restoreWindow', 'minimiseWindow', 'moveWindow', 'resizeWindow'].includes(n),
    );

describe('bringWindowToFront — finding the window', () => {
  it('not found: touches nothing', async () => {
    const { adapter, run } = harness({ windows: [fakeWindow('Untitled - Notepad')] });
    const result = await run('Save As');
    expect(result).toMatchObject({ found: false, frontmost: false, attempts: 0 });
    expect(adapter.calls.map((c) => c.name)).toEqual(['findWindow']);
  });

  it('matches the title case-insensitively, as a substring — and verifies the same way', async () => {
    const { adapter, run } = harness({ windows: [{ title: PDF, region: ON_SCREEN }] });
    const result = await run('STATEMENT.PDF');
    expect(result).toMatchObject({ found: true, title: PDF, frontmost: true, attempts: 1 });
    expect(adapter.callsOf('findWindow')[0]!.args['titleSubstring']).toBe('STATEMENT.PDF');
  });
});

describe('bringWindowToFront — the ordinary cases', () => {
  it('already in front: one focus, nothing restored, moved or resized', async () => {
    const { adapter, run } = harness({
      windows: [{ title: PDF, region: ON_SCREEN }, fakeWindow('Claude')],
      activeTitle: 'statement.pdf',
    });
    const result = await run('statement.pdf');
    expect(result).toMatchObject({
      found: true,
      alreadyFront: true,
      restored: false,
      moved: false,
      resized: false,
      frontmost: true,
      onMainDisplay: true,
      attempts: 1,
      region: ON_SCREEN,
    });
    expect(result.message).toBeUndefined();
    expect(actions(adapter)).toEqual(['focusWindowHandle']);
    expect(describeBringToFront(result)).toBe('already in front');
  });

  it('behind another window: one focus brings it', async () => {
    const { adapter, run } = harness({
      windows: [{ title: PDF, region: ON_SCREEN }, fakeWindow('Claude')],
      activeTitle: 'Claude',
    });
    const result = await run('statement.pdf');
    expect(result).toMatchObject({ alreadyFront: false, frontmost: true, attempts: 1 });
    expect(actions(adapter)).toEqual(['focusWindowHandle']);
    expect(describeBringToFront(result)).toBe('now in front');
  });

  it('settles after every window operation, 150 ms by default', async () => {
    const { run, slept } = harness({ windows: [{ title: PDF, region: ON_SCREEN }] });
    await run('statement.pdf');
    expect(slept).toEqual([DEFAULT_BRING_TO_FRONT_SETTLE_MS]);
    expect(DEFAULT_BRING_TO_FRONT_SETTLE_MS).toBe(150);
  });

  it('a maximised window on the main display is left exactly as it is', async () => {
    // What Windows reports for a maximised window: 8 px of invisible frame
    // past every edge. Clipped, it fills the display.
    const maximised: WindowRegion = { left: -8, top: -8, width: 3456, height: 1416 };
    const { adapter, run } = harness({
      windows: [{ title: 'Quarterly report - Word', region: maximised, maximised: true }, fakeWindow('Claude')],
      activeTitle: 'Claude',
    });
    const result = await run('quarterly report');
    expect(result).toMatchObject({ moved: false, resized: false, restored: false, frontmost: true });
    expect(actions(adapter)).toEqual(['focusWindowHandle']);
    expect(adapter.windowState('quarterly')).toMatchObject({ region: maximised, maximised: true });
  });

  it('a small dialog wholly on the display is not mistaken for a clipped one', async () => {
    // Under MIN_VISIBLE_PX in both directions, but touching no edge — so the
    // clip did not produce it, and it is the whole window.
    const small: WindowRegion = { left: 1500, top: 700, width: 90, height: 80 };
    const { adapter, run } = harness({ windows: [{ title: 'Confirm', region: small }] });
    const result = await run('confirm');
    expect(result).toMatchObject({ moved: false, onMainDisplay: true, frontmost: true });
    expect(actions(adapter)).toEqual(['focusWindowHandle']);
  });
});

describe('bringWindowToFront — minimised', () => {
  it('a focus that restores it (measured, 4 of 4): no helper', async () => {
    const { adapter, run } = harness({
      windows: [{ title: PDF, region: ON_SCREEN, minimised: true }, fakeWindow('Claude')],
      activeTitle: 'Claude',
    });
    const result = await run('statement.pdf');
    expect(result).toMatchObject({ restored: true, moved: false, frontmost: true, attempts: 1 });
    expect(actions(adapter)).toEqual(['focusWindowHandle']);
    expect(count(adapter, 'restoreWindow')).toBe(0);
    expect(describeBringToFront(result)).toBe('restored from minimised, now in front');
  });

  it('a focus that does NOT restore it: the restore helper does', async () => {
    const { adapter, run } = harness({
      windows: [{ title: PDF, region: ON_SCREEN, minimised: true }, fakeWindow('Claude')],
      activeTitle: 'Claude',
      focusRestoresMinimised: false,
    });
    const result = await run('statement.pdf');
    expect(result).toMatchObject({ restored: true, moved: false, frontmost: true, attempts: 1 });
    expect(actions(adapter)).toEqual(['focusWindowHandle', 'restoreWindow']);
    expect(adapter.windowState('statement')!.minimised).toBe(false);
    expect(result.region).toEqual(ON_SCREEN);
  });

  it('minimised to a spot on another monitor: restored, then moved', async () => {
    const { run } = harness({
      windows: [{ title: PDF, region: { left: 4000, top: 200, width: 1600, height: 1000 }, minimised: true }],
    });
    const result = await run('statement.pdf');
    expect(result).toMatchObject({ restored: true, moved: true, resized: false, frontmost: true });
    expect(describeBringToFront(result)).toBe(
      'restored from minimised, moved onto the main display, now in front',
    );
  });

  it('a restore helper that cannot run leaves a failure that says so', async () => {
    const { run } = harness({
      windows: [{ title: PDF, region: ON_SCREEN, minimised: true }],
      focusRestoresMinimised: false,
      osHelperError: new Error('restoring a window needs xdotool on linux, and it was not found'),
    });
    const result = await run('statement.pdf');
    // In front (the focus activated it) but still minimised: not usable.
    expect(result).toMatchObject({ frontmost: true, onMainDisplay: false, restored: false });
    expect(result.message).toMatch(/is in front but not on the main display/);
    expect(result.message).toMatch(/the restore helper failed: restoring a window needs xdotool/);
  });
});

describe('bringWindowToFront — off the main display', () => {
  it('wholly on a second monitor (reads 0 wide): moved to (40,40), size kept', async () => {
    const { adapter, run } = harness({
      windows: [{ title: PDF, region: { left: 4000, top: 200, width: 1600, height: 1000 } }],
    });
    const result = await run('statement.pdf');
    expect(adapter.callsOf('windowRegion')[0]!.args['region']).toEqual({
      left: 4000,
      top: 200,
      width: 0,
      height: 1000,
    });
    expect(result).toMatchObject({ moved: true, resized: false, restored: false, frontmost: true, onMainDisplay: true });
    expect(adapter.callsOf('moveWindow')[0]!.args['origin']).toEqual({ x: 40, y: 40 });
    expect(adapter.windowState('statement')!.region).toEqual({ left: 40, top: 40, width: 1600, height: 1000 });
    // Not minimised, so the helper had no business being called.
    expect(count(adapter, 'restoreWindow')).toBe(0);
    expect(describeBringToFront(result)).toBe('moved onto the main display, now in front');
  });

  it('mostly off to the left with 527 px showing: left where it is', async () => {
    const region: WindowRegion = { left: -2000, top: 200, width: 2527, height: 1000 };
    const { adapter, run } = harness({ windows: [{ title: PDF, region }] });
    const result = await run('statement.pdf');
    expect(result.region).toEqual({ left: 0, top: 200, width: 527, height: 1000 });
    expect(result).toMatchObject({ moved: false, onMainDisplay: true, frontmost: true });
    expect(adapter.windowState('statement')!.region).toEqual(region);
  });

  it('the same with only 60 px showing: moved', async () => {
    const { adapter, run } = harness({
      windows: [{ title: PDF, region: { left: -2467, top: 200, width: 2527, height: 1000 } }],
    });
    const result = await run('statement.pdf');
    expect(adapter.callsOf('windowRegion')[0]!.args['region']).toMatchObject({ left: 0, width: 60 });
    expect(result).toMatchObject({ moved: true, resized: false, onMainDisplay: true });
    expect(result.region).toEqual({ left: 40, top: 40, width: 2527, height: 1000 });
  });

  it('larger than the display and off-screen: moved, then resized to the display less 80', async () => {
    const { adapter, run } = harness({
      windows: [{ title: PDF, region: { left: 4000, top: 100, width: 5000, height: 2000 } }],
    });
    const result = await run('statement.pdf');
    expect(actions(adapter)).toEqual(['focusWindowHandle', 'moveWindow', 'resizeWindow']);
    expect(adapter.callsOf('resizeWindow')[0]!.args['size']).toEqual({ width: 3360, height: 1360 });
    expect(result).toMatchObject({ moved: true, resized: true, frontmost: true, onMainDisplay: true });
    expect(result.region).toEqual({ left: 40, top: 40, width: 3360, height: 1360 });
    expect(describeBringToFront(result)).toBe(
      'moved onto the main display, resized to fit it, now in front',
    );
  });

  it('the threshold is MIN_VISIBLE_PX (100) of visible width or height', () => {
    expect(MIN_VISIBLE_PX).toBe(100);
    expect(isOffMainDisplay({ left: 0, top: 200, width: 99, height: 1000 }, DISPLAY)).toBe(true);
    expect(isOffMainDisplay({ left: 0, top: 200, width: 100, height: 1000 }, DISPLAY)).toBe(false);
    expect(isOffMainDisplay({ left: 300, top: 1340, width: 800, height: 100 }, DISPLAY)).toBe(false);
    expect(isOffMainDisplay({ left: 300, top: 1341, width: 800, height: 99 }, DISPLAY)).toBe(true);
    expect(isOffMainDisplay({ left: 0, top: 0, width: 0, height: 0 }, DISPLAY)).toBe(true);
  });
});

describe('bringWindowToFront — verify, and fall back when the OS refuses', () => {
  const windows = [{ title: PDF, region: ON_SCREEN }, fakeWindow('Claude')];

  it('refused once: the second focus lands — attempts 2, no minimise/restore', async () => {
    const { adapter, run } = harness({ windows, activeTitle: 'Claude', refuseForeground: 1 });
    const result = await run('statement.pdf');
    expect(result).toMatchObject({ frontmost: true, attempts: 2 });
    expect(actions(adapter)).toEqual(['focusWindowHandle', 'focusWindowHandle']);
    expect(describeBringToFront(result)).toBe('now in front after 2 attempts');
  });

  it('refused twice: minimise + restore lands — attempts 3', async () => {
    const { adapter, run } = harness({ windows, activeTitle: 'Claude', refuseForeground: 2 });
    const result = await run('statement.pdf');
    expect(result).toMatchObject({ frontmost: true, attempts: 3, onMainDisplay: true });
    expect(actions(adapter)).toEqual([
      'focusWindowHandle',
      'focusWindowHandle',
      'minimiseWindow',
      'restoreWindow',
    ]);
    expect(adapter.windowState('statement')!.minimised).toBe(false);
  });

  it('always refused: frontmost false, and the message names the window that IS in front', async () => {
    const { adapter, run } = harness({ windows, activeTitle: 'Claude', refuseForeground: 'always' });
    const result = await run('statement.pdf');
    expect(result).toMatchObject({ found: true, frontmost: false, attempts: 3, activeTitle: 'Claude' });
    expect(result.message).toBe(
      `Windows did not bring "${PDF}" to the front; the front window is "Claude". ` +
        'A background process is often refused the foreground; click the window in the ' +
        'screenshot, or make sure nothing else is holding focus.',
    );
    // Never a keystroke: the Alt trick can open the front app's menu bar.
    expect(count(adapter, 'key')).toBe(0);
    // And the fallback did not leave it minimised.
    expect(adapter.windowState('statement')!.minimised).toBe(false);
  });

  it('always refused with no helper: the helper failure is in the message, and nothing is left minimised', async () => {
    const { adapter, run } = harness({
      windows,
      activeTitle: 'Claude',
      refuseForeground: 'always',
      osHelperError: new Error('minimising a window needs powershell.exe on win32, and it was not found'),
    });
    const result = await run('statement.pdf');
    expect(result.frontmost).toBe(false);
    expect(result.message).toMatch(/the front window is "Claude"/);
    expect(result.message).toMatch(/the minimise\/restore helper failed: minimising a window needs powershell\.exe/);
    expect(adapter.windowState('statement')!.minimised).toBe(false);
  });

  it('says so when no window reports being in front', async () => {
    const { run } = harness({ windows, refuseForeground: 'always' });
    const result = await run('statement.pdf');
    expect(result.message).toMatch(/to the front; no window reports being in front\./);
  });
});
