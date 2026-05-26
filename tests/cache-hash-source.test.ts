import { describe, it, expect } from 'vitest';
import { chooseCacheHashSource, arraysEqual } from '../src/server/cache-hash-source.js';

// Pure decision logic for the Bug 2 cache-hash source (issue 016). See
// testbench-native/stories/specs/skill-cache-invalidation.md §4.2.

describe('arraysEqual', () => {
  it('is true for element-wise identical arrays', () => {
    expect(arraysEqual(['a', 'b'], ['a', 'b'])).toBe(true);
  });
  it('is false for different lengths', () => {
    expect(arraysEqual(['a'], ['a', 'b'])).toBe(false);
  });
  it('is false for same length but different content', () => {
    expect(arraysEqual(['a', 'b'], ['a', 'c'])).toBe(false);
  });
  it('is true for two empty arrays', () => {
    expect(arraysEqual([], [])).toBe(true);
  });
});

describe('chooseCacheHashSource (issue 016 Bug 2)', () => {
  const steps = ['s1', 's2', 's3'];

  it('batch == fullSteps (full run) → effective, with or without skills', () => {
    expect(chooseCacheHashSource(steps, steps, true)).toBe('effective');
    expect(chooseCacheHashSource(steps, [...steps], false)).toBe('effective');
  });

  it('no fullSteps (legacy caller) → effective', () => {
    expect(chooseCacheHashSource(steps, undefined, true)).toBe('effective');
    expect(chooseCacheHashSource(steps, undefined, false)).toBe('effective');
  });

  it('subset batch with skills → expand-full (hash the whole document)', () => {
    expect(chooseCacheHashSource(['s3'], steps, true)).toBe('expand-full');
  });

  it('subset batch without skills → raw-full', () => {
    expect(chooseCacheHashSource(['s3'], steps, false)).toBe('raw-full');
  });

  it('treats a same-length-but-different batch as a subset, not equal', () => {
    // Defensive: arraysEqual compares content, so a non-matching batch of equal
    // length is still "not the full document" and re-expands.
    expect(chooseCacheHashSource(['x', 'y', 'z'], steps, true)).toBe('expand-full');
  });
});
