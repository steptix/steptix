/**
 * Report-template tests for the session `<video>` block. Mirrors
 * tests/report-tool-step.test.ts (imports a render fn and asserts on the HTML).
 *  - `videoRelPath` set → a file-linked `<video src="videos/..." controls>` block
 *  - `videoRelPath` unset → no `<video` tag at all
 */
import { describe, it, expect } from 'vitest';
import { renderReport } from '../src/report/generator.js';
import type { TestReport } from '../src/report/types.js';

function baseReport(overrides: Partial<TestReport> = {}): TestReport {
  return {
    testName: 'Checkout flow',
    filePath: 'tests/checkout.md',
    tags: [],
    status: 'passed',
    steps: [],
    totalSteps: 0,
    passedSteps: 0,
    failedSteps: 0,
    totalSubActions: 0,
    durationMs: 1234,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    date: new Date('2026-06-02T10:15:03Z').toISOString(),
    ...overrides,
  };
}

describe('renderReport — session video block', () => {
  it('renders a file-linked <video controls> when videoRelPath is set', () => {
    const html = renderReport(baseReport({ videoRelPath: 'videos/x.webm' }));
    expect(html).toContain('<video');
    expect(html).toContain('src="videos/x.webm"');
    expect(html).toContain('controls');
    expect(html).toContain('Session recording');
    // File-linked, NOT embedded — never a data: URI for the video.
    expect(html).not.toContain('src="data:video');
  });

  it('omits the <video> block entirely when videoRelPath is unset', () => {
    const html = renderReport(baseReport());
    expect(html).not.toContain('<video');
    expect(html).not.toContain('Session recording');
  });
});
