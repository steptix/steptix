/**
 * The adapter seam: the two §5.1 failure messages, the rule that keeps nut.js
 * out of every other file, and the fake the rest of the suite drives
 * (docs/specs/SPEC-use-computer.md §5.1, §5.8).
 *
 * Nothing here loads nut.js. That is not caution about speed — it is the
 * property under test. §5.1 item 2 requires that a machine with no working
 * prebuilt binary still runs every browser test, and the only way that stays
 * true is if the import lives inside a lazily-called factory in exactly one
 * file. The middle block asserts that by reading the source, because it is the
 * kind of rule a later refactor breaks silently: hoisting the import to the
 * top of `nut-adapter.ts` changes nothing that any other test can see, and
 * turns every browser test on a binary-less machine red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The per-OS window helpers shell out; nothing in this file may. Hoisted so the
// mock is in place before nut-adapter.ts imports `node:child_process`.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import {
  captureFailureMessage,
  loadNutAdapter,
  NUT_PACKAGE,
  nutLoadFailureMessage,
  OS_WINDOW_HELPER_TIMEOUT_MS,
  osWindowCommand,
  resetNutAdapter,
  runOsWindowCommand,
  serverPackageRoot,
} from '../src/desktop/nut-adapter.js';
import {
  clipToDisplay,
  FakeDesktopAdapter,
  fakeWindow,
  makeFakeGrab,
} from '../src/desktop/fake-adapter.js';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/desktop');

describe('nutLoadFailureMessage — §5.1 item 2', () => {
  it('names the package and the platform', () => {
    const message = nutLoadFailureMessage(new Error('libnut.node is not a valid Win32 app'), 'win32');
    expect(message).toContain(NUT_PACKAGE);
    expect(message).toContain('win32');
    expect(message).toContain('libnut.node is not a valid Win32 app');
  });

  it('adds the two macOS permissions on darwin', () => {
    const message = nutLoadFailureMessage(new Error('boom'), 'darwin');
    expect(message).toContain('Screen Recording');
    expect(message).toContain('Accessibility');
  });

  it('does not mention macOS permissions anywhere else', () => {
    expect(nutLoadFailureMessage(new Error('boom'), 'linux')).not.toContain('Screen Recording');
  });
});

/** An error shaped the way Node's module loader throws one. */
function notFound(code: 'ERR_MODULE_NOT_FOUND' | 'MODULE_NOT_FOUND', message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('nutLoadFailureMessage — a package that is not installed says where to install it', () => {
  // The case a checkout that predates computer mode hits: the dependency is in
  // package.json and nobody has run `npm install` there since. The text is
  // what Node 22 prints for a dynamic import of an absent package.
  const absent = notFound(
    'ERR_MODULE_NOT_FOUND',
    "Cannot find package '@nut-tree-fork/nut-js' imported from C:\\repo\\dist\\desktop\\nut-adapter.js",
  );

  it('names the package as not installed and the directory to run npm install in', () => {
    const message = nutLoadFailureMessage(absent, 'win32', 'C:\\repo');
    expect(message).toContain(`${NUT_PACKAGE} is not installed`);
    expect(message).toContain('Run `npm install` in C:\\repo');
    expect(message).toContain('restart the server');
    // The loader's own words stay underneath, as for every other failure.
    expect(message).toContain("Cannot find package '@nut-tree-fork/nut-js'");
    // Not the prebuilt-binary diagnosis — that would send someone hunting for
    // a native build problem that is not there.
    expect(message).not.toContain('prebuilt native binary');
  });

  it('names a missing dependency of nut.js by its own name', () => {
    const message = nutLoadFailureMessage(
      notFound('MODULE_NOT_FOUND', "Cannot find module '@nut-tree-fork/libnut-win32'\nRequire stack: …"),
      'win32',
      '/srv/steptix',
    );
    expect(message).toContain('a package it needs (@nut-tree-fork/libnut-win32) is not');
    expect(message).toContain('Run `npm install` in /srv/steptix');
  });

  it('keeps the prebuilt-binary message for every other load failure', () => {
    const message = nutLoadFailureMessage(
      new Error('libnut.node is not a valid Win32 application'),
      'win32',
      'C:\\repo',
    );
    expect(message).toContain('prebuilt native binary');
    expect(message).not.toContain('npm install');
  });

  it('defaults the directory to the package root this module lives under', () => {
    // The worktree (or checkout) holding this test — the directory whose
    // package.json names the dependency, which is where the install has to run.
    const root = serverPackageRoot();
    expect(existsSync(path.join(root, 'package.json'))).toBe(true);
    expect(root).toBe(path.resolve(desktopDir, '..', '..'));
  });

  it('loadNutAdapter throws it when the import itself fails with module-not-found', async () => {
    // The injected import rejects the way Node's does; the real package is
    // never loaded by this file (see the lazy-import block below).
    resetNutAdapter();
    const load = loadNutAdapter(async () => {
      throw absent;
    });
    await expect(load).rejects.toThrow(`${NUT_PACKAGE} is not installed`);
    await expect(load).rejects.toThrow(`Run \`npm install\` in ${serverPackageRoot()}`);
    // A rejection is not cached: the next call tries the import again.
    const again = vi.fn(async () => {
      throw new Error('still broken');
    });
    await expect(loadNutAdapter(again)).rejects.toThrow('prebuilt native binary');
    expect(again).toHaveBeenCalledTimes(1);
    resetNutAdapter();
  });
});

describe('captureFailureMessage — §5.1 item 4', () => {
  it('names the measured Windows cause', () => {
    // The whole point of this message: the symptom (a capture that fails
    // while window enumeration works) has a specific cause that nobody
    // guesses, and a fix that is one sentence long.
    const message = captureFailureMessage(new Error('Failed to capture screen'), 'win32');
    expect(message).toContain('BitBlt error 6');
    expect(message).toContain("window station's read-screen right");
    expect(message).toContain('start the server from a normal terminal or from VS Code');
  });

  it('names Screen Recording on macOS', () => {
    expect(captureFailureMessage(new Error('x'), 'darwin')).toContain('Screen Recording');
  });

  it('names X11 and Wayland on Linux', () => {
    const message = captureFailureMessage(new Error('x'), 'linux');
    expect(message).toContain('X11');
    expect(message).toContain('Wayland');
  });

  it('always carries the underlying error', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(captureFailureMessage(new Error('the real cause'), platform)).toContain(
        'the real cause',
      );
    }
  });
});

describe('nut.js has exactly one importer, and imports lazily (§5.1 item 2, §5.8)', () => {
  const files = readdirSync(desktopDir).filter((f) => f.endsWith('.ts'));

  /** A module specifier for any `@nut-tree-fork/*` package — `from '…'` or
   *  `import('…')`. Prose that merely NAMES the package (this repo's comments
   *  do, often) is not an import and is not what the rule is about. */
  const SPECIFIER = /(?:from|import\s*\()\s*['"]@nut-tree-fork\/[^'"]+['"]/;

  it('no file under src/desktop/ but nut-adapter.ts imports the package', () => {
    const offenders = files.filter(
      (file) =>
        file !== 'nut-adapter.ts' &&
        SPECIFIER.test(readFileSync(path.join(desktopDir, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('nut-adapter.ts imports it only through a dynamic import', () => {
    const source = readFileSync(path.join(desktopDir, 'nut-adapter.ts'), 'utf8');
    // A `typeof import(...)` in a type position is fine — it is erased.
    const statik = source
      .split('\n')
      .filter((line) => /^\s*import\s[^(]*['"]@nut-tree-fork\/nut-js['"]/.test(line));
    expect(statik).toEqual([]);
    expect(source).toMatch(/await import\('@nut-tree-fork\/nut-js'\)/);
  });

  it('the barrel re-exports no nut.js VALUE', () => {
    // Importing `src/desktop/index.js` must never be what pulls the native
    // binary in. Types are erased; a value export would not be.
    const source = readFileSync(path.join(desktopDir, 'index.ts'), 'utf8');
    expect(source).not.toMatch(/^export \{[^}]*\} from '\.\/nut-adapter\.js';/m);
  });
});

describe('FakeDesktopAdapter', () => {
  // Its call recorder and its grab buffer are not tested here: every suite
  // that asserts `callsOf(...)` fails if the recorder does, and
  // `viewFromGrab` refuses a buffer of the wrong length. What stays is what
  // the policy tests rely on the fake to model.
  it('makes two grabs byte-identical, or different, on demand', async () => {
    // Both are needed: the stall detector's whole question is whether two
    // captures are the same pixels.
    expect(makeFakeGrab({ width: 4, height: 2 }).rgba).toEqual(
      makeFakeGrab({ width: 4, height: 2 }).rgba,
    );
    expect(makeFakeGrab({ width: 4, height: 2, seed: 1 }).rgba).not.toEqual(
      makeFakeGrab({ width: 4, height: 2 }).rgba,
    );
  });

  it('reports a logical screen size from the density', async () => {
    const adapter = new FakeDesktopAdapter({ width: 800, height: 600, scaleX: 2, scaleY: 2 });
    expect(await adapter.screenSize()).toEqual({ width: 400, height: 300 });
  });

  it('walks a window sequence, one step per windows() call', async () => {
    const adapter = new FakeDesktopAdapter({
      windowsSequence: [[], [fakeWindow('Print')]],
    });
    expect(await adapter.windows()).toEqual([]);
    expect(await adapter.windows()).toEqual([fakeWindow('Print')]);
    // The last entry repeats, so a poll that outlives the sequence sees a
    // steady state rather than falling off the end.
    expect(await adapter.windows()).toEqual([fakeWindow('Print')]);
  });

  it('finds a window by substring, case-insensitively, with a handle', async () => {
    const adapter = new FakeDesktopAdapter({ windows: [fakeWindow('Confirm Save As')] });
    const found = await adapter.findWindow('SAVE as');
    expect(found).toMatchObject({ title: 'Confirm Save As' });
    expect(typeof found!.handle).toBe('number');
    expect(await adapter.findWindow('Print')).toBeNull();
    expect(adapter.callsOf('findWindow').map((c) => c.args['found'])).toEqual([found!.handle, null]);
  });
});

describe('FakeDesktopAdapter — a window manager with nut.js\'s clipped geometry (§14)', () => {
  const DISPLAY = { width: 3440, height: 1440 };

  it('clips exactly as measured on the real display', () => {
    // §14 "focus_window: measured Win32 behaviour": one WinForms window on a
    // 3440×1440 display, moved and resized, read back through nut.js
    // `getRegion()`. The rows imply an OUTER size of 2534×1399 (e.g. at
    // -2000 it shows 534 wide), which is what the rect here is.
    const size = { width: 2534, height: 1399 };
    const at = (left: number, top: number, s = size) => clipToDisplay({ left, top, ...s }, DISPLAY);
    expect(at(3000, 200)).toEqual({ left: 3000, top: 200, width: 440, height: 1240 });
    expect(at(3400, 200)).toEqual({ left: 3400, top: 200, width: 40, height: 1240 });
    expect(at(-300, 200)).toEqual({ left: 0, top: 200, width: 2234, height: 1240 });
    expect(at(-2000, 200)).toEqual({ left: 0, top: 200, width: 534, height: 1240 });
    expect(at(300, 1300)).toEqual({ left: 300, top: 1300, width: 2534, height: 140 });
    expect(at(300, -200)).toEqual({ left: 300, top: 0, width: 2534, height: 1199 });
    expect(at(300, 200, { width: 5000, height: 2000 })).toEqual({
      left: 300,
      top: 200,
      width: 3140,
      height: 1240,
    });
    expect(at(300, 200, { width: 640, height: 400 })).toEqual({
      left: 300,
      top: 200,
      width: 640,
      height: 400,
    });
  });

  it('keeps the origin of a window wholly on a monitor to the right, at 0 wide', () => {
    expect(clipToDisplay({ left: 4000, top: 200, width: 800, height: 600 }, DISPLAY)).toEqual({
      left: 4000,
      top: 200,
      width: 0,
      height: 600,
    });
  });

  it('reads a minimised window as (0,0 0×0), in the list and by handle', async () => {
    const adapter = new FakeDesktopAdapter({
      windows: [{ title: 'statement.pdf', region: { left: 300, top: 200, width: 800, height: 600 }, minimised: true }],
    });
    const found = await adapter.findWindow('statement');
    const empty = { left: 0, top: 0, width: 0, height: 0 };
    expect(found!.region).toEqual(empty);
    expect(await adapter.windowRegion(found!.handle)).toEqual(empty);
    expect((await adapter.windows())[0]!.region).toEqual(empty);
  });

  it('a focus restores a minimised window and activates it', async () => {
    const adapter = new FakeDesktopAdapter({
      windows: [
        { title: 'statement.pdf', region: { left: 300, top: 200, width: 800, height: 600 }, minimised: true },
        fakeWindow('Claude'),
      ],
      activeTitle: 'Claude',
    });
    const { handle } = (await adapter.findWindow('statement'))!;
    await adapter.focusWindowHandle(handle);
    expect(adapter.windowState('statement')!.minimised).toBe(false);
    expect((await adapter.activeWindow())!.title).toBe('statement.pdf');
  });

  it('a refused focus still restores, and leaves the front window where it was', async () => {
    // Measured once on Windows: the window came back while "Claude" stayed
    // in front.
    const adapter = new FakeDesktopAdapter({
      windows: [
        { title: 'statement.pdf', region: { left: 300, top: 200, width: 800, height: 600 }, minimised: true },
        fakeWindow('Claude'),
      ],
      activeTitle: 'Claude',
      refuseForeground: 1,
    });
    const { handle } = (await adapter.findWindow('statement'))!;
    await adapter.focusWindowHandle(handle);
    expect(adapter.windowState('statement')!.minimised).toBe(false);
    expect((await adapter.activeWindow())!.title).toBe('Claude');
    // One refusal only: the next focus lands.
    await adapter.focusWindowHandle(handle);
    expect((await adapter.activeWindow())!.title).toBe('statement.pdf');
  });

  it('moves and resizes the TRUE rect, and reports it clipped', async () => {
    const adapter = new FakeDesktopAdapter({
      windows: [{ title: 'Far', region: { left: 4000, top: 100, width: 5000, height: 2000 } }],
    });
    const { handle } = (await adapter.findWindow('far'))!;
    await adapter.moveWindow(handle, { x: 40, y: 40 });
    expect(await adapter.windowRegion(handle)).toEqual({ left: 40, top: 40, width: 3400, height: 1400 });
    await adapter.resizeWindow(handle, { width: 3360, height: 1360 });
    expect(adapter.windowState('far')!.region).toEqual({ left: 40, top: 40, width: 3360, height: 1360 });
  });
});

describe('per-OS minimise/restore helpers — libnut has neither (§5.8)', () => {
  const HWND = 11799974;

  beforeEach(() => {
    execFileMock.mockReset();
  });

  /** Make the mocked `execFile` answer like the real one's callback. */
  function execAnswers(error: Error | null, stdout = '', stderr = ''): void {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: (e: unknown, o: string, s: string) => void) => {
        cb(error, stdout, stderr);
      },
    );
  }

  it('builds the measured PowerShell ShowWindow command for a handle on win32', () => {
    // The helper measured on Windows 11 (§14), byte for byte: SW_RESTORE = 9.
    expect(osWindowCommand('restore', { handle: HWND }, 'win32')).toMatchObject({
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static ` +
          `extern bool ShowWindow(System.IntPtr h, int c);'; [void][W.U]::ShowWindow([System.IntPtr]11799974, 9)`,
      ],
    });
    // SW_MINIMIZE = 6.
    expect(osWindowCommand('minimise', { handle: HWND }, 'win32').args[3]).toMatch(
      /ShowWindow\(\[System\.IntPtr\]11799974, 6\)$/,
    );
  });

  it('runs it through execFile, no shell, with a 5 s budget and no console window', async () => {
    execAnswers(null);
    await runOsWindowCommand('minimise', { handle: HWND }, 'win32');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileMock.mock.calls[0]!;
    expect(file).toBe('powershell.exe');
    expect(args).toEqual(osWindowCommand('minimise', { handle: HWND }, 'win32').args);
    expect(options).toEqual({ timeout: OS_WINDOW_HELPER_TIMEOUT_MS, windowsHide: true });
    expect(OS_WINDOW_HELPER_TIMEOUT_MS).toBe(5000);
  });

  it('refuses anything but a positive integer handle — the handle becomes code', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => osWindowCommand('restore', { handle: bad }, 'win32')).toThrow(/not a window handle/);
    }
  });

  it('uses xdotool on Linux, and says so clearly when it is missing', async () => {
    expect(osWindowCommand('restore', { handle: 41943047 }, 'linux')).toMatchObject({
      file: 'xdotool',
      args: ['windowactivate', '41943047'],
    });
    expect(osWindowCommand('minimise', { handle: 41943047 }, 'linux').args).toEqual([
      'windowminimize',
      '41943047',
    ]);
    execAnswers(Object.assign(new Error('spawn xdotool ENOENT'), { code: 'ENOENT' }));
    await expect(runOsWindowCommand('restore', { handle: 41943047 }, 'linux')).rejects.toThrow(
      /restoring a window needs xdotool on linux, and it was not found — install it .*apt install xdotool.*libnut has no minimise or restore/,
    );
  });

  it('uses osascript on macOS with the title as an ARGUMENT, and names it when missing', async () => {
    const command = osWindowCommand('restore', { handle: 77, title: 'a "quoted" title' }, 'darwin');
    expect(command.file).toBe('osascript');
    // Never spliced into the script, so no title can break out of a literal.
    expect(command.args[command.args.length - 1]).toBe('a "quoted" title');
    expect(command.args[1]).not.toContain('quoted');
    expect(command.args[1]).toContain('AXMinimized');
    expect(() => osWindowCommand('restore', { handle: 77 }, 'darwin')).toThrow(/without its title/);

    execAnswers(Object.assign(new Error('spawn osascript ENOENT'), { code: 'ENOENT' }));
    await expect(
      runOsWindowCommand('minimise', { handle: 77, title: 'x' }, 'darwin'),
    ).rejects.toThrow(/minimising a window needs osascript on darwin, and it was not found/);
  });

  it('says so when the helper times out, and carries stderr when it fails', async () => {
    execAnswers(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }));
    await expect(runOsWindowCommand('restore', { handle: HWND }, 'win32')).rejects.toThrow(
      /did not finish within 5000 ms/,
    );
    execAnswers(Object.assign(new Error('Command failed'), { code: 1 }), '', 'Add-Type: boom');
    await expect(runOsWindowCommand('restore', { handle: HWND }, 'win32')).rejects.toThrow(
      /restoring a window with powershell\.exe failed: Command failed — Add-Type: boom/,
    );
  });
});
