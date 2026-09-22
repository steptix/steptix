/**
 * The real {@link DesktopAdapter}, over nut.js
 * (docs/specs/SPEC-use-computer.md §5.8).
 *
 * This is the ONLY file in the repo that imports `@nut-tree-fork/nut-js`, and
 * it imports it INSIDE {@link loadNutAdapter} rather than at module scope.
 * That is §5.1 item 2, and it is not a style choice: the package carries a
 * prebuilt native binary, and a machine without one — CI, a container, a
 * colleague's laptop — must still run every browser test. A top-level import
 * would turn "computer mode is unavailable here" into a server that will not
 * start.
 *
 * The two failure messages §5.1 spells out live here too, because this is the
 * file that knows what actually went wrong: a load failure names the package
 * and the platform (and, on macOS, the two permissions), and a capture failure
 * names the measured Windows cause — a sandboxed spawner whose window station
 * has no read-screen right, which produces a BitBlt error 6 through a handle
 * that otherwise works.
 */
import { logger } from '../utils/logger.js';
import { chordKeyMembers } from './keys.js';
import type {
  ClickOptions,
  DesktopAdapter,
  MouseButton,
  Point,
  ScreenGrab,
  ScrollDirection,
  WindowInfo,
} from './adapter.js';

/** Named once so both messages and the docs agree on the spelling. */
export const NUT_PACKAGE = '@nut-tree-fork/nut-js';

/** §5.8 — the delay nut.js leaves between individual input events. */
export const NUT_AUTO_DELAY_MS = 20;

/** How many intermediate points a `drag` moves through. §5.8 asks for "press,
 *  move in steps, release": a two-point path teleports the pointer, and a
 *  surprising number of native controls never see the drag begin. */
const DRAG_STEPS = 20;

type NutModule = typeof import('@nut-tree-fork/nut-js');

/** §5.1 item 2 — the message when nut.js will not load. */
export function nutLoadFailureMessage(
  err: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const detail = err instanceof Error ? err.message : String(err);
  const permissions =
    platform === 'darwin'
      ? ' On macOS, node also needs Screen Recording AND Accessibility permission ' +
        '(System Settings → Privacy & Security); a new Node version has to be granted both again.'
      : '';
  return (
    `computer mode is unavailable: ${NUT_PACKAGE} could not be loaded on ${platform}. ` +
    `It ships a prebuilt native binary, and this machine has none that works.${permissions} ` +
    `Underlying error: ${detail}`
  );
}

/** §5.1 item 4 — the message when a capture fails, with the measured cause. */
export function captureFailureMessage(
  err: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (platform === 'win32') {
    return (
      `screen capture failed (BitBlt error 6); the server process cannot read the screen. ` +
      `Processes spawned by some sandboxes lack the window station's read-screen right — ` +
      `start the server from a normal terminal or from VS Code. Underlying error: ${detail}`
    );
  }
  if (platform === 'darwin') {
    return (
      `screen capture failed; node needs Screen Recording permission on macOS ` +
      `(System Settings → Privacy & Security → Screen Recording). Underlying error: ${detail}`
    );
  }
  return (
    `screen capture failed; computer mode needs an X11 display (libnut does not support ` +
    `Wayland) and an unlocked, attached session. Underlying error: ${detail}`
  );
}

/** Copy a nut.js image's pixels into a tight RGBA buffer.
 *
 *  Two things make this more than a `Buffer.from`: a grab's rows may be padded
 *  (`byteWidth` > width × channels), and a 3-channel grab has no alpha to
 *  copy. Both produce a buffer of the wrong length further downstream, where
 *  jimp reports a size mismatch rather than a channel order — which is a long
 *  way from the cause. */
function toRgba(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  byteWidth: number,
): Buffer {
  const rowBytes = byteWidth > 0 ? byteWidth : width * channels;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const src = rowStart + x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = data[src] ?? 0;
      out[dst + 1] = data[src + 1] ?? 0;
      out[dst + 2] = data[src + 2] ?? 0;
      out[dst + 3] = channels >= 4 ? (data[src + 3] ?? 255) : 255;
    }
  }
  return out;
}

/** A straight path from `from` to `to`, inclusive of both ends. */
function dragPath(from: Point, to: Point): Point[] {
  const path: Point[] = [];
  for (let step = 0; step <= DRAG_STEPS; step++) {
    const t = step / DRAG_STEPS;
    path.push({
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
    });
  }
  return path;
}

function buildAdapter(nut: NutModule): DesktopAdapter {
  nut.mouse.config.autoDelayMs = NUT_AUTO_DELAY_MS;
  nut.keyboard.config.autoDelayMs = NUT_AUTO_DELAY_MS;

  const buttons: Record<MouseButton, number> = {
    left: nut.Button.LEFT,
    middle: nut.Button.MIDDLE,
    right: nut.Button.RIGHT,
  };

  const point = (p: Point): InstanceType<NutModule['Point']> =>
    new nut.Point(Math.round(p.x), Math.round(p.y));

  async function listWindows(): Promise<WindowInfo[]> {
    const windows = await nut.getWindows();
    return Promise.all(
      windows.map(async (window) => {
        let title = '';
        try {
          title = await window.getTitle();
        } catch {
          // A window that closed between the list and the read. Its title is
          // unknown, not empty-by-design; it stays in the list so a
          // `wait_window … gone` does not succeed on a window still on screen.
        }
        let region = { left: 0, top: 0, width: 0, height: 0 };
        try {
          const r = await window.getRegion();
          region = { left: r.left, top: r.top, width: r.width, height: r.height };
        } catch {
          // Same, for the geometry. Nothing on this surface acts on it.
        }
        return { title, region };
      }),
    );
  }

  return {
    async grab(): Promise<ScreenGrab> {
      let image;
      try {
        image = await nut.screen.grab();
      } catch (err) {
        throw new Error(captureFailureMessage(err));
      }
      // nut.js hands back BGR(A) on every platform it supports; `toRGB` swaps
      // the two outer channels so nothing above this line has to know.
      const rgbImage = await image.toRGB();
      return {
        width: rgbImage.width,
        height: rgbImage.height,
        scaleX: rgbImage.pixelDensity?.scaleX || 1,
        scaleY: rgbImage.pixelDensity?.scaleY || 1,
        rgba: toRgba(
          rgbImage.data,
          rgbImage.width,
          rgbImage.height,
          rgbImage.channels,
          rgbImage.byteWidth,
        ),
      };
    },

    async screenSize(): Promise<{ width: number; height: number }> {
      const [width, height] = await Promise.all([nut.screen.width(), nut.screen.height()]);
      return { width, height };
    },

    async move(p: Point): Promise<void> {
      await nut.mouse.setPosition(point(p));
    },

    async click(p: Point, options: ClickOptions = {}): Promise<void> {
      const button = buttons[options.button ?? 'left'];
      const count = options.count ?? 1;
      await nut.mouse.setPosition(point(p));
      if (count >= 2) {
        await nut.mouse.doubleClick(button);
        // A triple is a double followed by a single, inside the OS's own
        // multi-click window; `autoDelayMs` of 20 keeps it there.
        for (let i = 2; i < count; i++) await nut.mouse.click(button);
      } else {
        await nut.mouse.click(button);
      }
    },

    async drag(from: Point, to: Point): Promise<void> {
      await nut.mouse.setPosition(point(from));
      await nut.mouse.drag(dragPath(from, to).map(point));
    },

    async scroll(p: Point, direction: ScrollDirection, ticks: number): Promise<void> {
      await nut.mouse.setPosition(point(p));
      const amount = Math.max(1, Math.round(ticks));
      if (direction === 'down') await nut.mouse.scrollDown(amount);
      else if (direction === 'up') await nut.mouse.scrollUp(amount);
      else if (direction === 'left') await nut.mouse.scrollLeft(amount);
      else await nut.mouse.scrollRight(amount);
    },

    async type(text: string): Promise<void> {
      await nut.keyboard.type(text);
    },

    async key(chord: string): Promise<void> {
      const members = chordKeyMembers(chord);
      const enumeration = nut.Key as unknown as Record<string, number | undefined>;
      const keys = members.map((member) => {
        const value = enumeration[member];
        if (value === undefined) {
          throw new Error(
            `${NUT_PACKAGE} has no key "${member}" (from chord "${chord}") — the key table in ` +
              'src/desktop/keys.ts is out of date with the installed nut.js.',
          );
        }
        return value as Parameters<NutModule['keyboard']['pressKey']>[number];
      });
      await nut.keyboard.pressKey(...keys);
      // Released in reverse, so a modifier is never let go before the key it
      // qualifies (§5.8).
      await nut.keyboard.releaseKey(...[...keys].reverse());
    },

    windows: listWindows,

    async focusWindow(titleSubstring: string): Promise<boolean> {
      const needle = titleSubstring.toLowerCase();
      const windows = await nut.getWindows();
      for (const window of windows) {
        let title = '';
        try {
          title = await window.getTitle();
        } catch {
          continue;
        }
        if (title.toLowerCase().includes(needle)) {
          await window.focus();
          return true;
        }
      }
      return false;
    },
  };
}

let cached: Promise<DesktopAdapter> | null = null;

/**
 * Load nut.js and build the adapter, once per process.
 *
 * Throws {@link nutLoadFailureMessage} when the package will not load. The
 * cached promise is cleared on failure so a later session can try again —
 * caching a rejection would make one bad moment permanent for the life of the
 * server.
 */
export async function loadNutAdapter(): Promise<DesktopAdapter> {
  if (cached) return cached;
  cached = (async () => {
    let nut: NutModule;
    try {
      const imported = (await import('@nut-tree-fork/nut-js')) as NutModule & {
        default?: NutModule;
      };
      nut = imported.default ?? imported;
    } catch (err) {
      throw new Error(nutLoadFailureMessage(err));
    }
    logger.debug(`[computer] loaded ${NUT_PACKAGE} on ${process.platform}`);
    return buildAdapter(nut);
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

/** Forget the loaded adapter. For tests, and for a server that has released
 *  computer mode entirely. */
export function resetNutAdapter(): void {
  cached = null;
}

/**
 * §5.1 item 4's probe: one grab, taken before the surface is entered, so a
 * machine that cannot capture says so at the switch rather than at the first
 * step that needed to see something.
 */
export async function probeComputerCapture(adapter: DesktopAdapter): Promise<void> {
  await adapter.grab();
}
