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
 *
 * It also holds the per-OS window helpers ({@link runOsWindowCommand}) that
 * minimise and restore a window. libnut has neither: `Window.minimize()` and
 * `restore()` throw "Method not implemented in libnut." (§5.8), so they are
 * never called here.
 */
import { execFile } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { chordKeyMembers } from './keys.js';
import {
  titleContains,
  type ClickOptions,
  type DesktopAdapter,
  type MouseButton,
  type Point,
  type ScreenGrab,
  type ScrollDirection,
  type WindowHandle,
  type WindowInfo,
  type WindowRef,
  type WindowRegion,
  type WindowSize,
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

// ---------------------------------------------------------------------------
// Per-OS window helpers: minimise and restore, OUTSIDE libnut
// ---------------------------------------------------------------------------

/** What a helper does to a window. */
export type OsWindowOp = 'restore' | 'minimise';

/** How long a helper may take before it is abandoned. The Windows one spawns
 *  PowerShell, measured at ~0.5–1 s, so this is several times that. */
export const OS_WINDOW_HELPER_TIMEOUT_MS = 5_000;

/** user32 `ShowWindow` commands: SW_MINIMIZE and SW_RESTORE. */
export const SHOW_WINDOW_COMMAND: Record<OsWindowOp, number> = { minimise: 6, restore: 9 };

/** One helper invocation, as `execFile` takes it — no shell in between. */
export interface OsWindowCommand {
  file: string;
  args: string[];
  /** The tool's name, for the "not installed" message. */
  tool: string;
  /** How to get it, when it is the kind of thing a machine can lack. */
  install?: string;
}

/** The window a helper acts on. `title` is needed on macOS only, where System
 *  Events addresses windows by name rather than by CGWindowID. */
export interface OsWindowTarget {
  handle: WindowHandle;
  title?: string;
}

/**
 * The PowerShell script that calls user32 `ShowWindow(hwnd, command)`.
 *
 * Measured on Windows 11 (§14): SW_RESTORE from a separate PowerShell process
 * restored a minimised window AND activated it. The handle is interpolated,
 * so it is checked to be a positive integer first — it comes from libnut as a
 * number, and this is the one place a number becomes code.
 */
export function win32ShowWindowScript(handle: WindowHandle, command: number): string {
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    throw new Error(`not a window handle: ${String(handle)}`);
  }
  return (
    `Add-Type -Namespace W -Name U -MemberDefinition ` +
    `'[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'; ` +
    `[void][W.U]::ShowWindow([System.IntPtr]${handle}, ${command})`
  );
}

/**
 * The AppleScript that un-minimises (and raises) or minimises the first window
 * named exactly `argv[1]`, across every foreground process, through System
 * Events. The title is passed as an ARGUMENT rather than spliced into the
 * script, so no title can break out of a string literal.
 *
 * NOT measured: this was built on Windows. libnut's macOS window list may not
 * even include a minimised window, and System Events needs Accessibility
 * permission for node.
 */
function darwinScript(op: OsWindowOp): string {
  const act =
    op === 'restore'
      ? [
          '          set value of attribute "AXMinimized" of w to false',
          '          perform action "AXRaise" of w',
          '          set frontmost of p to true',
        ]
      : ['          set value of attribute "AXMinimized" of w to true'];
  return [
    'on run argv',
    '  set wanted to item 1 of argv',
    '  tell application "System Events"',
    '    repeat with p in (every process whose background only is false)',
    '      repeat with w in (every window of p)',
    '        if name of w is wanted then',
    ...act,
    '          return',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end tell',
    '  error "System Events lists no window named " & wanted',
    'end run',
  ].join('\n');
}

/**
 * The command that performs `op` on `target` on `platform`.
 *
 * Only the win32 path has been measured (§14). macOS goes through osascript
 * and System Events; Linux through xdotool, which is X11 like libnut itself.
 */
export function osWindowCommand(
  op: OsWindowOp,
  target: OsWindowTarget,
  platform: NodeJS.Platform = process.platform,
): OsWindowCommand {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        win32ShowWindowScript(target.handle, SHOW_WINDOW_COMMAND[op]),
      ],
      tool: 'powershell.exe',
    };
  }
  if (platform === 'darwin') {
    if (!target.title) {
      throw new Error(`cannot ${op} a window on macOS without its title (handle ${target.handle})`);
    }
    return { file: 'osascript', args: ['-e', darwinScript(op), target.title], tool: 'osascript' };
  }
  return {
    file: 'xdotool',
    args: [op === 'restore' ? 'windowactivate' : 'windowminimize', String(target.handle)],
    tool: 'xdotool',
    install: 'install it with your package manager, e.g. `sudo apt install xdotool`',
  };
}

/** `execFile`, promised, with the output attached to the error. Written out
 *  rather than `util.promisify`d so a test's mock of `node:child_process` is
 *  an ordinary callback function. */
function execFileAsync(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      // `windowsHide`: no console window flashes up — which could itself take
      // the foreground from the very window being restored.
      { timeout: OS_WINDOW_HELPER_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
        } else {
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        }
      },
    );
  });
}

/**
 * Minimise or restore a window through the platform's helper, with a
 * {@link OS_WINDOW_HELPER_TIMEOUT_MS} budget. A missing tool, a timeout and a
 * failed run each throw a message that says which.
 */
export async function runOsWindowCommand(
  op: OsWindowOp,
  target: OsWindowTarget,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const command = osWindowCommand(op, target, platform);
  const verb = op === 'restore' ? 'restoring' : 'minimising';
  try {
    await execFileAsync(command.file, command.args);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string };
    if (e.code === 'ENOENT') {
      throw new Error(
        `${verb} a window needs ${command.tool} on ${platform}, and it was not found` +
          (command.install ? ` — ${command.install}` : '') +
          '. libnut has no minimise or restore of its own.',
      );
    }
    if (e.killed || e.signal === 'SIGTERM') {
      throw new Error(
        `${verb} a window with ${command.tool} did not finish within ${OS_WINDOW_HELPER_TIMEOUT_MS} ms.`,
      );
    }
    const stderr = (e.stderr ?? '').trim();
    throw new Error(
      `${verb} a window with ${command.tool} failed: ${e.message}` + (stderr ? ` — ${stderr}` : ''),
    );
  }
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

  type NutWindow = InstanceType<NutModule['Window']>;

  /** nut.js keeps the OS handle in a field its typings mark private. It is the
   *  HWND as a number on Windows (measured: e.g. 11799974), which is exactly
   *  what the ShowWindow helper takes. */
  const handleOf = (window: NutWindow): WindowHandle =>
    (window as unknown as { windowHandle: number }).windowHandle;

  /** A nut.js `Window` for a handle, built the way `getWindows()` builds them. */
  const windowFor = (handle: WindowHandle): NutWindow =>
    new nut.Window(nut.providerRegistry, handle);

  /** `getRegion()`, which nut.js clips to the main display (see
   *  `WindowRegion`), copied out of its `Region` class. */
  async function regionOf(window: NutWindow): Promise<WindowRegion> {
    const r = await window.getRegion();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  /** The helper's target. The title is read only where the helper needs it
   *  (macOS), so Windows pays for no extra native call. */
  async function osTarget(handle: WindowHandle): Promise<OsWindowTarget> {
    if (process.platform !== 'darwin') return { handle };
    return { handle, title: await windowFor(handle).getTitle() };
  }

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

    async findWindow(titleSubstring: string): Promise<WindowRef | null> {
      for (const window of await nut.getWindows()) {
        let title = '';
        try {
          title = await window.getTitle();
        } catch {
          continue;
        }
        if (titleContains(title, titleSubstring)) {
          let region: WindowRegion = { left: 0, top: 0, width: 0, height: 0 };
          try {
            region = await regionOf(window);
          } catch {
            // Closing as we look. The policy re-reads it after the focus anyway.
          }
          return { title, handle: handleOf(window), region };
        }
      }
      return null;
    },

    async activeWindow(): Promise<WindowRef | null> {
      let window: NutWindow;
      try {
        window = await nut.getActiveWindow();
      } catch {
        return null;
      }
      const handle = handleOf(window);
      // GetForegroundWindow answers NULL while the foreground is changing
      // hands, or on a locked desktop.
      if (!handle) return null;
      let title = '';
      try {
        title = await window.getTitle();
      } catch {
        // A title that cannot be read matches nothing, which is the honest
        // answer to "is the target in front".
      }
      let region: WindowRegion = { left: 0, top: 0, width: 0, height: 0 };
      try {
        region = await regionOf(window);
      } catch {
        // Nothing reads the active window's geometry.
      }
      return { title, handle, region };
    },

    async windowRegion(handle: WindowHandle): Promise<WindowRegion> {
      return regionOf(windowFor(handle));
    },

    async moveWindow(handle: WindowHandle, origin: Point): Promise<void> {
      await windowFor(handle).move(point(origin));
    },

    async resizeWindow(handle: WindowHandle, size: WindowSize): Promise<void> {
      await windowFor(handle).resize(
        new nut.Size(Math.max(1, Math.round(size.width)), Math.max(1, Math.round(size.height))),
      );
    },

    async focusWindowHandle(handle: WindowHandle): Promise<void> {
      await windowFor(handle).focus();
    },

    async restoreWindow(handle: WindowHandle): Promise<void> {
      await runOsWindowCommand('restore', await osTarget(handle));
    },

    async minimiseWindow(handle: WindowHandle): Promise<void> {
      await runOsWindowCommand('minimise', await osTarget(handle));
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
