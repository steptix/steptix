/**
 * A model reply Steptix could not use is shown, not just counted
 * (docs/specs/SPEC-web-survey-fixes.md §2.49). c40's "Verify that 3 equals 3"
 * failed with "Assertion code response missing code field" and the report held
 * no trace of what the model had actually said.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { renderReport } from '../src/report/generator.js';
import { quoteReply } from '../src/runner/step-executor.js';
import type { AiInteraction, StepResult, TestReport } from '../src/report/types.js';

function call(response: string): AiInteraction {
  return {
    purpose: 'assertion[0]',
    attemptNumber: 1,
    requestMessages: [{ role: 'user', content: 'Write a self-executing JavaScript function…' }],
    response,
    model: 'test-model',
    timestamp: '2026-10-08T00:00:00.000Z',
  };
}

function report(step: Partial<StepResult>): TestReport {
  return {
    testName: 'Unused replies',
    filePath: path.resolve(path.sep, 'proj', 'tests', 'replies.md'),
    tags: [],
    status: 'failed',
    steps: [{ instruction: 'Verify that 3 equals 3', status: 'failed', turns: [], durationMs: 10, retried: true, ...step }],
    totalSteps: 1,
    passedSteps: 0,
    failedSteps: 1,
    totalSubActions: 0,
    durationMs: 100,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    date: '2026-10-08T00:00:00.000Z',
  };
}

describe('replies Steptix could not use', () => {
  it('shows the replies of a check that never got usable code, under its step', () => {
    const html = renderReport(report({
      error: 'Assertion code failed after 2 attempts: Could not parse assertion code',
      discardedAiInteractions: [call('true'), call('The answer is plainly true.')],
    }));
    expect(html).toContain('Model replies this step did not use (2)');
    expect(html).toContain('The answer is plainly true.');
  });

  it("shows a check's replaced code replies beside the one that worked", () => {
    const html = renderReport(report({
      status: 'passed',
      assertions: [{
        assertIndex: 0,
        turnNumber: 1,
        subActionIndex: 1,
        description: '3 equals 3',
        condition: '3 equals 3',
        against: 'predicate',
        actual: '3 === 3 → true',
        pass: true,
        explanation: 'Assertion passed',
        aiInteraction: call('{"code": "(() => ({ pass: 3 === 3, actual: \'3 === 3 → true\' }))()"}'),
        supersededAiInteractions: [call('Yes, 3 equals 3.')],
      }],
    }));
    expect(html).toContain('Earlier code replies, replaced (1)');
    expect(html).toContain('Yes, 3 equals 3.');
  });

  it('adds nothing when every reply was used', () => {
    const html = renderReport(report({ status: 'passed' }));
    expect(html).not.toContain('did not use');
    expect(html).not.toContain('replaced (');
  });
});

describe('the failure message quotes the reply', () => {
  it('quotes a short reply on one line', () => {
    expect(quoteReply('Yes,\n  3 equals 3.')).toBe('"Yes, 3 equals 3."');
  });

  it('cuts a long reply and says how long it was', () => {
    const quoted = quoteReply('x'.repeat(1000));
    expect(quoted).toMatch(/^"x{300}…" \(1000 characters\)$/);
  });

  it('names an empty reply', () => {
    expect(quoteReply('  \n ')).toBe('(an empty reply)');
  });
});
