/**
 * The one rule for what a secret is and the one way of masking it
 * (stories/secret-redaction.md). The console step line, the report, the
 * per-run log file and the recording all go through here.
 */
import { describe, it, expect } from 'vitest';
import {
  secretValues,
  runSecrets,
  redact,
  redactDeep,
  redactMap,
  redactReport,
  MASK,
} from '../src/utils/secrets.js';
import type { TestReport } from '../src/report/types.js';

describe('secretValues / runSecrets — what counts', () => {
  it('takes the values of secret-named parameters and nothing else', () => {
    expect(
      secretValues({ username: 'octocat', password: 'hunter2!x', api_token: 'tok-1', search_keyword: 'k' }),
    ).toEqual(['hunter2!x', 'tok-1', 'k']);
  });

  it('drops empty values — there is nothing to find, and split("") would shred the text', () => {
    expect(secretValues({ password: '' }, [''])).toEqual([]);
  });

  it('merges the caller’s extra values and dedups', () => {
    expect(secretValues({ password: 'same' }, ['same', 'other'])).toEqual(['same', 'other']);
  });

  it('runSecrets adds the env/data secrets of the run’s context', () => {
    const secrets = runSecrets({
      parameters: { password: 'p-param' },
      envData: {
        env: { GITHUB_PASSWORD: 'p-env', GITHUB_USERNAME: 'octocat' },
        data: { users: { admin: { password: 'p-data' } }, url: 'https://x/' },
        envName: 'uat',
      },
    });
    expect(secrets.sort()).toEqual(['p-data', 'p-env', 'p-param']);
    expect(runSecrets({ parameters: { password: 'p' }, envData: null })).toEqual(['p']);
  });
});

describe('redact — by value', () => {
  it('replaces every occurrence', () => {
    expect(redact('pw hunter2!x and again hunter2!x', ['hunter2!x'])).toBe(`pw ${MASK} and again ${MASK}`);
  });

  it('longest first, so a secret containing another is masked whole', () => {
    expect(redact('abc-long abc', ['abc', 'abc-long'])).toBe(`${MASK} ${MASK}`);
  });

  it('is the identity with nothing to mask', () => {
    expect(redact('plain', [])).toBe('plain');
  });
});

describe('redactDeep — every string in an object, by value', () => {
  const secrets = ['hunter2!x'];

  it('walks nested objects and arrays and returns a copy', () => {
    const input = {
      instruction: 'Enter the password hunter2!x',
      turns: [{ aiInteractions: [{ response: '{"value":"hunter2!x"}' }] }],
      n: 3,
      ok: true,
      nothing: null,
    };
    const out = redactDeep(input, secrets);
    expect(out).toEqual({
      instruction: `Enter the password ${MASK}`,
      turns: [{ aiInteractions: [{ response: `{"value":"${MASK}"}` }] }],
      n: 3,
      ok: true,
      nothing: null,
    });
    expect(input.instruction).toBe('Enter the password hunter2!x');
  });

  it('masks by value only — a press action’s `key` is not a secret', () => {
    expect(redactDeep({ type: 'press', key: 'Enter' }, secrets)).toEqual({ type: 'press', key: 'Enter' });
  });

  it('leaves screenshots alone, by key and by data: prefix', () => {
    // A base64 run that happens to spell the secret — replacing it would
    // corrupt the image, and the image never shows a typed password anyway.
    const input = {
      screenshotBase64: 'AAAAhunter2!xAAAA',
      screenshot: 'data:image/png;base64,hunter2!x',
      image_url: { url: 'data:image/png;base64,hunter2!x' },
      caption: 'typed hunter2!x',
    };
    expect(redactDeep(input, secrets)).toEqual({
      screenshotBase64: 'AAAAhunter2!xAAAA',
      screenshot: 'data:image/png;base64,hunter2!x',
      image_url: { url: 'data:image/png;base64,hunter2!x' },
      caption: `typed ${MASK}`,
    });
  });

  it('keeps non-plain objects as they are', () => {
    const when = new Date('2026-08-23T00:00:00Z');
    const out = redactDeep({ when, note: 'hunter2!x' }, secrets);
    expect(out.when).toBe(when);
    expect(out.note).toBe(MASK);
  });

  it('returns the same object when there is nothing to mask', () => {
    const input = { a: 'b' };
    expect(redactDeep(input, [])).toBe(input);
  });
});

describe('redactMap — values held under their names', () => {
  it('masks secret-named entries outright and the rest by value', () => {
    expect(redactMap({ username: 'octocat', password: 'hunter2!x', note: 'pw is hunter2!x', token: '' }, ['hunter2!x'])).toEqual({
      username: 'octocat',
      password: MASK,
      note: `pw is ${MASK}`,
      token: MASK,
    });
  });
});

describe('redactReport — the report every consumer sees', () => {
  function report(): TestReport {
    return {
      testName: 'login',
      filePath: '/p/login.md',
      tags: [],
      status: 'passed',
      steps: [
        {
          index: 1,
          instruction: 'Enter the password hunter2!x',
          status: 'passed',
          turns: [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: 't',
              aiInteractions: [
                {
                  purpose: 'step',
                  requestMessages: [{ role: 'user', content: '## Current Step\nEnter the password hunter2!x' }],
                  response: '{"actions":[{"type":"type","selector":"#p","value":"hunter2!x"}]}',
                  screenshotBase64: 'hunter2!x',
                },
              ],
              subActions: [
                { index: 0, action: { type: 'type', selector: '#p', value: 'hunter2!x' } as never, durationMs: 1 },
                { index: 1, action: { type: 'press', key: 'Enter' } as never, durationMs: 1 },
              ],
            },
          ],
          outputs: { token: 'tok-1' },
          screenshotBase64: 'hunter2!x',
          durationMs: 1,
          retried: false,
        },
      ],
      totalSteps: 1,
      passedSteps: 1,
      failedSteps: 0,
      totalSubActions: 2,
      durationMs: 1,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      date: 'd',
      parameters: { username: 'octocat', password: 'hunter2!x', token: 'tok-1' },
    };
  }

  it('masks the parameters by name and everything else by value, screenshots excepted', () => {
    const secrets = secretValues(report().parameters!);
    const out = redactReport(report(), secrets);
    expect(out.parameters).toEqual({ username: 'octocat', password: MASK, token: MASK });
    const step = out.steps[0]!;
    expect(step.instruction).toBe(`Enter the password ${MASK}`);
    const turn = step.turns[0]!;
    expect(turn.aiInteractions[0]!.requestMessages![0]!.content).toBe(`## Current Step\nEnter the password ${MASK}`);
    expect(turn.aiInteractions[0]!.response).toBe(`{"actions":[{"type":"type","selector":"#p","value":"${MASK}"}]}`);
    expect(turn.aiInteractions[0]!.screenshotBase64).toBe('hunter2!x');
    expect(turn.subActions[0]!.action).toEqual({ type: 'type', selector: '#p', value: MASK });
    expect(turn.subActions[1]!.action).toEqual({ type: 'press', key: 'Enter' });
    expect(step.outputs).toEqual({ token: MASK });
    expect(step.screenshotBase64).toBe('hunter2!x');
    // The whole thing, serialized, carries neither value anywhere else either.
    const text = JSON.stringify({ ...out, steps: out.steps.map((s) => ({ ...s, screenshotBase64: undefined, turns: [] })) });
    expect(text).not.toContain('hunter2!x');
    expect(text).not.toContain('tok-1');
  });

  it('is the identity for a report with no secrets and no parameters', () => {
    const plain: TestReport = { ...report(), parameters: undefined as never };
    delete (plain as { parameters?: unknown }).parameters;
    expect(redactReport(plain, [])).toBe(plain);
  });

  it('still masks the parameters by name when the value list is empty', () => {
    const out = redactReport(report(), []);
    expect(out.parameters!.password).toBe(MASK);
    expect(out.steps[0]!.instruction).toBe('Enter the password hunter2!x');
  });
});
