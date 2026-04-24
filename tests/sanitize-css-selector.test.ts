import { describe, it, expect } from 'vitest';
import { sanitizeCssSelector } from '../src/browser/actions.js';

describe('sanitizeCssSelector — Tailwind escapes', () => {
  it('escapes Tailwind important modifier', () => {
    expect(sanitizeCssSelector('.!fixed')).toBe('.\\!fixed');
  });

  it('escapes Tailwind opacity shorthand', () => {
    expect(sanitizeCssSelector('.bg-black/50')).toBe('.bg-black\\/50');
  });

  it('escapes Tailwind container query variants', () => {
    expect(sanitizeCssSelector('.@lg')).toBe('.\\@lg');
  });

  it('escapes numeric Tailwind arbitrary values', () => {
    expect(sanitizeCssSelector('.z-[999]')).toBe('.z-\\[999\\]');
  });

  it('escapes colour Tailwind arbitrary values', () => {
    expect(sanitizeCssSelector('.bg-[#fff]')).toBe('.bg-\\[#fff\\]');
  });

  it('escapes calc() arbitrary values with multiplication', () => {
    expect(sanitizeCssSelector('.w-[calc(50%*2)]')).toBe('.w-\\[calc(50%*2)\\]');
  });

  it('escapes bare CSS keywords as arbitrary values', () => {
    expect(sanitizeCssSelector('.text-[red]')).toBe('.text-\\[red\\]');
  });
});

describe('sanitizeCssSelector — leaves attribute selectors alone', () => {
  it('preserves class followed by attribute selector with value', () => {
    expect(sanitizeCssSelector('a.prc-ActionList-Item-[href="/logout"]'))
      .toBe('a.prc-ActionList-Item-[href="/logout"]');
  });

  it('preserves class followed by attribute selector with single quotes', () => {
    expect(sanitizeCssSelector("a.foo-[href='/logout']"))
      .toBe("a.foo-[href='/logout']");
  });

  it('preserves attribute selector combinators ~= |= ^= $= *=', () => {
    expect(sanitizeCssSelector('.btn-[data-role*="primary"]'))
      .toBe('.btn-[data-role*="primary"]');
  });

  it('preserves standalone attribute selectors', () => {
    expect(sanitizeCssSelector('[role="dialog"]')).toBe('[role="dialog"]');
    expect(sanitizeCssSelector('div[aria-label="Close"]')).toBe('div[aria-label="Close"]');
  });
});

describe('sanitizeCssSelector — colon escapes in id/class', () => {
  it('escapes colons in React Aria auto-ids', () => {
    expect(sanitizeCssSelector('#react-aria-:rb4:')).toBe('#react-aria-\\:rb4\\:');
  });

  it('does not escape colons before known pseudo-classes', () => {
    expect(sanitizeCssSelector('.btn:hover')).toBe('.btn:hover');
    expect(sanitizeCssSelector('tr:nth-of-type(3)')).toBe('tr:nth-of-type(3)');
  });
});
