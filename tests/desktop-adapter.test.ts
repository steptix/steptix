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
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureFailureMessage, NUT_PACKAGE, nutLoadFailureMessage } from '../src/desktop/nut-adapter.js';
import { FakeDesktopAdapter, fakeWindow, makeFakeGrab } from '../src/desktop/fake-adapter.js';

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
  it('records every call with its arguments, in order', async () => {
    const adapter = new FakeDesktopAdapter({ width: 8, height: 4 });
    await adapter.move({ x: 1, y: 2 });
    await adapter.click({ x: 3, y: 4 }, { button: 'right', count: 2 });
    await adapter.type('hi');
    await adapter.key('ctrl+s');
    await adapter.scroll({ x: 5, y: 6 }, 'down', 3);
    await adapter.drag({ x: 0, y: 0 }, { x: 9, y: 9 });

    expect(adapter.calls.map((c) => c.name)).toEqual([
      'move', 'click', 'type', 'key', 'scroll', 'drag',
    ]);
    expect(adapter.callsOf('click')[0]!.args).toEqual({
      point: { x: 3, y: 4 },
      button: 'right',
      count: 2,
    });
  });

  it('grabs a buffer of exactly width × height × 4 bytes', async () => {
    const grab = await new FakeDesktopAdapter({ width: 8, height: 4 }).grab();
    expect(grab.rgba).toHaveLength(8 * 4 * 4);
    expect({ width: grab.width, height: grab.height }).toEqual({ width: 8, height: 4 });
  });

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

  it('answers focusWindow by substring, case-insensitively, and records it', async () => {
    const adapter = new FakeDesktopAdapter({ windows: [fakeWindow('Confirm Save As')] });
    expect(await adapter.focusWindow('SAVE as')).toBe(true);
    expect(await adapter.focusWindow('Print')).toBe(false);
    expect(adapter.callsOf('focusWindow').map((c) => c.args['found'])).toEqual([true, false]);
  });

  it('can be made to fail a grab, for §5.1 item 4', async () => {
    const adapter = new FakeDesktopAdapter({ grabError: new Error('Failed to capture screen') });
    await expect(adapter.grab()).rejects.toThrow('Failed to capture screen');
  });
});
