/**
 * Review 6: the report's per-step value maps, asked with a NON-EMPTY mask set.
 *
 * tests/secrets.test.ts pins the same two maps with `secrets: []`, which is
 * why the defect below never bit there: with nothing in the free-text set,
 * the deep copy a step's `outputs` were read from was byte-identical to the
 * original, so masking the copy and masking the original came to the same
 * thing. They stop being the same thing the moment the set is non-empty and
 * one of its values sits in the capture as an UNQUOTED JSON token.
 */
import { describe, it, expect } from 'vitest';
import { redactReport, secretValues, markLoopBindings, MASK } from '../src/utils/secrets.js';
import { renderReport } from '../src/report/generator.js';
import type { StepResult, TestReport } from '../src/report/types.js';

/** A capture a code-behind step or a tool can store: one secret column holding
 *  a NUMBER, and a short secret column beside it. The number clears the
 *  free-text floor and joins the mask set; the three-character one never
 *  does, so only the record rule can hide it. */
const CAPTURE = '[{"payee":"Acme","otp":123456,"password":"abc"}]';

function reportWith(over: Partial<StepResult>, parameters?: Record<string, string>): TestReport {
  const step: StepResult = {
    index: 1,
    instruction: 'Read the scheduled payments',
    status: 'passed',
    turns: [],
    durationMs: 1,
    retried: false,
    ...over,
  };
  return {
    testName: 'payments',
    filePath: '/p/payments.md',
    tags: [],
    status: 'passed',
    steps: [step],
    totalSteps: 1,
    passedSteps: 1,
    failedSteps: 0,
    totalSubActions: 0,
    durationMs: 1,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    date: 'd',
    ...(parameters !== undefined && { parameters }),
  };
}

describe('redactReport — a step’s captured outputs, with a non-empty mask set', () => {
  it('puts the mask set’s own value in the set', () => {
    // The premise. `otp` is a secret column and its number clears the floor,
    // so `123456` is free text from here on — and `abc` is not, which is
    // exactly the pair that makes the two maskings disagree.
    expect(secretValues({ payments: CAPTURE })).toEqual(['123456']);
  });

  it('masks the short column even when free-text masking broke the JSON first', () => {
    const secrets = secretValues({ payments: CAPTURE });
    const out = redactReport(reportWith({ outputs: { payments: CAPTURE } }), secrets);
    const masked = out.steps[0]!.outputs!.payments!;

    // Read off the ORIGINAL, the record rule still parses it: both secret
    // columns go, `payee` stays.
    expect(masked).toBe(`[{"payee":"Acme","otp":"${MASK}","password":"${MASK}"}]`);
    expect(masked).not.toContain('abc');
    expect(masked).not.toContain('123456');
    expect(masked).toContain('Acme');
  });

  it('does the same for a tool step’s outputs', () => {
    const secrets = secretValues({ payments: CAPTURE });
    const out = redactReport(
      reportWith({
        toolStep: { name: 'fetch-payments', args: {}, outputs: { payments: CAPTURE }, logs: [] },
      }),
      secrets,
    );
    const masked = out.steps[0]!.toolStep!.outputs.payments!;
    expect(masked).toBe(`[{"payee":"Acme","otp":"${MASK}","password":"${MASK}"}]`);
  });

  it('still applies the free-text set to a capture the record rule does not touch', () => {
    // The other half of the composition: a plain value is masked by value,
    // exactly as the deep walk did before this read from the original.
    const out = redactReport(reportWith({ outputs: { note: 'the code is 123456' } }), ['123456']);
    expect(out.steps[0]!.outputs!.note).toBe(`the code is ${MASK}`);
  });

  it('leaves a data:image capture alone, as the deep walk did', () => {
    // Reading from the original steps around `redactDeep`'s binary guard, so
    // this one is reapplied here: a short secret matches inside base64 by
    // coincidence, and replacing it corrupts the image without hiding
    // anything. `[store as: logo]` on an `img` src stores exactly this.
    const png = 'data:image/png;base64,AAAAabcAAAA';
    const out = redactReport(reportWith({ outputs: { logo: png } }), ['abc']);
    expect(out.steps[0]!.outputs!.logo).toBe(png);
  });

  it('carries none of it into the rendered report either', () => {
    const secrets = secretValues({ payments: CAPTURE });
    const html = renderReport(
      redactReport(reportWith({ outputs: { payments: CAPTURE } }, { payments: CAPTURE }), secrets),
    );
    expect(html).toContain('captures-block');
    expect(html).not.toContain('abc');
    expect(html).not.toContain('123456');
  });
});

describe('redactReport — identity survives a loop band that needed no masking', () => {
  it('returns the report ITSELF when a band holds nothing to mask', () => {
    const values = { 'payment.payee': 'Acme', 'payment.keyword': 'AU' };
    markLoopBindings(values, ['payment.payee', 'payment.keyword']);
    const plain = reportWith({
      loop: { kind: 'iteration', label: 'Pay one', index: 1, count: 1, values },
    });
    expect(redactReport(plain, [])).toBe(plain);
  });

  it('still rebuilds when the band DOES hold something to mask', () => {
    const values = { 'payment.payee': 'Acme', 'payment.password': 'abc' };
    markLoopBindings(values, ['payment.payee', 'payment.password']);
    const withSecret = reportWith({
      loop: { kind: 'iteration', label: 'Pay one', index: 1, count: 1, values },
    });
    const out = redactReport(withSecret, []);
    expect(out).not.toBe(withSecret);
    expect(out.steps[0]!.loop!.values).toEqual({ 'payment.payee': 'Acme', 'payment.password': MASK });
    // The run's own map is untouched — masking is applied at the outputs.
    expect(values['payment.password']).toBe('abc');
  });
});
