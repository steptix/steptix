/**
 * `focus_window`'s policy: leave the target window IN FRONT, ON THE MAIN
 * DISPLAY and NOT MINIMISED, and check that it did
 * (docs/specs/SPEC-use-computer.md §5.4, §5.8, §14).
 *
 * The adapter supplies mechanism only — find, focus, read the region, move,
 * resize, and the per-OS minimise/restore helpers. Everything that decides
 * WHICH of those to call, and whether the result is good enough, is here, so
 * it is written once and proved against the fake adapter, whose regions are
 * clipped exactly the way nut.js clips them.
 *
 * What it works around, all measured on Windows 11 (§14):
 *
 * - Focusing is not activating. nut.js `focus()` restores a minimised window,
 *   but a background process can be refused the foreground, and then the
 *   window comes back BEHIND whatever was in front. So success is read back
 *   from the OS's active window, never assumed.
 * - Computer mode sees and clicks the main display only, and a window on
 *   another monitor is invisible to it. `getRegion()` is clipped to the main
 *   display on every side, so a window's true size and off-screen position
 *   cannot be read — only how much of it is visible. That is the whole of what
 *   the geometry rule below looks at.
 * - libnut cannot minimise or restore. The adapter's helpers do that outside
 *   it, at ~0.5–1 s a spawn on Windows, so they are the fallback and never the
 *   first move.
 *
 * It never sends a keystroke. The Alt-key trick for winning the foreground can
 * open the foreground app's menu bar instead, which is a worse state than the
 * one it set out to fix.
 */
import { titleContains, type DesktopAdapter, type WindowRegion } from './adapter.js';

/** A clipped region narrower or shorter than this is "off the main display":
 *  on another monitor (0 wide), mostly off an edge, or still minimised. */
export const MIN_VISIBLE_PX = 100;

/** Where a window that was off the main display is moved to. */
export const SAFE_ORIGIN = { x: 40, y: 40 } as const;

/** A moved window that still runs off the right or bottom edge is resized to
 *  the display's size less this, so it fits with {@link SAFE_ORIGIN} to spare. */
export const FIT_MARGIN_PX = 80;

/** How long to let the window manager catch up after each window operation,
 *  before reading anything back. */
export const DEFAULT_BRING_TO_FRONT_SETTLE_MS = 150;

export interface BringToFrontOptions {
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Default {@link DEFAULT_BRING_TO_FRONT_SETTLE_MS}. */
  settleMs?: number;
  /** One line per step taken and region read — for the run log at debug
   *  level, and for anyone driving this by hand against a real desktop. */
  trace?: (line: string) => void;
  /** Names the OS in the refusal message. Defaults to this host. */
  platform?: NodeJS.Platform;
}

export interface BringToFrontResult {
  /** A window's title contained the text. Everything below is meaningless
   *  when this is false. */
  found: boolean;
  /** The matched window's full title. */
  title?: string;
  /** It was already the active window before anything was done to it. */
  alreadyFront: boolean;
  /** It was minimised (read back as 0,0 0×0) and is not now. */
  restored: boolean;
  /** It was moved to {@link SAFE_ORIGIN} because too little of it was on the
   *  main display. */
  moved: boolean;
  /** It was resized to fit after the move. */
  resized: boolean;
  /** The OS's active window's title contains the text — the verification. */
  frontmost: boolean;
  /** At least {@link MIN_VISIBLE_PX} of it is on the main display at the end
   *  (or it is a small window that is wholly on it). */
  onMainDisplay: boolean;
  /** The active window's title at the last check. */
  activeTitle?: string;
  /** Activation tries: 1 is the first focus, 2 a second focus, 3 the
   *  minimise-and-restore fallback. */
  attempts: number;
  /** Its clipped region at the end. */
  region?: WindowRegion;
  /** Why it failed, for the model — present when `frontmost` or
   *  `onMainDisplay` is false. */
  message?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The region a minimised window reads back as (measured). A window wholly
 *  off the top-left corner reads the same, and is handled the same way. */
export function isEmptyRegion(r: WindowRegion): boolean {
  return r.left === 0 && r.top === 0 && r.width === 0 && r.height === 0;
}

/**
 * Whether too little of a window is on the main display to use.
 *
 * `region` is CLIPPED, so this is "less than {@link MIN_VISIBLE_PX} is visible
 * across or down" — which is a window wholly on another monitor, one mostly
 * off an edge, or one still minimised. One exception, because the clip leaves
 * a signature: nut.js only ever shortens a window by pulling it to an edge, so
 * a non-empty region touching NO edge was not clipped at all — it is the
 * window's true rect, wholly visible, and a small dialog is left where it is.
 *
 * A window straddling two monitors with a usable part on the main one is on
 * the main display by this rule and is not moved; the model sees and clicks
 * the part that is there.
 */
export function isOffMainDisplay(
  region: WindowRegion,
  display: { width: number; height: number },
): boolean {
  const wholeAndInside =
    region.width > 0 &&
    region.height > 0 &&
    region.left > 0 &&
    region.top > 0 &&
    region.left + region.width < display.width &&
    region.top + region.height < display.height;
  if (wholeAndInside) return false;
  return region.width < MIN_VISIBLE_PX || region.height < MIN_VISIBLE_PX;
}

/** Whether a (clipped) region reaches the display's right or bottom edge —
 *  after a move to {@link SAFE_ORIGIN}, the sign that it is bigger than the
 *  display and the clip is hiding the rest. */
export function touchesRightOrBottom(
  region: WindowRegion,
  display: { width: number; height: number },
): boolean {
  return (
    region.left + region.width >= display.width - 1 ||
    region.top + region.height >= display.height - 1
  );
}

function fmt(r: WindowRegion): string {
  return `(${r.left},${r.top} ${r.width}×${r.height})`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function osName(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return 'The window manager';
}

/**
 * Bring the first window whose title contains `titleSubstring` (ignoring case)
 * to the front, onto the main display, un-minimised — and verify it.
 *
 * a. Find it. Not found → `found: false`, and nothing is touched.
 * b. Focus it (which also restores a minimised window, measured), settle, and
 *    re-read its region.
 * c. If it is off the main display ({@link isOffMainDisplay}): if it still
 *    reads 0,0 0×0, restore it with the helper and re-read; if it is still
 *    off, move it to {@link SAFE_ORIGIN} and re-read; if it then runs off the
 *    right or bottom edge, resize it to the display less
 *    {@link FIT_MARGIN_PX} each way and re-read.
 * d. Verify: the active window's title contains the text.
 * e. If not: focus again and verify; then minimise and restore it through the
 *    helper (measured to activate on Windows) and verify. Still not → a
 *    `frontmost: false` result whose message names the window that IS in front.
 */
export async function bringWindowToFront(
  adapter: DesktopAdapter,
  titleSubstring: string,
  opts: BringToFrontOptions = {},
): Promise<BringToFrontResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const settleMs = opts.settleMs ?? DEFAULT_BRING_TO_FRONT_SETTLE_MS;
  const trace = opts.trace ?? ((): void => {});
  const settle = async (): Promise<void> => {
    if (settleMs > 0) await sleep(settleMs);
  };

  // ── a. find ──────────────────────────────────────────────────────────────
  const target = await adapter.findWindow(titleSubstring);
  if (!target) {
    trace(`no window's title contains "${titleSubstring}"`);
    return {
      found: false,
      alreadyFront: false,
      restored: false,
      moved: false,
      resized: false,
      frontmost: false,
      onMainDisplay: false,
      attempts: 0,
    };
  }
  const handle = target.handle;
  const display = await adapter.screenSize();

  const inFront = async (): Promise<{ front: boolean; activeTitle?: string }> => {
    const active = await adapter.activeWindow();
    if (!active) return { front: false };
    return { front: titleContains(active.title, titleSubstring), activeTitle: active.title };
  };

  const before = await inFront();
  const wasMinimised = isEmptyRegion(target.region);
  trace(
    `found "${target.title}" (handle ${handle}) at ${fmt(target.region)} on a ` +
      `${display.width}×${display.height} main display` +
      (before.front ? '; already in front' : `; in front: "${before.activeTitle ?? '(none)'}"`),
  );

  /** Helper failures, carried into the message if the end result is bad. */
  const notes: string[] = [];

  // ── b. focus ─────────────────────────────────────────────────────────────
  await adapter.focusWindowHandle(handle);
  let attempts = 1;
  await settle();
  let region = await adapter.windowRegion(handle);
  let restored = wasMinimised && !isEmptyRegion(region);
  let moved = false;
  let resized = false;
  trace(`after focus: ${fmt(region)}`);

  // ── c. onto the main display ─────────────────────────────────────────────
  if (isOffMainDisplay(region, display)) {
    if (isEmptyRegion(region)) {
      try {
        await adapter.restoreWindow(handle);
      } catch (err) {
        notes.push(`the restore helper failed: ${errorText(err)}`);
      }
      await settle();
      region = await adapter.windowRegion(handle);
      if (wasMinimised && !isEmptyRegion(region)) restored = true;
      trace(`after restore helper: ${fmt(region)}`);
    }
    if (isOffMainDisplay(region, display)) {
      await adapter.moveWindow(handle, { x: SAFE_ORIGIN.x, y: SAFE_ORIGIN.y });
      moved = true;
      await settle();
      region = await adapter.windowRegion(handle);
      trace(`after move to (${SAFE_ORIGIN.x},${SAFE_ORIGIN.y}): ${fmt(region)}`);
      if (touchesRightOrBottom(region, display)) {
        const size = {
          width: display.width - FIT_MARGIN_PX,
          height: display.height - FIT_MARGIN_PX,
        };
        await adapter.resizeWindow(handle, size);
        resized = true;
        await settle();
        region = await adapter.windowRegion(handle);
        trace(`after resize to ${size.width}×${size.height}: ${fmt(region)}`);
      }
    }
  }

  // ── d. verify ────────────────────────────────────────────────────────────
  let check = await inFront();
  trace(`attempt 1: ${check.front ? 'in front' : `in front is "${check.activeTitle ?? '(none)'}"`}`);

  // ── e. fall back ─────────────────────────────────────────────────────────
  if (!check.front) {
    attempts = 2;
    await adapter.focusWindowHandle(handle);
    await settle();
    check = await inFront();
    trace(`attempt 2 (focus again): ${check.front ? 'in front' : `in front is "${check.activeTitle ?? '(none)'}"`}`);
  }
  if (!check.front) {
    attempts = 3;
    let minimised = false;
    try {
      await adapter.minimiseWindow(handle);
      minimised = true;
      await settle();
      await adapter.restoreWindow(handle);
      minimised = false;
    } catch (err) {
      notes.push(`the minimise/restore helper failed: ${errorText(err)}`);
      // Never leave the window minimised on the way out: a focus restores one
      // (measured), and needs no helper.
      if (minimised) await adapter.focusWindowHandle(handle);
    }
    await settle();
    check = await inFront();
    region = await adapter.windowRegion(handle);
    trace(
      `attempt 3 (minimise + restore): ${check.front ? 'in front' : `in front is "${check.activeTitle ?? '(none)'}"`}` +
        ` at ${fmt(region)}`,
    );
  }

  const onMainDisplay = !isOffMainDisplay(region, display);
  const result: BringToFrontResult = {
    found: true,
    title: target.title,
    alreadyFront: before.front,
    restored,
    moved,
    resized,
    frontmost: check.front,
    onMainDisplay,
    ...(check.activeTitle !== undefined && { activeTitle: check.activeTitle }),
    attempts,
    region,
  };

  const noted = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  if (!check.front) {
    const front =
      check.activeTitle !== undefined
        ? `the front window is "${check.activeTitle}"`
        : 'no window reports being in front';
    result.message =
      `${osName(opts.platform ?? process.platform)} did not bring "${target.title}" to the front; ${front}. ` +
      'A background process is often refused the foreground; click the window in the screenshot, ' +
      `or make sure nothing else is holding focus.${noted}`;
  } else if (!onMainDisplay) {
    result.message =
      `"${target.title}" is in front but not on the main display: the part of it computer mode ` +
      `can see is ${region.width}×${region.height} at (${region.left},${region.top}), after ` +
      'focusing, restoring and moving it. Computer mode sees and clicks the main display only.' +
      noted;
  }
  return result;
}

/**
 * What happened, as the parenthetical the `[computer]` log line and the
 * step's "Actions already performed" list both print:
 * `restored from minimised, moved onto the main display, now in front`, or
 * `already in front`. Only meaningful for a successful result.
 */
export function describeBringToFront(result: BringToFrontResult): string {
  const parts: string[] = [];
  if (result.restored) parts.push('restored from minimised');
  if (result.moved) parts.push('moved onto the main display');
  if (result.resized) parts.push('resized to fit it');
  if (result.alreadyFront && result.attempts === 1) {
    parts.push('already in front');
  } else {
    parts.push(`now in front${result.attempts > 1 ? ` after ${result.attempts} attempts` : ''}`);
  }
  return parts.join(', ');
}
