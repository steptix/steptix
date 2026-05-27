import { describe, it, expect } from 'vitest';
import { TokenTracker } from '../src/utils/tokens.js';

describe('TokenTracker per-run accounting', () => {
  it('cumulative totals grow across the tracker lifetime', () => {
    const t = new TokenTracker();
    t.addUsage(100, 10);
    t.addUsage(50, 5);
    expect(t.inputTotal).toBe(150);
    expect(t.outputTotal).toBe(15);
    expect(t.total).toBe(165);
  });

  it('run totals equal cumulative totals before any markRunStart', () => {
    const t = new TokenTracker();
    t.addUsage(100, 10);
    // A fresh tracker (CLI/UI path, one per run) never calls markRunStart —
    // its baseline is 0, so run totals match cumulative totals.
    expect(t.runInputTotal).toBe(100);
    expect(t.runOutputTotal).toBe(10);
    expect(t.runTotal).toBe(110);
  });

  it('markRunStart rebaselines run totals to count only post-mark usage', () => {
    const t = new TokenTracker();
    // First run: real AI calls.
    t.addUsage(400_000, 1_200);
    t.markRunStart();
    // Second run: fully cache-served — no AI calls, so no usage added.
    expect(t.runInputTotal).toBe(0);
    expect(t.runOutputTotal).toBe(0);
    expect(t.runTotal).toBe(0);
    // ...while the cumulative totals still reflect the whole session.
    expect(t.inputTotal).toBe(400_000);
    expect(t.outputTotal).toBe(1_200);
    expect(t.total).toBe(401_200);
  });

  it('counts only post-mark usage when a run adds some tokens after the mark', () => {
    // The realistic server shape: run 1 spent real tokens, then markRunStart,
    // then run 2 spends *some* (e.g. a few uncached steps). The report for
    // run 2 must show run 2's usage only, not the session-cumulative figure.
    const t = new TokenTracker();
    t.addUsage(400_000, 1_200); // run 1 (cold)
    t.markRunStart();
    t.addUsage(2_000, 40); // run 2 (mostly cached, two live steps)
    expect(t.runInputTotal).toBe(2_000);
    expect(t.runOutputTotal).toBe(40);
    expect(t.runTotal).toBe(2_040);
    expect(t.total).toBe(403_240);
  });

  it('markRunStart isolates each run when usage is added between marks', () => {
    const t = new TokenTracker();
    t.markRunStart();
    t.addUsage(100, 10); // run 1
    expect(t.runTotal).toBe(110);

    t.markRunStart();
    t.addUsage(30, 3); // run 2
    expect(t.runInputTotal).toBe(30);
    expect(t.runOutputTotal).toBe(3);
    expect(t.runTotal).toBe(33);

    // Cumulative still spans both runs.
    expect(t.total).toBe(143);
  });
});
