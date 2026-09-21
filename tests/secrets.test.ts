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
  recordSecretValues,
  isRecordSecretKey,
  EMPTY,
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
    expect(redactMap({ username: 'octocat', password: 'hunter2!x', note: 'pw is hunter2!x' }, ['hunter2!x'])).toEqual({
      username: 'octocat',
      password: MASK,
      note: `pw is ${MASK}`,
    });
  });

  it('says an EMPTY secret is empty, because *** cannot be told from a password', () => {
    // A data-driven test's whole point can be one row with a blank password
    // and one with a wrong one. Masking both to `***` makes the report's
    // matrix unable to tell them apart, and nothing is disclosed by saying a
    // field was left blank — which is what the client's `maskIfSecret`
    // already says on the Output banner for the same cell.
    expect(redactMap({ password: '', token: '', apiKey: '' }, [])).toEqual({
      password: EMPTY,
      token: EMPTY,
      apiKey: EMPTY,
    });
    // A non-empty one is still masked outright, by its NAME, whether or not
    // its value is in `secrets`.
    expect(redactMap({ password: 'never-collected' }, [])).toEqual({ password: MASK });
  });
});

/**
 * A `readTable` capture is ONE parameter whose value is a JSON array of row
 * records (SPEC-structured-table-reads.md §7.1), so the name the rule reads —
 * `orders` — says nothing about the columns inside it. §7.6 requires the
 * masking to reach in: a `password` column is a secret however the row it sits
 * in is named.
 */
describe('secrets inside a record list (structured table reads)', () => {
  const ORDERS = JSON.stringify([
    { _row: '1', id: 'ORD-1001', customer: 'Alice Smith', password: 'row-1-hunter2' },
    { _row: '2', id: 'ORD-1002', customer: 'Bob Jones', password: 'row-2-hunter2' },
  ]);

  it('collects a secret-named COLUMN from every record', () => {
    expect(secretValues({ orders: ORDERS })).toEqual(['row-1-hunter2', 'row-2-hunter2']);
  });

  it('so the console line and the report never print one', () => {
    const secrets = secretValues({ orders: ORDERS });
    expect(redact('typing row-1-hunter2 into the field', secrets)).toBe(`typing ${MASK} into the field`);
    expect(
      redactDeep({ steps: [{ action: 'type', value: 'row-2-hunter2', selector: '#pw' }] }, secrets),
    ).toEqual({ steps: [{ action: 'type', value: MASK, selector: '#pw' }] });
  });

  it('masks the dotted binding a For each pass leaves in the map, by name and by value', () => {
    // The pass binds `order` plus one entry per property (§8.2), so the map
    // itself carries `order.password`. `isSecretName` matches on a substring,
    // which is what makes the property segment count without a second rule.
    const pass = {
      orders: ORDERS,
      order: '{"_row":"1","id":"ORD-1001","password":"row-1-hunter2"}',
      'order.id': 'ORD-1001',
      'order.password': 'row-1-hunter2',
    };
    const secrets = secretValues(pass);
    expect(secrets).toContain('row-1-hunter2');
    expect(redactMap(pass, secrets)).toEqual({
      // The base binding is not secret-named, so it is masked by VALUE — the
      // row survives as evidence with the one cell blanked.
      orders: ORDERS.split('row-1-hunter2').join(MASK).split('row-2-hunter2').join(MASK),
      order: `{"_row":"1","id":"ORD-1001","password":"${MASK}"}`,
      'order.id': 'ORD-1001',
      'order.password': MASK,
    });
  });

  it('masks a record stored under a secret-named variable whole, as it always did', () => {
    const tokens = JSON.stringify([{ _row: '1', label: 'staging' }]);
    expect(secretValues({ token: tokens })).toEqual([tokens]);
    expect(redactMap({ token: tokens }, secretValues({ token: tokens }))).toEqual({ token: MASK });
  });

  it('changes nothing else', () => {
    // No secret-named column: the list is left alone.
    const plain = JSON.stringify([{ _row: '1', id: 'ORD-1001', customer: 'Alice Smith' }]);
    expect(secretValues({ orders: plain })).toEqual([]);
    // A flat plural read is an array of strings, not records.
    expect(secretValues({ ids: '["ORD-1001","ORD-1002"]' })).toEqual([]);
    // Anything that is not a list of objects is not a record list, including
    // text that merely starts like one.
    expect(secretValues({ note: '[{ not json at all' })).toEqual([]);
    expect(secretValues({ blob: '{"password":"nested"}' })).toEqual([]);
    expect(secretValues({ nested: '[{"password":{"deep":"x"}}]' })).toEqual([]);
    // Empty values are still not secrets.
    expect(secretValues({ orders: '[{"password":""}]' })).toEqual([]);
  });
});

/**
 * The two limits review put on that reach-inside rule, and the memo (§7.6).
 * Both limits exist because masking is NOT a free precaution: `redact`
 * replaces the value everywhere, including in the DOM snapshot the model
 * plans its next action from (step-executor.ts, `redact(domSnapshot, …)`).
 */
describe('record masking — the limits that keep it from masking the page', () => {
  it('never masks a record value shorter than four characters', () => {
    // Measured: a `token` column holding `-`, `-` and `7` put `-` and `7` in
    // the mask set, and every dash and every seven in every output became
    // `***` — including a report line that read
    // `3 rows, total $1,742.70 for order ORD-1007`.
    const rows = JSON.stringify([
      { _row: '1', payee: 'Acme', token: '-' },
      { _row: '2', payee: 'Globex', token: '-' },
      { _row: '3', payee: 'Initech', token: '7' },
    ]);
    expect(secretValues({ payments: rows })).toEqual([]);
    const line = 'Step 7 passed: 3 rows, total $1,742.70 for order ORD-1007';
    expect(redact(line, secretValues({ payments: rows }))).toBe(line);
    // Four characters and up is a credential again.
    expect(secretValues({ p: JSON.stringify([{ token: 'abcd' }]) })).toEqual(['abcd']);
    expect(secretValues({ p: JSON.stringify([{ token: 'abc' }]) })).toEqual([]);
  });

  it('matches a COLUMN name by whole words, so `keyword` and `sort_key` are not secrets', () => {
    // A record's keys come off the PAGE, not from the author, and
    // `isSecretName`'s substring rule — /password|secret|token|key/i — makes
    // any column with `key` in its name mask its every value everywhere.
    expect(isRecordSecretKey('api_key')).toBe(true);
    expect(isRecordSecretKey('apiKey')).toBe(true);
    expect(isRecordSecretKey('access_key')).toBe(true);
    expect(isRecordSecretKey('private-key')).toBe(true);
    expect(isRecordSecretKey('password')).toBe(true);
    expect(isRecordSecretKey('user_password')).toBe(true);
    expect(isRecordSecretKey('Token')).toBe(true);
    expect(isRecordSecretKey('secret')).toBe(true);
    expect(isRecordSecretKey('keyword')).toBe(false);
    expect(isRecordSecretKey('sort_key')).toBe(false);
    expect(isRecordSecretKey('sortKey')).toBe(false);
    expect(isRecordSecretKey('key')).toBe(false);
    expect(isRecordSecretKey('monkey')).toBe(false);
    expect(isRecordSecretKey('customer')).toBe(false);

    const rows = JSON.stringify([
      { _row: '1', keyword: 'winter sale', sort_key: 'alpha-2026', api_key: 'ak-live-9f3c' },
    ]);
    expect(secretValues({ results: rows })).toEqual(['ak-live-9f3c']);
    expect(redact('sorted by alpha-2026 for winter sale with ak-live-9f3c', secretValues({ results: rows })))
      .toBe(`sorted by alpha-2026 for winter sale with ${MASK}`);
    // The author-chosen name keeps the broad rule: a PARAMETER named
    // `search_keyword` is still masked, as the first describe pins.
    expect(secretValues({ search_keyword: 'winter sale' })).toEqual(['winter sale']);
  });

  it('finds the records however the list is spaced — `[ {`, or pretty-printed', () => {
    // The sniff used to be `startsWith('[{')`, so a producer that pretty-
    // printed the same capture masked nothing at all.
    const records = [{ _row: '1', customer: 'Alice', password: 'row-1-hunter2' }];
    expect(secretValues({ a: `[ ${JSON.stringify(records[0])} ]` })).toEqual(['row-1-hunter2']);
    expect(secretValues({ b: JSON.stringify(records, null, 2) })).toEqual(['row-1-hunter2']);
    expect(secretValues({ c: `\n  ${JSON.stringify(records)}` })).toEqual(['row-1-hunter2']);
  });

  it('parses one value once — `secretsNow()` asks many times per step', () => {
    // Identity, not a stopwatch: the same string gets the same frozen array
    // back, which it cannot do without the memo. Re-parsing a 500-row capture
    // cost ~0.9 ms per call, and every surface that writes anything rebuilds
    // the mask set.
    const rows = JSON.stringify(
      Array.from({ length: 200 }, (_, i) => ({ _row: String(i + 1), id: `ORD-${i}`, api_key: `ak-${i}-xxxx` })),
    );
    const first = recordSecretValues(rows);
    expect(first).toHaveLength(200);
    expect(recordSecretValues(rows)).toBe(first);
    // A different string is parsed on its own.
    expect(recordSecretValues(JSON.stringify([{ token: 'other-token' }]))).toEqual(['other-token']);
    // A value that cannot hold records is answered without parsing at all.
    expect(recordSecretValues('Alice Smith')).toEqual([]);
    expect(recordSecretValues('Alice Smith')).toBe(recordSecretValues('[not, json'));
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
