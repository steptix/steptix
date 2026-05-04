/**
 * Tests for the value-only / predicate assertion path. Covers each layer
 * of the change in isolation:
 *
 *   1. action-parser:  predicate without expected → ok; predicate with
 *                      expected → strict reject; non-predicate without
 *                      expected → still rejected.
 *   2. prompts:        rule 8 mentions the predicate shape; the code-gen
 *                      prompt for predicate mode skips DOM/API context.
 *   3. step-cache:     fingerprint distinct between predicate and dom modes
 *                      with the same condition.
 *   4. report renderer: predicate result renders "Predicate / Result" rows
 *                       and skips the empty Expected row.
 *
 * The end-to-end CLI flow against the live test-app is verified separately
 * (see story stories/value-only-assertions.md — that's the binding
 * success criterion for this feature).
 */
import { describe, it, expect } from 'vitest';
import { parseAIResponse } from '../src/ai/action-parser.js';
import {
  buildAssertionCodePrompt,
  buildSystemPrompt,
} from '../src/ai/prompts.js';
import { fingerprintAssertion } from '../src/cache/step-cache.js';
import { renderStep } from '../src/report/generator.js';
import type { StepResult } from '../src/report/types.js';

// ─── Layer 1: action-parser ─────────────────────────────────────────────

describe('action-parser — predicate mode', () => {
  it('accepts an assert with against:predicate and no expected', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'assert',
          against: 'predicate',
          condition: '8 is at least 5',
          description: 'order_count >= 5',
        },
      ],
      reasoning: 'self-contained predicate',
    });
    const parsed = parseAIResponse(raw);
    expect(parsed.actions[0]?.action).toBe('assert');
    expect(parsed.actions[0]?.against).toBe('predicate');
    expect(parsed.actions[0]?.condition).toBe('8 is at least 5');
    expect(parsed.actions[0]?.expected).toBeUndefined();
  });

  it('strictly rejects predicate mode with a non-empty expected (modes are mutually exclusive)', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'assert',
          against: 'predicate',
          condition: '8 is at least 5',
          expected: 'true',
          description: 'order_count >= 5',
        },
      ],
      reasoning: 'mode confusion',
    });
    expect(() => parseAIResponse(raw)).toThrow(/mutually exclusive/);
  });

  it('still rejects DOM mode without expected (regression: existing strict path)', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'assert',
          condition: 'visible title',
          description: 'title check',
        },
      ],
      reasoning: 'forgot expected',
    });
    expect(() => parseAIResponse(raw)).toThrow(/missing required "expected" field/);
  });

  it("error message for missing expected nudges toward predicate mode", () => {
    let caught: Error | undefined;
    try {
      parseAIResponse(JSON.stringify({
        actions: [{ action: 'assert', condition: 'x', description: 'd' }],
        reasoning: '',
      }));
    } catch (e) { caught = e as Error; }
    expect(caught?.message).toMatch(/predicate.*self-contained/i);
  });

  it('still rejects predicate without condition', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'assert', against: 'predicate', description: 'd' },
      ],
      reasoning: '',
    });
    expect(() => parseAIResponse(raw)).toThrow(/missing required "condition" field/);
  });

  it('still rejects predicate without description', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'assert', against: 'predicate', condition: 'x' },
      ],
      reasoning: '',
    });
    expect(() => parseAIResponse(raw)).toThrow(/missing required "description" field/);
  });
});

// ─── Layer 2: prompt + code-gen prompt ──────────────────────────────────

describe('prompts — predicate guidance', () => {
  it('rule 8 mentions the predicate shape', () => {
    const sys = buildSystemPrompt('', undefined, { dismissalGuidance: false });
    const text = sys.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('against: "predicate"');
    expect(text).toContain('self-contained predicate');
    expect(text).toMatch(/DO NOT include "expected"/);
  });

  it('buildAssertionCodePrompt for predicate mode omits DOM context and Expected line', () => {
    const msg = buildAssertionCodePrompt(
      'order_count >= 5',
      '8 is at least 5',
      undefined,
      '<html><body>(should not appear)</body></html>',
      null,
      undefined,
      'predicate',
    );
    const body = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(body).not.toContain('Current Page DOM');
    expect(body).not.toContain('Prior API Responses');
    expect(body).not.toContain('Expected:'); // no expected line in predicate mode
    expect(body).toContain('self-contained predicate');
    expect(body).toContain('Description: order_count >= 5');
    expect(body).toContain('Condition: 8 is at least 5');
  });

  it('buildAssertionCodePrompt for predicate mode includes JSON-array and numeric guidance', () => {
    const msg = buildAssertionCodePrompt(
      'failed_ids contains expected ids',
      '["O-1003","O-1007"] contains "O-1003"',
      undefined,
      null,
      null,
      undefined,
      'predicate',
    );
    const body = typeof msg.content === 'string' ? msg.content : '';
    expect(body).toMatch(/JSON\.parse/);
    expect(body).toMatch(/Array\.prototype\.includes/);
    expect(body).toMatch(/Number\(/);
  });

  it('buildAssertionCodePrompt for DOM mode keeps the original Expected line', () => {
    const msg = buildAssertionCodePrompt(
      'title check',
      'visible title text',
      'Done',
      '<html></html>',
      null,
      undefined,
      'dom',
    );
    const body = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(body).toContain('Expected: Done');
    expect(body).toContain('Current Page DOM');
  });
});

// ─── Layer 3: cache fingerprint ─────────────────────────────────────────

describe('fingerprintAssertion — predicate vs DOM', () => {
  it('predicate (undefined expected) and DOM (empty expected) hash to different keys', () => {
    const predFp = fingerprintAssertion('8 is at least 5', undefined, 0);
    const domFp = fingerprintAssertion('8 is at least 5', '', 0);
    expect(predFp).not.toBe(domFp);
  });

  it('two predicate asserts with the same condition + index hash to the same key (cache hit on rerun)', () => {
    const a = fingerprintAssertion('8 is at least 5', undefined, 0);
    const b = fingerprintAssertion('8 is at least 5', undefined, 0);
    expect(a).toBe(b);
  });

  it('changing the condition invalidates the predicate cache key', () => {
    const a = fingerprintAssertion('8 is at least 5', undefined, 0);
    const b = fingerprintAssertion('8 is at least 6', undefined, 0);
    expect(a).not.toBe(b);
  });

  it('changing the assertIndex still keys distinctly even for predicate mode', () => {
    const a = fingerprintAssertion('p', undefined, 0);
    const b = fingerprintAssertion('p', undefined, 1);
    expect(a).not.toBe(b);
  });

  it('back-compat: DOM fingerprint is byte-identical to before the change', () => {
    // The change preserved the existing template `${i} ${cond} ${expected}`
    // for non-undefined `expected`. This test pins that contract: any
    // refactor that rebuilds the hash differently (e.g. JSON, separator
    // change) would invalidate every cached assertion in existing reports.
    const fp = fingerprintAssertion('visible title', 'Done', 2);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toBe(fingerprintAssertion('visible title', 'Done', 2));
  });
});

// ─── Layer 4: report renderer ───────────────────────────────────────────

describe('renderStep — predicate result', () => {
  function makeStep(opts: {
    against?: 'dom' | 'api' | 'both' | 'predicate';
    expected: string | undefined;
    pass: boolean;
  }): StepResult {
    return {
      index: 1,
      instruction: 'Assert that 8 is at least 5',
      status: opts.pass ? 'passed' : 'failed',
      turns: [],
      durationMs: 5,
      retried: false,
      assertions: [
        {
          assertIndex: 0,
          turnNumber: 1,
          subActionIndex: 1,
          description: 'order_count >= 5',
          condition: '8 is at least 5',
          expected: opts.expected,
          ...(opts.against !== undefined && { against: opts.against }),
          actual: '8 >= 5 → true',
          pass: opts.pass,
          explanation: opts.pass ? 'Assertion passed' : 'Predicate "8 is at least 5" was false',
        },
      ],
    };
  }

  it('predicate mode renders Predicate: / Result: rows and omits Expected', () => {
    const html = renderStep(
      makeStep({ against: 'predicate', expected: undefined, pass: true }),
      false,
      0,
    );
    expect(html).toContain('Predicate:');
    expect(html).toContain('Result:');
    expect(html).not.toContain('Expected:');
    expect(html).toContain('8 is at least 5');
    expect(html).toContain('8 &gt;= 5 → true'); // escapeHtml keeps `>` as &gt;
  });

  it('DOM mode keeps the original Condition / Expected / Actual rows', () => {
    const html = renderStep(
      makeStep({ against: 'dom', expected: 'true', pass: true }),
      false,
      0,
    );
    expect(html).toContain('Condition:');
    expect(html).toContain('Expected:');
    expect(html).toContain('Actual:');
    expect(html).not.toContain('Predicate:');
    expect(html).not.toContain('Result:');
  });

  it('legacy assertion records (no `against`) still render as DOM rows', () => {
    // A report written before the predicate mode existed has assertions
    // with `against: undefined`. The renderer must default to DOM-style
    // rows for those — otherwise old reports stop showing Expected.
    const html = renderStep(
      makeStep({ expected: 'Done', pass: true }),
      false,
      0,
    );
    expect(html).toContain('Expected:');
    expect(html).toContain('Actual:');
    expect(html).not.toContain('Predicate:');
  });

  it('failed predicate renders the Result row even when JS returned a "false" message', () => {
    const html = renderStep(
      makeStep({ against: 'predicate', expected: undefined, pass: false }),
      false,
      0,
    );
    expect(html).toContain('Result:');
    expect(html).toContain('FAILED');
  });
});
