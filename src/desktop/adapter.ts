/**
 * The desktop surface's one seam (docs/specs/SPEC-use-computer.md §5.8).
 *
 * Everything the computer surface does to the machine goes through
 * {@link DesktopAdapter}: a grab of the primary display, a mouse move, a
 * click, a chord, the window list. `nut-adapter.ts` is the real
 * implementation and is the ONLY file in this repo that imports
 * `@nut-tree-fork/nut-js`; `fake-adapter.ts` is the in-memory one every unit
 * test drives.
 *
 * That single-importer rule is not tidiness. nut.js carries a prebuilt native
 * binary, and a machine without it — or without permission to read the screen
 * — must still run every browser test (§5.1 item 2). Keeping the import inside
 * one lazily-loaded factory is what makes "computer mode is unavailable here"
 * a step failure rather than a server that will not start.
 */

/** A point on the screen, in LOGICAL screen coordinates — the space
 *  `screen.width()` reports and the space nut.js's mouse takes. The two
 *  factors that get here from an image pixel live in `capture.ts`
 *  (`mapToScreen`, §5.2). */
export interface Point {
  x: number;
  y: number;
}

/** A rectangle in some image's own pixel space. */
export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which mouse button an action uses (§5.4). */
export type MouseButton = 'left' | 'right' | 'middle';

/** How many times a click action clicks (§5.4). */
export type ClickCount = 1 | 2 | 3;

/** Wheel direction for a `scroll` action (§5.4). */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * One capture of the primary display, at FULL physical resolution.
 *
 * `width`/`height` are physical pixels — what the framebuffer holds. `scaleX`/
 * `scaleY` are nut.js's `pixelDensity`: physical ÷ logical, so 1 on an
 * ordinary display and 2 on a Retina one. Both are needed because the image
 * the model is shown is downscaled from `width`×`height` while the mouse is
 * driven in logical points; §5.2 is the two-factor conversion between them.
 *
 * `rgba` is `width * height * 4` bytes, row-major, red first. nut.js hands
 * back BGRA on Windows; the nut adapter converts before it gets here, so no
 * caller has to know the platform's channel order.
 */
export interface ScreenGrab {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  rgba: Buffer;
}

/** A window's position and size, in logical screen coordinates. Field names
 *  match nut.js's `Region` so the adapter can hand one straight through. */
export interface WindowRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One entry of the window list `focus_window` / `wait_window` answer from
 *  (§5.4). A window whose region could not be read still appears — the title
 *  is what those two actions match on, and dropping the entry would make a
 *  `wait_window ... gone` succeed while the window is still on screen. */
export interface WindowInfo {
  title: string;
  region: WindowRegion;
}

/** Options for {@link DesktopAdapter.click}. */
export interface ClickOptions {
  /** Default `left`. */
  button?: MouseButton;
  /** Default 1. */
  count?: ClickCount;
}

/**
 * The operations the computer surface performs. Deliberately small and
 * deliberately coordinate-only: no selectors, no accessibility tree, nothing
 * that would let one platform's capability leak into the action vocabulary
 * (§2 — pixels behave the same for a canvas, a plugin, a browser dialog and an
 * OS dialog).
 */
export interface DesktopAdapter {
  /** Capture the primary display at full physical resolution. */
  grab(): Promise<ScreenGrab>;
  /** The primary display's LOGICAL size — `screen.width()`/`height()`. */
  screenSize(): Promise<{ width: number; height: number }>;
  /** Move the pointer without clicking (the `move` action's hover). */
  move(point: Point): Promise<void>;
  /** Move, then click. */
  click(point: Point, options?: ClickOptions): Promise<void>;
  /** Press at `from`, move, release at `to`. */
  drag(from: Point, to: Point): Promise<void>;
  /** Move to `point`, then turn the wheel `ticks` steps in `direction`. */
  scroll(point: Point, direction: ScrollDirection, ticks: number): Promise<void>;
  /** Type into whatever has OS focus. */
  type(text: string): Promise<void>;
  /** Press a chord in the §5.4 grammar (`enter`, `ctrl+s`, `cmd+shift+g`). */
  key(chord: string): Promise<void>;
  /** Every top-level window, newest-first ordering not guaranteed. */
  windows(): Promise<WindowInfo[]>;
  /** Bring the FIRST window whose title contains `titleSubstring`
   *  (case-insensitive) to the front. `false` when none matched. */
  focusWindow(titleSubstring: string): Promise<boolean>;
}
