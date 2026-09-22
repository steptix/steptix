/**
 * Computer-mode stall detection
 * (docs/specs/SPEC-use-computer.md §5.5: "three consecutive turns whose
 * captures are pixel-identical AND whose actions were identical is a stall").
 *
 * Both halves of the AND are tested separately, because either alone is
 * NORMAL. A screen that has not changed while the model tries something new is
 * a model working through a menu; the same action against a changing screen is
 * a scroll. Only the conjunction means nothing is happening.
 */
import { describe, it, expect } from 'vitest';
import {
  COMPUTER_STALL_TURNS,
  ComputerStallDetector,
  computerStallMessage,
  fingerprintActions,
} from '../src/desktop/stall.js';
import type { ComputerAction } from '../src/desktop/actions.js';

const click = (x: number): ComputerAction => ({
  action: 'click',
  x,
  y: 10,
  button: 'left',
  count: 1,
  description: 'click',
});

describe('ComputerStallDetector — §5.5', () => {
  it('stalls on the THIRD identical turn, not before', () => {
    const detector = new ComputerStallDetector();
    expect(detector.observe('AAA', [click(1)])).toBe(false);
    expect(detector.observe('AAA', [click(1)])).toBe(false);
    expect(detector.observe('AAA', [click(1)])).toBe(true);
    expect(detector.stalled).toBe(true);
    expect(detector.consecutive).toBe(COMPUTER_STALL_TURNS);
  });

  it('does not stall when the ACTION changes — the model is still trying', () => {
    const detector = new ComputerStallDetector();
    detector.observe('AAA', [click(1)]);
    detector.observe('AAA', [click(1)]);
    expect(detector.observe('AAA', [click(2)])).toBe(false);
    expect(detector.consecutive).toBe(1);
  });

  it('does not stall when the SCREEN changes — something is happening', () => {
    const detector = new ComputerStallDetector();
    detector.observe('AAA', [click(1)]);
    detector.observe('AAA', [click(1)]);
    expect(detector.observe('BBB', [click(1)])).toBe(false);
  });

  it('a differing turn resets the streak, and the count starts again', () => {
    const detector = new ComputerStallDetector();
    detector.observe('AAA', [click(1)]);
    detector.observe('AAA', [click(1)]);
    detector.observe('BBB', [click(1)]);
    expect(detector.observe('BBB', [click(1)])).toBe(false);
    expect(detector.observe('BBB', [click(1)])).toBe(true);
  });

  it('reset() clears everything', () => {
    const detector = new ComputerStallDetector();
    detector.observe('AAA', [click(1)]);
    detector.observe('AAA', [click(1)]);
    detector.reset();
    expect(detector.consecutive).toBe(0);
    expect(detector.observe('AAA', [click(1)])).toBe(false);
  });

  it('accepts the raw model text as the action half', () => {
    const detector = new ComputerStallDetector();
    detector.observe('AAA', '{"action":"noop"}');
    detector.observe('AAA', '{"action":"noop"}');
    expect(detector.observe('AAA', '{"action":"noop"}')).toBe(true);
  });
});

describe('fingerprintActions', () => {
  it('ignores `raw` — a reformatted envelope asked for the same thing', () => {
    const a: ComputerAction = { ...click(1), raw: { action: 'click', x: 1, y: 10 } };
    const b: ComputerAction = { ...click(1), raw: { x: 1, action: 'click', y: 10, extra: 'noise' } };
    expect(fingerprintActions([a])).toBe(fingerprintActions([b]));
  });

  it('ignores the order the model wrote the fields in', () => {
    const a = { action: 'noop', description: 'done' } as ComputerAction;
    const b = { description: 'done', action: 'noop' } as ComputerAction;
    expect(fingerprintActions([a])).toBe(fingerprintActions([b]));
  });

  it('still separates two genuinely different actions', () => {
    expect(fingerprintActions([click(1)])).not.toBe(fingerprintActions([click(2)]));
  });
});

describe('computerStallMessage', () => {
  it('names the stall and the turn count', () => {
    expect(computerStallMessage()).toContain('3 turns in a row');
    expect(computerStallMessage('Click the Save button')).toContain('"Click the Save button"');
  });
});
