/**
 * The `key` action's chord grammar (docs/specs/SPEC-use-computer.md §5.4).
 *
 * xdotool-style: lower-case names joined with `+`, modifiers first and the
 * key last — `enter`, `escape`, `ctrl+s`, `alt+f4`, `win+r`, `cmd+shift+g`,
 * `f5`. An unknown name is REFUSED with the list of known ones, at parse time
 * (so the model can fix it on its next turn) and again in the adapter (so a
 * caller that skipped the parser cannot press something it did not name).
 *
 * Nothing here imports nut.js. The table maps a chord name to the NAME of a
 * member of nut.js's `Key` enum, as a plain string, and `nut-adapter.ts` — the
 * one file that holds the enum — looks it up. That keeps this whole grammar
 * unit-testable on a machine with no prebuilt native binary, which is the same
 * reason the adapter is loaded lazily at all (§5.1 item 2).
 */

/** A chord split into its modifiers and the single key they qualify. */
export interface ParsedChord {
  /** Canonical modifier names, in the order given, de-duplicated. */
  modifiers: string[];
  /** The canonical name of the key being pressed. May itself be a modifier
   *  name, for a chord that is one bare modifier (`shift`). */
  key: string;
  /** The chord as it was written, for messages. */
  raw: string;
}

/**
 * Canonical name → nut.js `Key` member name.
 *
 * The right-hand side is verified against `@nut-tree-fork/shared`'s `Key`
 * enum by `tests/desktop-keys.test.ts`, so a nut.js upgrade that renames a
 * member fails a unit test instead of failing a live click.
 */
const KEY_MEMBERS: Readonly<Record<string, string>> = {
  // Modifiers. libnut's own table maps LeftControl→"control", LeftAlt→"alt",
  // LeftShift→"shift", LeftWin→"win", LeftCmd→"cmd", and BOTH LeftSuper and
  // LeftMeta→"meta"; `win`, `super` and `meta` therefore differ in spelling
  // and not in effect on Windows, which is what §5.4 promises.
  ctrl: 'LeftControl',
  alt: 'LeftAlt',
  shift: 'LeftShift',
  win: 'LeftWin',
  super: 'LeftSuper',
  meta: 'LeftMeta',
  // macOS command (§11). On Windows `chordKeyMembers` swaps it for LeftWin:
  // libnut refuses "cmd" as a modifier flag there (measured), so without the
  // swap `cmd+s` threw rather than doing the defensible thing.
  cmd: 'LeftCmd',

  // Named keys.
  // `Key.Enter` and `Key.Return` are separate members of the enum and separate
  // names in libnut ("enter" / "return"). One spelling is enough for a chord
  // grammar, and `Enter` is the one every platform agrees on, so `return` is
  // an alias of `enter` below rather than a second key with its own behaviour.
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',

  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
  f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',

  a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G', h: 'H', i: 'I',
  j: 'J', k: 'K', l: 'L', m: 'M', n: 'N', o: 'O', p: 'P', q: 'Q', r: 'R',
  s: 'S', t: 'T', u: 'U', v: 'V', w: 'W', x: 'X', y: 'Y', z: 'Z',

  // The digit row. nut.js spells these `Num0`–`Num9`; `NumPad0`–`NumPad9` are
  // the keypad, which is a different physical key and not what `ctrl+1` means.
  '0': 'Num0', '1': 'Num1', '2': 'Num2', '3': 'Num3', '4': 'Num4',
  '5': 'Num5', '6': 'Num6', '7': 'Num7', '8': 'Num8', '9': 'Num9',
};

/**
 * Spellings that mean a canonical name.
 *
 * Every one of these is a name a model reaches for by habit rather than a
 * distinct key: `Control` and `ArrowDown` are the DOM spellings, `esc` and
 * `pgup` the keyboard-legend ones, `option` the Mac name for alt. Accepting
 * them costs a table entry; refusing them costs a model turn and teaches
 * nothing, because there is no second thing any of them could have meant.
 */
const ALIASES: Readonly<Record<string, string>> = {
  control: 'ctrl',
  command: 'cmd',
  windows: 'win',
  option: 'alt',
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  spacebar: 'space',
  pgup: 'pageup',
  pgdn: 'pagedown',
  page_up: 'pageup',
  page_down: 'pagedown',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};

/** The names that may appear before the final segment of a chord. */
export const MODIFIER_NAMES: ReadonlySet<string> = new Set([
  'ctrl', 'alt', 'shift', 'win', 'super', 'meta', 'cmd',
]);

/** Every canonical name, sorted for a stable refusal message. */
export const KNOWN_KEY_NAMES: readonly string[] = Object.keys(KEY_MEMBERS).sort();

/** The nut.js `Key` member name for a canonical key name, or undefined. */
export function nutKeyMember(name: string): string | undefined {
  return KEY_MEMBERS[name];
}

/** Fold one segment to its canonical name: trimmed, lower-cased, de-aliased. */
export function canonicalKeyName(segment: string): string {
  const folded = segment.trim().toLowerCase();
  return ALIASES[folded] ?? folded;
}

/** The §5.4 refusal: the offending name, and every name that would work. */
export function unknownKeyNameError(name: string, chord: string): Error {
  return new Error(
    `Unknown key name "${name}" in chord "${chord}". Known names: ${KNOWN_KEY_NAMES.join(', ')}`,
  );
}

/**
 * Split a chord into modifiers + key, refusing anything the adapter could not
 * press. Throws; callers that want a message rather than an exception catch it
 * (the action parser does, and turns it into a refusal the model reads).
 */
export function parseChord(chord: string): ParsedChord {
  if (typeof chord !== 'string' || chord.trim() === '') {
    throw new Error('A "key" action needs a key or chord, e.g. "enter" or "ctrl+s"');
  }
  const raw = chord.trim();
  const segments = raw.split('+').map((s) => s.trim());

  // `ctrl+` and `+s` are typos with no defensible reading — a chord with an
  // empty segment would otherwise resolve to a bare modifier or a lone key and
  // press something the author did not write.
  if (segments.some((s) => s === '')) {
    throw new Error(`Malformed chord "${raw}" — join names with "+", e.g. "ctrl+shift+s"`);
  }

  const names = segments.map(canonicalKeyName);
  for (const name of names) {
    if (KEY_MEMBERS[name] === undefined) throw unknownKeyNameError(name, raw);
  }

  const key = names[names.length - 1]!;
  const leading = names.slice(0, -1);
  for (const name of leading) {
    if (!MODIFIER_NAMES.has(name)) {
      throw new Error(
        `"${name}" is not a modifier, so it cannot come before "${key}" in chord "${raw}". ` +
          `Modifiers: ${[...MODIFIER_NAMES].join(', ')}`,
      );
    }
  }

  const modifiers: string[] = [];
  for (const name of leading) if (!modifiers.includes(name)) modifiers.push(name);
  return { modifiers, key, raw };
}

/**
 * Members swapped for another on one platform, because libnut will not take
 * the original as a MODIFIER there.
 *
 * libnut hands every key of a chord but the last to its native `keyToggle` as
 * a modifier flag, and the flag names it accepts are a smaller set than its
 * key names. Measured on win32 (2026-09-23, libnut-win32 2.7.5, by calling
 * `keyToggle` with a bogus direction so no key event could be sent): `cmd`,
 * `right_cmd` and `command` are refused with "Invalid key flag specified.",
 * while `win`, `right_win`, `meta` and `right_meta` are accepted. So on
 * Windows `cmd+shift+g` threw before anything was pressed. `LeftWin` is the
 * key this table already promised `cmd` would mean there. macOS and Linux are
 * NOT measured and get no swap.
 */
const PLATFORM_MEMBER_SWAPS: Partial<Record<NodeJS.Platform, Readonly<Record<string, string>>>> = {
  win32: { LeftCmd: 'LeftWin' },
};

/**
 * The nut.js `Key` member names a chord presses, modifiers first and the key
 * last. That is the order nut.js wants for BOTH `pressKey(...)` and
 * `releaseKey(...)` (§5.8) — libnut reverses the list itself and treats the
 * final element as the key and the rest as modifier flags.
 *
 * `platform` selects {@link PLATFORM_MEMBER_SWAPS}; it defaults to the running
 * one and is a parameter so the swap can be tested from any machine.
 */
export function chordKeyMembers(
  chord: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const parsed = parseChord(chord);
  const swaps = PLATFORM_MEMBER_SWAPS[platform] ?? {};
  return [...parsed.modifiers, parsed.key].map((name) => {
    const member = nutKeyMember(name);
    if (member === undefined) throw unknownKeyNameError(name, parsed.raw);
    return swaps[member] ?? member;
  });
}
