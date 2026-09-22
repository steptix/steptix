/**
 * The `key` chord grammar (docs/specs/SPEC-use-computer.md §5.4).
 *
 * The last block reads nut.js's own `Key` enum out of `@nut-tree-fork/shared`
 * and checks that every member name `keys.ts` maps to actually exists. That
 * import is safe where a `@nut-tree-fork/nut-js` one would not be: `shared`
 * holds the enums and value objects and carries no native binary, so it loads
 * on a machine with no working libnut — which is most of the ones this suite
 * runs on.
 *
 * It is here because of a failure shape this repo has been bitten by before: a
 * table that mirrors someone else's vocabulary merges cleanly and breaks
 * silently. A nut.js upgrade that renames `LeftSuper` would otherwise turn
 * `win+r` into a `pressKey(undefined)` on a live desktop, minutes into a run.
 */
import { describe, it, expect } from 'vitest';
import { Key } from '@nut-tree-fork/shared';
import {
  KNOWN_KEY_NAMES,
  MODIFIER_NAMES,
  canonicalKeyName,
  chordKeyMembers,
  nutKeyMember,
  parseChord,
} from '../src/desktop/keys.js';

describe('parseChord — the §5.4 grammar', () => {
  it.each([
    'enter', 'escape', 'tab', 'space', 'backspace', 'delete',
    'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
    'f1', 'f5', 'f12',
    'ctrl', 'alt', 'shift', 'win', 'super', 'meta', 'cmd',
    'a', 'z', '0', '9',
  ])('accepts the bare name "%s"', (name) => {
    expect(parseChord(name)).toMatchObject({ key: name, modifiers: [] });
  });

  it.each([
    ['ctrl+s', ['ctrl'], 's'],
    ['alt+f4', ['alt'], 'f4'],
    ['win+r', ['win'], 'r'],
    ['cmd+shift+g', ['cmd', 'shift'], 'g'],
    ['ctrl+alt+delete', ['ctrl', 'alt'], 'delete'],
    ['ctrl+shift+alt+p', ['ctrl', 'shift', 'alt'], 'p'],
  ])('splits "%s" into its modifiers and key', (chord, modifiers, key) => {
    expect(parseChord(chord)).toMatchObject({ modifiers, key });
  });

  it('is case-insensitive and tolerates whitespace around the names', () => {
    expect(parseChord('  Ctrl + Shift + S ')).toMatchObject({
      modifiers: ['ctrl', 'shift'],
      key: 's',
    });
  });

  it('de-duplicates a repeated modifier', () => {
    expect(parseChord('ctrl+ctrl+s').modifiers).toEqual(['ctrl']);
  });

  it.each([
    ['control', 'ctrl'],
    ['command', 'cmd'],
    ['windows', 'win'],
    ['option', 'alt'],
    ['esc', 'escape'],
    ['return', 'enter'],
    ['del', 'delete'],
    ['pgup', 'pageup'],
    ['ArrowDown', 'down'],
    ['Spacebar', 'space'],
  ])('folds the habitual spelling "%s" to "%s"', (spelled, canonical) => {
    expect(canonicalKeyName(spelled)).toBe(canonical);
    expect(parseChord(spelled).key).toBe(canonical);
  });

  it('refuses an unknown name WITH the list of names that work (§5.4)', () => {
    expect(() => parseChord('ctrl+squiggle')).toThrow(/Unknown key name "squiggle"/);
    // The list is the point: a refusal that does not carry it teaches nothing.
    expect(() => parseChord('squiggle')).toThrow(/pageup/);
    expect(() => parseChord('squiggle')).toThrow(/f12/);
  });

  it('refuses a non-modifier in a modifier position, and says which', () => {
    expect(() => parseChord('s+ctrl')).toThrow(
      /"s" is not a modifier, so it cannot come before "ctrl"/,
    );
  });

  it('refuses a malformed chord rather than reading past the empty segment', () => {
    // `ctrl+` would otherwise resolve to a bare `ctrl`, pressing a modifier
    // nobody asked to press on its own.
    expect(() => parseChord('ctrl+')).toThrow(/Malformed chord/);
    expect(() => parseChord('+s')).toThrow(/Malformed chord/);
  });

  it('refuses an empty chord', () => {
    expect(() => parseChord('   ')).toThrow(/needs a key or chord/);
  });

  it('names exactly the seven modifiers §5.4 lists', () => {
    expect([...MODIFIER_NAMES].sort()).toEqual(
      ['alt', 'cmd', 'ctrl', 'meta', 'shift', 'super', 'win'].sort(),
    );
  });
});

describe('chordKeyMembers — modifiers first, key last (§5.8)', () => {
  it('orders a chord for pressKey', () => {
    expect(chordKeyMembers('ctrl+shift+s')).toEqual(['LeftControl', 'LeftShift', 'S']);
  });

  it('maps a bare key to one member', () => {
    expect(chordKeyMembers('enter')).toEqual(['Enter']);
  });

  it('maps the digit row, not the keypad', () => {
    // `ctrl+1` is the number row. `NumPad1` is a different physical key and
    // not what any step means by it.
    expect(chordKeyMembers('ctrl+1')).toEqual(['LeftControl', 'Num1']);
  });
});

describe('the nut.js key table is current', () => {
  it('maps every known name to a member of nut.js\'s Key enum', () => {
    const members = new Set(Object.keys(Key).filter((k) => Number.isNaN(Number(k))));
    for (const name of KNOWN_KEY_NAMES) {
      const member = nutKeyMember(name);
      expect(member, `no nut.js Key member mapped for "${name}"`).toBeDefined();
      expect(members.has(member!), `nut.js has no Key.${member} (for "${name}")`).toBe(true);
    }
  });

  it('resolves each member to a defined enum VALUE, including the zero one', () => {
    // `Key.Escape` is 0. Any lookup written as a truthiness test rather than
    // an `undefined` test drops escape — on a surface whose commonest single
    // action is closing a dialog.
    for (const name of KNOWN_KEY_NAMES) {
      const value = (Key as unknown as Record<string, number | undefined>)[nutKeyMember(name)!];
      expect(value, `Key.${nutKeyMember(name)} is undefined`).not.toBeUndefined();
    }
    expect((Key as unknown as Record<string, number>)['Escape']).toBe(0);
  });

  it('covers every name §5.4 lists', () => {
    const required = [
      'enter', 'escape', 'tab', 'space', 'backspace', 'delete',
      'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
      'ctrl', 'alt', 'shift', 'win', 'super', 'meta', 'cmd',
      ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
      ...'abcdefghijklmnopqrstuvwxyz'.split(''),
      ...'0123456789'.split(''),
    ];
    for (const name of required) {
      expect(KNOWN_KEY_NAMES, `"${name}" is missing from the key table`).toContain(name);
    }
  });
});
