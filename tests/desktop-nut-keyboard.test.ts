/**
 * The nut.js adapter's `key(chord)` — what it hands `pressKey` and
 * `releaseKey`, checked against what libnut then does with it
 * (docs/specs/SPEC-use-computer.md §5.8).
 *
 * Measured live: `key alt+f4` failed with "Invalid key flag specified.", and
 * `ctrl+l` / `win+r` "worked" while leaving the L and R keys held down. Both
 * came from one line that released the chord in reverse order. The fake
 * keyboard here is therefore not a recorder but an EMULATION of libnut's
 * keyboard layer, because the defect lives in how libnut reads the list:
 *
 *  - `pressKey(...keys)` and `releaseKey(...keys)` both reverse the list, take
 *    the first element of the reversed list (the LAST key given) as the key
 *    and the rest as modifiers, and call `keyToggle(key, event, modifiers)`.
 *  - `mapModifierKeys` silently drops any modifier whose libnut name is one
 *    character long (`l`, `r`).
 *  - The native `keyToggle` refuses a modifier flag it does not know with
 *    "Invalid key flag specified.", before sending any key event.
 *
 * The first two are read out of the INSTALLED libnut source below, and the
 * test fails if that source stops saying so — an emulation that drifts from
 * the real library would pass for the wrong reason. The native flag set is
 * the one measured on win32 (libnut-win32 2.7.5, 2026-09-23) by calling
 * `keyToggle` with a bogus direction, which the native code checks after the
 * flags and before the key, so no key event was sent.
 *
 * Nothing here loads nut.js: the package is replaced wholesale by a factory,
 * so this suite runs on a machine with no working native binary, like every
 * other desktop test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Key } from '@nut-tree-fork/shared';
import { MODIFIER_NAMES, chordKeyMembers, nutKeyMember } from '../src/desktop/keys.js';

// ---------------------------------------------------------------------------
// libnut, as read from its own source
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const LIBNUT_KEYBOARD_SOURCE = readFileSync(
  require.resolve('@nut-tree-fork/libnut/dist/lib/libnut-keyboard.class.js'),
  'utf8',
);

/** libnut's `KeyLookupMap`: nut.js `Key` member name → libnut key name. */
const LIBNUT_NAME: ReadonlyMap<string, string | null> = new Map(
  [...LIBNUT_KEYBOARD_SOURCE.matchAll(/\[shared_1\.Key\.(\w+),\s*("(?:[^"\\]|\\.)*"|null)\]/g)].map(
    (m) => [m[1]!, JSON.parse(m[2]!) as string | null],
  ),
);

/** Modifier flag names the native `keyToggle` accepts on win32 (measured). */
const WIN32_NATIVE_FLAGS: ReadonlySet<string> = new Set([
  'alt', 'right_alt', 'control', 'right_control', 'shift', 'right_shift',
  'win', 'right_win', 'meta', 'right_meta', 'fn', 'none',
]);

/** The nut.js `Key` members this repo's chord grammar calls modifiers. */
const MODIFIER_MEMBERS: ReadonlySet<string> = new Set(
  [...MODIFIER_NAMES].map((name) => nutKeyMember(name)!),
);

const memberName = (value: number): string => (Key as unknown as Record<number, string>)[value]!;

/** One native `keyToggle` call, as libnut would make it. */
interface Toggle {
  event: 'down' | 'up';
  /** The key libnut toggles, as a nut.js member name. */
  key: string;
  /** What libnut treated as modifiers, as member names, BEFORE its filter. */
  modifiers: string[];
  /** The modifier flags that reached the native call, after the filter. */
  flags: string[];
}

class LibnutKeyboardEmulation {
  readonly toggles: Toggle[] = [];
  /** Physical keys down right now, by libnut name. */
  readonly held = new Set<string>();

  /** `KeyboardAction.pressKey` / `releaseKey`, then the native `keyToggle`. */
  toggle(keys: number[], event: 'down' | 'up'): void {
    const [key, ...modifiers] = [...keys].reverse();
    const nativeKey = LIBNUT_NAME.get(memberName(key!)) ?? null;
    // `mapModifierKeys`: look up, drop nulls and one-character names.
    const flags = modifiers
      .map((m) => LIBNUT_NAME.get(memberName(m)) ?? null)
      .filter((name): name is string => name != null && name.length > 1);
    // The native flag check comes before any key event is sent.
    for (const flag of flags) {
      if (!WIN32_NATIVE_FLAGS.has(flag)) throw new Error('Invalid key flag specified.');
    }
    this.toggles.push({
      event,
      key: memberName(key!),
      modifiers: modifiers.map(memberName),
      flags,
    });
    if (nativeKey == null) return;
    for (const name of [...flags, nativeKey]) {
      if (event === 'down') this.held.add(name);
      else this.held.delete(name);
    }
  }
}

// ---------------------------------------------------------------------------
// The nut.js module the adapter loads
// ---------------------------------------------------------------------------

const nut = vi.hoisted(() => {
  const state = {
    emulation: null as null | { toggle(keys: number[], event: 'down' | 'up'): void },
  };
  return {
    state,
    pressKey: vi.fn(async (...keys: number[]) => state.emulation!.toggle(keys, 'down')),
    releaseKey: vi.fn(async (...keys: number[]) => state.emulation!.toggle(keys, 'up')),
  };
});

vi.mock('@nut-tree-fork/nut-js', async () => {
  const shared = await import('@nut-tree-fork/shared');
  const module = {
    Key: shared.Key,
    Button: { LEFT: 0, MIDDLE: 1, RIGHT: 2 },
    Point: class { constructor(public x: number, public y: number) {} },
    Size: class { constructor(public width: number, public height: number) {} },
    Window: class {},
    providerRegistry: {},
    mouse: { config: { autoDelayMs: 0 } },
    keyboard: {
      config: { autoDelayMs: 0 },
      pressKey: (...keys: number[]) => nut.pressKey(...keys),
      releaseKey: (...keys: number[]) => nut.releaseKey(...keys),
    },
    screen: {},
    getWindows: async () => [],
    getActiveWindow: async () => {
      throw new Error('not in this test');
    },
  };
  return { ...module, default: module };
});

import { loadNutAdapter, resetNutAdapter } from '../src/desktop/nut-adapter.js';

let emulation: LibnutKeyboardEmulation;

beforeEach(() => {
  resetNutAdapter();
  emulation = new LibnutKeyboardEmulation();
  nut.state.emulation = emulation;
  nut.pressKey.mockClear();
  nut.releaseKey.mockClear();
});

const members = (chord: string): string[] => chordKeyMembers(chord);
const values = (chord: string): number[] =>
  members(chord).map((m) => (Key as unknown as Record<string, number>)[m]!);

// ---------------------------------------------------------------------------

describe('the emulation is libnut as installed', () => {
  it('pressKey and releaseKey both reverse the list and split it into key + modifiers', () => {
    for (const method of ['pressKey', 'releaseKey']) {
      const body = LIBNUT_KEYBOARD_SOURCE.match(
        new RegExp(`${method}\\(\\.\\.\\.keys\\) \\{[\\s\\S]*?\\n    \\}`),
      )?.[0];
      expect(body, `libnut has no ${method}(...keys)`).toBeDefined();
      expect(body).toMatch(/keys\.reverse\(\);\s*const \[key, \.\.\.modifiers\] = keys;/);
    }
  });

  it('drops a modifier whose libnut name is one character long', () => {
    expect(LIBNUT_KEYBOARD_SOURCE).toMatch(
      /\.filter\(\(modifierKey\) => modifierKey != null && modifierKey\.length > 1\)/,
    );
  });

  it('knows libnut\'s name for every member the chord grammar presses', () => {
    for (const chord of ['alt+f4', 'ctrl+l', 'ctrl+shift+s', 'enter', 'win+r', 'meta+super+a']) {
      for (const member of members(chord)) expect(LIBNUT_NAME.get(member), member).toBeTruthy();
    }
  });

  it('reproduces the live failure when a chord is released in reverse', () => {
    // The old `releaseKey(...[...keys].reverse())`, fed straight to the
    // emulation: the two symptoms measured live, and nothing else.
    emulation.toggle(values('alt+f4'), 'down');
    expect(() => emulation.toggle([...values('alt+f4')].reverse(), 'up')).toThrow(
      'Invalid key flag specified.',
    );

    const ctrlL = new LibnutKeyboardEmulation();
    ctrlL.toggle(values('ctrl+l'), 'down');
    ctrlL.toggle([...values('ctrl+l')].reverse(), 'up');
    expect([...ctrlL.held]).toEqual(['l']);
  });
});

describe('key(chord) — pressKey and releaseKey get the same list (§5.8)', () => {
  const chords = ['alt+f4', 'ctrl+l', 'ctrl+shift+s', 'enter', 'shift', 'win+r', 'ctrl+shift'];

  it.each(chords)('"%s": one press, one release, identical arguments in identical order', async (chord) => {
    const adapter = await loadNutAdapter();
    await adapter.key(chord);

    expect(nut.pressKey).toHaveBeenCalledTimes(1);
    expect(nut.releaseKey).toHaveBeenCalledTimes(1);
    expect(nut.pressKey.mock.calls[0]).toEqual(values(chord));
    expect(nut.releaseKey.mock.calls[0]).toEqual(nut.pressKey.mock.calls[0]);
  });

  it.each(chords)('"%s": libnut never receives a non-modifier as a modifier', async (chord) => {
    const adapter = await loadNutAdapter();
    await adapter.key(chord);

    const expected = members(chord);
    expect(emulation.toggles.map((t) => t.event)).toEqual(['down', 'up']);
    for (const toggle of emulation.toggles) {
      // The key libnut toggles is the chord's own last key, both ways…
      expect(toggle.key).toBe(expected[expected.length - 1]);
      // …and everything it treats as a modifier is one, so nothing is either
      // refused by the native flag check or silently filtered out.
      for (const modifier of toggle.modifiers) expect(MODIFIER_MEMBERS).toContain(modifier);
      expect(toggle.flags).toHaveLength(toggle.modifiers.length);
    }
  });

  it.each(chords)('"%s": nothing is left held down afterwards', async (chord) => {
    const adapter = await loadNutAdapter();
    await adapter.key(chord);
    expect([...emulation.held]).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'cmd+shift+g on win32 presses the Windows key, which libnut accepts as a flag there',
    async () => {
      const adapter = await loadNutAdapter();
      await adapter.key('cmd+shift+g');

      const win = (Key as unknown as Record<string, number>)['LeftWin']!;
      expect(nut.pressKey.mock.calls[0]![0]).toBe(win);
      expect(nut.releaseKey.mock.calls[0]).toEqual(nut.pressKey.mock.calls[0]);
      expect([...emulation.held]).toEqual([]);
    },
  );

  it('refuses an unknown name before pressing anything', async () => {
    const adapter = await loadNutAdapter();
    await expect(adapter.key('ctrl+hyper')).rejects.toThrow(/Unknown key name "hyper"/);
    expect(nut.pressKey).not.toHaveBeenCalled();
    expect(nut.releaseKey).not.toHaveBeenCalled();
  });
});
