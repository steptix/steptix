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
 *
 * The window primitives run a small window manager: each window has a TRUE
 * rect (which may lie on another monitor, or hang off an edge), minimised and
 * maximised flags, and one window may be active. What it hands back is what
 * nut.js hands back — {@link clipToDisplay} applies the same clip
 * `Window.getRegion()` does, so the policy in `bring-to-front.ts` is tested
 * against the semantics measured on the real thing (§14), not against a
 * friendlier geometry it will never see.
 */
import {
  titleContains,
  type ClickOptions,
  type DesktopAdapter,
  type Point,
  type ScreenGrab,
  type ScrollDirection,
  type WindowHandle,
  type WindowInfo,
  type WindowRef,
  type WindowRegion,
  type WindowSize,
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
    | 'findWindow'
    | 'activeWindow'
    | 'windowRegion'
    | 'moveWindow'
    | 'resizeWindow'
    | 'focusWindowHandle'
    | 'restoreWindow'
    | 'minimiseWindow';
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

/**
 * One window of the fake's window manager. A plain {@link WindowInfo} is one
 * too — its `region` is then taken as the TRUE rect.
 */
export interface FakeWindowSpec {
  title: string;
  /** The window's TRUE rect in logical screen coordinates: what the OS knows,
   *  before nut.js clips it to the main display. While minimised, the rect it
   *  comes back to. */
  region: WindowRegion;
  minimised?: boolean;
  maximised?: boolean;
}

/** A window's state, as a test inspects it after the fact. */
export interface FakeWindowState {
  handle: WindowHandle;
  title: string;
  region: WindowRegion;
  minimised: boolean;
  maximised: boolean;
}

export interface FakeAdapterOptions extends FakeGrabSpec {
  /** The windows, as they stand. Change them with {@link FakeDesktopAdapter.setWindows}. */
  windows?: FakeWindowSpec[];
  /** One window list per `windows()` call, in order; the last entry repeats.
   *  This is how a `wait_window` test makes a window appear on the third poll
   *  without any timing. It drives `windows()` ONLY — the window primitives
   *  act on {@link windows}. */
  windowsSequence?: WindowInfo[][];
  /** The window in front at the start: the first whose title contains this.
   *  Default: none reports being in front. */
  activeTitle?: string;
  /** How many activations (a focus, or the restore helper) the "OS" refuses
   *  before it honours one; `'always'` refuses every one. A refused activation
   *  still un-minimises — measured: nut.js `focus()` restored a window while
   *  another app stayed in front (§14). Default 0. */
  refuseForeground?: number | 'always';
  /** Whether a focus restores a minimised window. Measured true 4 of 4 times
   *  on Windows (§14); false models the case where it does not. Default true. */
  focusRestoresMinimised?: boolean;
  /** Made to throw by a test that wants §5.1 item 4's capture-probe failure. */
  grabError?: Error;
  /** Made to throw by `restoreWindow` / `minimiseWindow` — a helper whose tool
   *  is not installed. */
  osHelperError?: Error;
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

/**
 * nut.js 4.2.6 `Window.getRegion()`'s clip, line for line: pull a negative
 * left or top in to 0 (shortening the window by the hidden part), cut off
 * whatever passes the display's right or bottom edge, and floor a negative
 * size at 0. The origin is NOT moved when a window lies wholly past the right
 * or bottom edge — which is why a window on a monitor to the right reads, say,
 * (4000,200 0×1240).
 */
export function clipToDisplay(
  rect: WindowRegion,
  display: { width: number; height: number },
): WindowRegion {
  const region = { ...rect };
  if (region.left < 0) {
    region.width = region.width + region.left;
    region.left = 0;
  }
  if (region.top < 0) {
    region.height = region.height + region.top;
    region.top = 0;
  }
  if (region.left + region.width > display.width) {
    region.width = region.width - (region.left + region.width - display.width);
  }
  if (region.top + region.height > display.height) {
    region.height = region.height - (region.top + region.height - display.height);
  }
  if (region.width < 0) region.width = 0;
  if (region.height < 0) region.height = 0;
  return region;
}

/** The first fake handle. Not 0 or 1, so a test that confuses a handle with an
 *  index fails loudly. */
const FIRST_HANDLE = 1001;

export class FakeDesktopAdapter implements DesktopAdapter {
  readonly calls: FakeCall[] = [];

  private grabSpec: FakeGrabSpec;
  private managed: FakeWindowState[] = [];
  private readonly sequence: WindowInfo[][] | undefined;
  private windowsCalls = 0;
  private active: WindowHandle | null = null;
  private refusals: number;
  private readonly focusRestores: boolean;
  private grabError: Error | undefined;
  private osHelperError: Error | undefined;

  constructor(options: FakeAdapterOptions = {}) {
    const {
      windows,
      windowsSequence,
      activeTitle,
      refuseForeground,
      focusRestoresMinimised,
      grabError,
      osHelperError,
      ...grabSpec
    } = options;
    this.grabSpec = grabSpec;
    this.sequence = windowsSequence;
    this.setWindows(windows ?? []);
    if (activeTitle !== undefined) this.setActive(activeTitle);
    this.refusals = refuseForeground === 'always' ? Infinity : (refuseForeground ?? 0);
    this.focusRestores = focusRestoresMinimised ?? true;
    this.grabError = grabError;
    this.osHelperError = osHelperError;
  }

  /** Every call of one name, in order — the usual assertion shape. */
  callsOf(name: FakeCall['name']): FakeCall[] {
    return this.calls.filter((call) => call.name === name);
  }

  setGrabSpec(spec: FakeGrabSpec): void {
    this.grabSpec = spec;
  }

  /** Replace the windows. Handles are reassigned from {@link FIRST_HANDLE} in
   *  list order, and nothing is in front. */
  setWindows(windows: FakeWindowSpec[]): void {
    this.managed = windows.map((w, i) => ({
      handle: FIRST_HANDLE + i,
      title: w.title,
      region: { ...w.region },
      minimised: w.minimised ?? false,
      maximised: w.maximised ?? false,
    }));
    this.active = null;
  }

  /** Put the first window whose title contains `title` in front; `null` for
   *  none. */
  setActive(title: string | null): void {
    this.active = title === null ? null : (this.lookup(title)?.handle ?? null);
  }

  /** How many further activations to refuse; `'always'` for every one. */
  setForegroundRefusals(count: number | 'always'): void {
    this.refusals = count === 'always' ? Infinity : count;
  }

  setGrabError(error: Error | undefined): void {
    this.grabError = error;
  }

  /** The TRUE state of the first window whose title contains `title` —
   *  unclipped, which no adapter call can return. */
  windowState(title: string): FakeWindowState | undefined {
    const found = this.lookup(title);
    return found ? { ...found, region: { ...found.region } } : undefined;
  }

  async grab(): Promise<ScreenGrab> {
    this.calls.push({ name: 'grab', args: {} });
    if (this.grabError) throw this.grabError;
    return makeFakeGrab(this.grabSpec);
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    this.calls.push({ name: 'screenSize', args: {} });
    return this.display();
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
    return this.managed.map((w) => ({ title: w.title, region: this.clipped(w) }));
  }

  async findWindow(titleSubstring: string): Promise<WindowRef | null> {
    const found = this.lookup(titleSubstring);
    this.calls.push({
      name: 'findWindow',
      args: { titleSubstring, found: found?.handle ?? null },
    });
    return found ? this.ref(found) : null;
  }

  async activeWindow(): Promise<WindowRef | null> {
    const found = this.managed.find((w) => w.handle === this.active);
    this.calls.push({ name: 'activeWindow', args: { title: found?.title ?? null } });
    return found ? this.ref(found) : null;
  }

  async windowRegion(handle: WindowHandle): Promise<WindowRegion> {
    const window = this.byHandle(handle);
    const region = this.clipped(window);
    this.calls.push({ name: 'windowRegion', args: { handle, region } });
    return region;
  }

  async moveWindow(handle: WindowHandle, origin: Point): Promise<void> {
    this.calls.push({ name: 'moveWindow', args: { handle, origin } });
    const window = this.byHandle(handle);
    window.region = { ...window.region, left: origin.x, top: origin.y };
    // A window that has been moved no longer fills its monitor.
    window.maximised = false;
  }

  async resizeWindow(handle: WindowHandle, size: WindowSize): Promise<void> {
    this.calls.push({ name: 'resizeWindow', args: { handle, size } });
    const window = this.byHandle(handle);
    window.region = { ...window.region, width: size.width, height: size.height };
    window.maximised = false;
  }

  async focusWindowHandle(handle: WindowHandle): Promise<void> {
    const window = this.byHandle(handle);
    if (window.minimised && this.focusRestores) window.minimised = false;
    const activated = this.activate(window);
    this.calls.push({ name: 'focusWindowHandle', args: { handle, activated } });
  }

  async restoreWindow(handle: WindowHandle): Promise<void> {
    this.calls.push({ name: 'restoreWindow', args: { handle } });
    if (this.osHelperError) throw this.osHelperError;
    const window = this.byHandle(handle);
    window.minimised = false;
    // Measured: ShowWindow(SW_RESTORE) restored AND activated (§14) — subject
    // to the same refusal a focus is.
    this.activate(window);
  }

  async minimiseWindow(handle: WindowHandle): Promise<void> {
    this.calls.push({ name: 'minimiseWindow', args: { handle } });
    if (this.osHelperError) throw this.osHelperError;
    const window = this.byHandle(handle);
    window.minimised = true;
    if (this.active === handle) this.active = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** The main display's LOGICAL size — what `screenSize()` answers, and what
   *  every region is clipped to. Same defaults as {@link makeFakeGrab}, without
   *  building a grab to read them off. */
  private display(): { width: number; height: number } {
    const width = this.grabSpec.width ?? 3440;
    const height = this.grabSpec.height ?? 1440;
    return {
      width: Math.round(width / (this.grabSpec.scaleX ?? 1)),
      height: Math.round(height / (this.grabSpec.scaleY ?? 1)),
    };
  }

  private clipped(window: FakeWindowState): WindowRegion {
    // Measured: a minimised window reads (0,0 0×0).
    if (window.minimised) return { left: 0, top: 0, width: 0, height: 0 };
    return clipToDisplay(window.region, this.display());
  }

  private ref(window: FakeWindowState): WindowRef {
    return { title: window.title, handle: window.handle, region: this.clipped(window) };
  }

  private lookup(titleSubstring: string): FakeWindowState | undefined {
    return this.managed.find((w) => titleContains(w.title, titleSubstring));
  }

  private byHandle(handle: WindowHandle): FakeWindowState {
    const window = this.managed.find((w) => w.handle === handle);
    if (!window) throw new Error(`FakeDesktopAdapter: no window has handle ${handle}`);
    return window;
  }

  /** Activate `window` unless a refusal is pending. `true` when it happened. */
  private activate(window: FakeWindowState): boolean {
    if (this.refusals > 0) {
      this.refusals--;
      return false;
    }
    this.active = window.handle;
    return true;
  }
}

/** A window list entry, with a region nobody has to spell out. */
export function fakeWindow(title: string, region?: WindowInfo['region']): WindowInfo {
  return { title, region: region ?? { left: 0, top: 0, width: 800, height: 600 } };
}
