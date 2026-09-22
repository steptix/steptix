/**
 * The in-memory {@link DesktopAdapter} every unit test drives
 * (docs/specs/SPEC-use-computer.md §5.8: "an interface with a nut.js
 * implementation and a fake for tests").
 *
 * It exists for two reasons, and the second is the load-bearing one. The first
 * is the ordinary one — a test that asserts a click landed at a logical point
 * should not need a screen. The second is that the machine this was built on
 * CANNOT capture the screen from a spawned tool process (§5.1 item 4: BitBlt
 * error 6), so the real adapter is exercised only by a live run from a server
 * started in a normal terminal. Everything else is proved here.
 *
 * Every call is recorded with its arguments, in order, so a test asserts what
 * the adapter was ASKED to do rather than what it did.
 */
import type {
  ClickOptions,
  DesktopAdapter,
  Point,
  ScreenGrab,
  ScrollDirection,
  WindowInfo,
} from './adapter.js';

/** One recorded call. `args` holds the call's own parameters by name. */
export interface FakeCall {
  name:
    | 'grab'
    | 'screenSize'
    | 'move'
    | 'click'
    | 'drag'
    | 'scroll'
    | 'type'
    | 'key'
    | 'windows'
    | 'focusWindow';
  args: Record<string, unknown>;
}

export interface FakeGrabSpec {
  width?: number;
  height?: number;
  /** nut.js `pixelDensity` — physical ÷ logical. Default 1. */
  scaleX?: number;
  scaleY?: number;
  /** Mixed into the synthetic pixels so two grabs can be made to differ (the
   *  stall detector's "pixel-identical captures" test needs both). */
  seed?: number;
}

export interface FakeAdapterOptions extends FakeGrabSpec {
  /** The window list, as it stands. Change it with {@link FakeDesktopAdapter.setWindows}. */
  windows?: WindowInfo[];
  /** One window list per `windows()` call, in order; the last entry repeats.
   *  This is how a `wait_window` test makes a window appear on the third poll
   *  without any timing. */
  windowsSequence?: WindowInfo[][];
  /** What `focusWindow` answers. Default: true when some window's title
   *  contains the substring, case-insensitively. */
  focusWindow?: (titleSubstring: string, windows: WindowInfo[]) => boolean;
  /** Made to throw by a test that wants §5.1 item 4's capture-probe failure. */
  grabError?: Error;
}

/** A deterministic RGBA buffer of the right length. Not noise: a gradient with
 *  the seed folded in, so two spec'd grabs are byte-identical when their specs
 *  are, and differ when their seeds do. */
export function makeFakeGrab(spec: FakeGrabSpec = {}): ScreenGrab {
  const width = spec.width ?? 3440;
  const height = spec.height ?? 1440;
  const seed = spec.seed ?? 0;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    rgba[offset] = (i + seed) % 256;
    rgba[offset + 1] = (i * 7 + seed) % 256;
    rgba[offset + 2] = (i * 13 + seed) % 256;
    rgba[offset + 3] = 255;
  }
  return {
    width,
    height,
    scaleX: spec.scaleX ?? 1,
    scaleY: spec.scaleY ?? 1,
    rgba,
  };
}

export class FakeDesktopAdapter implements DesktopAdapter {
  readonly calls: FakeCall[] = [];

  private grabSpec: FakeGrabSpec;
  private windowList: WindowInfo[];
  private readonly sequence: WindowInfo[][] | undefined;
  private windowsCalls = 0;
  private readonly focusAnswer: FakeAdapterOptions['focusWindow'];
  private grabError: Error | undefined;

  constructor(options: FakeAdapterOptions = {}) {
    const { windows, windowsSequence, focusWindow, grabError, ...grabSpec } = options;
    this.grabSpec = grabSpec;
    this.windowList = windows ?? [];
    this.sequence = windowsSequence;
    this.focusAnswer = focusWindow;
    this.grabError = grabError;
  }

  /** Every call of one name, in order — the usual assertion shape. */
  callsOf(name: FakeCall['name']): FakeCall[] {
    return this.calls.filter((call) => call.name === name);
  }

  setGrabSpec(spec: FakeGrabSpec): void {
    this.grabSpec = spec;
  }

  setWindows(windows: WindowInfo[]): void {
    this.windowList = windows;
  }

  setGrabError(error: Error | undefined): void {
    this.grabError = error;
  }

  async grab(): Promise<ScreenGrab> {
    this.calls.push({ name: 'grab', args: {} });
    if (this.grabError) throw this.grabError;
    return makeFakeGrab(this.grabSpec);
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    this.calls.push({ name: 'screenSize', args: {} });
    const grab = makeFakeGrab(this.grabSpec);
    return {
      width: Math.round(grab.width / grab.scaleX),
      height: Math.round(grab.height / grab.scaleY),
    };
  }

  async move(point: Point): Promise<void> {
    this.calls.push({ name: 'move', args: { point } });
  }

  async click(point: Point, options: ClickOptions = {}): Promise<void> {
    this.calls.push({
      name: 'click',
      args: { point, button: options.button ?? 'left', count: options.count ?? 1 },
    });
  }

  async drag(from: Point, to: Point): Promise<void> {
    this.calls.push({ name: 'drag', args: { from, to } });
  }

  async scroll(point: Point, direction: ScrollDirection, ticks: number): Promise<void> {
    this.calls.push({ name: 'scroll', args: { point, direction, ticks } });
  }

  async type(text: string): Promise<void> {
    this.calls.push({ name: 'type', args: { text } });
  }

  async key(chord: string): Promise<void> {
    this.calls.push({ name: 'key', args: { chord } });
  }

  async windows(): Promise<WindowInfo[]> {
    const index = this.windowsCalls++;
    this.calls.push({ name: 'windows', args: { index } });
    if (this.sequence && this.sequence.length > 0) {
      return this.sequence[Math.min(index, this.sequence.length - 1)]!;
    }
    return this.windowList;
  }

  async focusWindow(titleSubstring: string): Promise<boolean> {
    const current = this.sequence
      ? this.sequence[Math.min(this.windowsCalls, this.sequence.length - 1)]!
      : this.windowList;
    const found = this.focusAnswer
      ? this.focusAnswer(titleSubstring, current)
      : current.some((w) => w.title.toLowerCase().includes(titleSubstring.toLowerCase()));
    this.calls.push({ name: 'focusWindow', args: { titleSubstring, found } });
    return found;
  }
}

/** A window list entry, with a region nobody has to spell out. */
export function fakeWindow(title: string, region?: WindowInfo['region']): WindowInfo {
  return { title, region: region ?? { left: 0, top: 0, width: 800, height: 600 } };
}
