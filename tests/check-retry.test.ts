/**
 * A retry of a failed check asks the same question (steptix/steptix#97,
 * src/ai/check-retry.ts).
 *
 * Once an attempt of a step fails on a check that ran and came back false,
 * the next attempt does not ask the step AI for a new check: it runs the same
 * `assert` again with the same code, asking no AI at all. The code is written
 * anew — told what the old code read — only when the old code found no
 * element, was written for a value read again since, would change the page,
 * or breaks when it runs again, so a wrong selector can still be fixed while
 * the question and how the page is read cannot change. An `If …, then
 * return / stop / fail` line, a first check whose code failed (it threw,
 * returned the wrong shape or never parsed), and every other failure that is
 * not a check are retried as before; a re-check that came to no verdict,
 * whatever ended it, is asked again. New code for a re-check is not told
 * where the expected text is (SPEC-web-survey-fixes.md §2.25): the part it
 * reads is the one the condition names. Driven through the real
 * `executeStep` with a mocked page and scripted model replies, as the §2.25
 * case in multi-turn.test.ts is.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright';
import type { Config } from '../src/config/types.js';
import type { AiClient } from '../src/ai/client.js';
import { DEFAULT_BROWSER_DIMENSIONS } from '../src/config/browser-dimensions.js';
import { executeStep } from '../src/runner/step-executor.js';
import {
  codeToRunAgain,
  earlierCheckErrors,
  readHoldsExpected,
  recheckNote,
  recheckResponse,
  standingFailures,
} from '../src/ai/check-retry.js';
import type { PriorFailureContext } from '../src/ai/prompts.js';
import { parseFlowControlStep } from '../src/parser/flow-control-step.js';
import { checkCodeMutation } from '../src/codebehind/generate.js';
import { assertionCodeFailed } from '../src/ai/action-parser.js';

function makeConfig(retries: number): Config {
  return {
    ai: { gatewayUrl: '', model: 'test', maxInputTokens: 1000, streamResponses: false },
    browser: {
      headed: false,
      viewport: { ...DEFAULT_BROWSER_DIMENSIONS },
      windowSize: { ...DEFAULT_BROWSER_DIMENSIONS },
      slowMo: 0,
      browser: 'chromium',
      fullPageScreenshots: true,
    },
    tests: { dir: '.', contextDir: '.', pattern: '**/*.md' },
    execution: { timeout: 30000, retries, screenshotOnFailure: false, promptOnAmbiguity: false, maxTurns: 5 },
    reports: {
      outputDir: '.',
      includeScreenshots: false,
      includeDomSnapshots: false,
      includeAiReasoning: false,
      embedScreenshots: true,
    },
    api: { specsDir: '.', requestTimeout: 5000, redactSensitive: false },
  };
}

/** What each marker's check code reads, and whether the check holds. */
const READS: Record<string, { pass: boolean; actual: string }> = {
  CHECK_HOLDS: { pass: true, actual: '$42.00' },
  CHECK_FAILS: { pass: false, actual: '$40.00' },
  // Read the right place, which holds the expected text and more besides.
  CHECK_FAILS_HOLDING: { pass: false, actual: 'Total $42.00 and 3 other totals' },
  CHECK_NOT_FOUND: { pass: false, actual: 'element not found: .cart-total' },
  // A label read with its required-field mark, compared exactly.
  CHECK_FAILS_LABEL: { pass: false, actual: 'Return date *' },
  // Longer than the note quotes back, even in the error that repeats it.
  CHECK_FAILS_LONG: { pass: false, actual: 'r'.repeat(1500) },
  // What a predicate's code returns: the comparison it made.
  CHECK_PREDICATE_FALSE: { pass: false, actual: '3 >= 5 → false' },
  // An order status that is not the one expected.
  CHECK_FAILS_STATUS: { pass: false, actual: 'pending' },
};

/** What check code returns that is not `{ pass, actual }`. */
const ODD_RESULTS: Record<string, unknown> = {
  CHECK_WRONG_SHAPE: { pass: 'yes', actual: 1 },
  // Read as a boolean, "false" is truthy.
  CHECK_PASS_AS_TEXT: { pass: 'false', actual: '$40.00' },
  // A verdict, but what it read is a number, not text.
  CHECK_NUMBER_READ: { pass: false, actual: 1 },
};

/** What Playwright's `evaluate` throws for an undefined name: a stack follows its first line. */
const PLAYWRIGHT_ERROR =
  'page.evaluate: ReferenceError: total is not defined\n' +
  '    at eval (eval at evaluate (:302:30), <anonymous>:1:25)\n' +
  '    at UtilityScript.evaluate (<anonymous>:304:16)';

/**
 * A page whose checks answer by marker in their code (see {@link READS}, and
 * {@link ODD_RESULTS} for answers in the wrong shape); `CHECK_THROWS`,
 * `CHECK_THROWS_PLAYWRIGHT` and `CHECK_THROWS_LONG` (an error longer than a
 * note quotes) have no verdict, `CHECK_HOLDS_SECOND_TIME` finds nothing the
 * first time it runs and holds after, code marked `SEQ:A,B` ({@link changing})
 * answers as marker A the first time it runs and as B after, and code with no
 * marker the page knows returns `null`. `fill` and `click` are spies. No `isClosed`, as in
 * multi-turn.test.ts: the post-action settle then ends at once instead of
 * polling, in real time, a page that never changes. `places` is what the page
 * answers when asked where a text is (`describeWhereExpectedIs`), and `reads`
 * what successive `read` actions read, the last one repeating; a `null` read
 * fails.
 */
function makePage(places: Array<{ text: string; selectors: string[] }> = [], reads: Array<string | null> = ['$40.00']) {
  const fill = vi.fn().mockResolvedValue(undefined);
  const click = vi.fn().mockResolvedValue(undefined);
  const locator: Record<string, unknown> = {};
  locator['locator'] = vi.fn().mockReturnValue(locator);
  locator['first'] = vi.fn().mockReturnValue(locator);
  locator['nth'] = vi.fn().mockReturnValue(locator);
  locator['count'] = vi.fn().mockResolvedValue(1);
  locator['isVisible'] = vi.fn().mockResolvedValue(true);
  locator['click'] = click;
  locator['fill'] = fill;
  locator['clear'] = vi.fn().mockResolvedValue(undefined);
  locator['pressSequentially'] = vi.fn().mockResolvedValue(undefined);
  locator['evaluate'] = vi.fn().mockImplementation((fn: unknown) => {
    if (typeof fn !== 'function' || fn.name !== 'extractValueInPage') return Promise.resolve('$40.00');
    const read = reads.length > 1 ? reads.shift() : reads[0];
    return read === null ? Promise.reject(new Error('element is not attached')) : Promise.resolve(read);
  });
  let runsOfSecondTime = 0;
  /** How many times each `SEQ:` code has run. */
  const runsOfSeq = new Map<string, number>();
  const answer = (marker: string): Promise<unknown> | undefined => {
    if (marker in READS) return Promise.resolve(READS[marker]);
    if (marker in ODD_RESULTS) return Promise.resolve(ODD_RESULTS[marker]);
    if (marker === 'CHECK_THROWS') return Promise.reject(new Error('total is not defined'));
    if (marker === 'CHECK_THROWS_PLAYWRIGHT') return Promise.reject(new Error(PLAYWRIGHT_ERROR));
    if (marker === 'CHECK_THROWS_LONG') return Promise.reject(new Error('e'.repeat(400)));
    return undefined;
  };
  const page = {
    url: vi.fn().mockReturnValue('https://app.example.com'),
    title: vi.fn().mockResolvedValue('Basket'),
    content: vi.fn().mockResolvedValue('<html><body></body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fakepng')),
    viewportSize: vi.fn().mockReturnValue({ ...DEFAULT_BROWSER_DIMENSIONS }),
    locator: vi.fn().mockReturnValue(locator),
    $eval: vi.fn().mockResolvedValue(''),
    evaluate: vi.fn().mockImplementation((fn: unknown, arg: unknown) => {
      if (typeof fn === 'string') {
        // What code reading an element not there yet can return, then what it
        // reads once the element is there.
        if (fn.includes('/* CHECK_HOLDS_SECOND_TIME */')) {
          return Promise.resolve(runsOfSecondTime++ === 0 ? { pass: false, actual: undefined } : READS['CHECK_HOLDS']);
        }
        const seq = /\/\* SEQ:(\w+),(\w+) \*\//.exec(fn);
        if (seq !== null) {
          const runs = runsOfSeq.get(fn) ?? 0;
          runsOfSeq.set(fn, runs + 1);
          return answer(runs === 0 ? seq[1]! : seq[2]!) ?? Promise.resolve(null);
        }
        const marked = /\/\* (CHECK_\w+) \*\//.exec(fn);
        const answered = marked !== null ? answer(marked[1]!) : undefined;
        if (answered !== undefined) return answered;
        if (fn.includes('loadingIndicators')) {
          return Promise.resolve({ readyState: 'complete', loadingIndicators: [], errorMessages: [], hasModal: false });
        }
      }
      if (typeof fn === 'function' && arg !== null && typeof arg === 'object' && 'fragments' in arg) {
        return Promise.resolve(places);
      }
      return Promise.resolve(null);
    }),
    waitForSelector: vi.fn().mockResolvedValue(null),
    waitForURL: vi.fn().mockResolvedValue(null),
    waitForLoadState: vi.fn().mockResolvedValue(null),
    waitForFunction: vi.fn().mockResolvedValue(null),
    waitForTimeout: vi.fn().mockResolvedValue(null),
    goto: vi.fn().mockResolvedValue(null),
    mouse: { wheel: vi.fn().mockResolvedValue(null) },
    keyboard: { press: vi.fn().mockResolvedValue(null) },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Page;
  return { page, fill, click };
}

const step = (...actions: object[]): string => JSON.stringify({ actions, reasoning: 'scripted' });
/** The same, asking for another turn. */
const stepThenMore = (...actions: object[]): string => JSON.stringify({ actions, reasoning: 'scripted', needs_reeval: true });
const code = (marker: string): string =>
  JSON.stringify({ code: `(() => { /* ${marker} */ return { pass: false, actual: '' }; })()` });
/** Check code that answers as marker `first` the first time it runs and as
 *  `then` every time after: the page changed between attempts, as a total
 *  that updates late does. */
const changing = (first: string, then: string): string => code(`SEQ:${first},${then}`);
const check = {
  action: 'assert',
  condition: 'the basket total, and no other total',
  expected: '$42.00',
  description: 'Total is $42.00',
};
/** Check code that would change the page before it reads. */
const actingCode = JSON.stringify({
  code: "(() => { document.querySelector('#apply-discount').click(); /* CHECK_HOLDS */ return { pass: true, actual: '' }; })()",
});

/** Replies in order. A call past the script is rejected rather than cycling,
 *  which fails that call's step; tests count the calls to catch one. */
function scripted(replies: string[]): AiClient & { sent: string[] } {
  const sent: string[] = [];
  let next = 0;
  return {
    sent,
    complete: vi.fn().mockImplementation((messages: unknown) => {
      sent.push(JSON.stringify(messages));
      const text = replies[next++];
      if (text === undefined) return Promise.reject(new Error(`unscripted model call #${next}`));
      return Promise.resolve({ text, model: 'test-model' });
    }),
  } as unknown as AiClient & { sent: string[] };
}

async function run(page: Page, aiClient: AiClient, retries = 1, instruction = 'Verify the basket total is $42.00') {
  const claim = parseFlowControlStep(instruction);
  return executeStep(1, 1, instruction, {
    page,
    config: makeConfig(retries),
    aiClient,
    contextContent: '',
    testName: 'check-retry',
    conversationHistory: [],
    csrfTokens: {},
    ...(claim !== null && { flowControlClaim: claim }),
  });
}

/** Is this request one for a check's code? Told by what the step AI's prompt never says. */
const isCodeRequest = (request: string): boolean => request.includes('Write a self-executing JavaScript function');

/** The text of each message a request sent, in order. */
const messagesOf = (request: string): string[] =>
  (JSON.parse(request) as Array<{ content: unknown }>).map((m) =>
    (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

/** How many times check code carrying `marker` ran in the page. */
const evaluated = (page: Page, marker: string): number =>
  (page.evaluate as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => typeof c[0] === 'string' && c[0].includes(`/* ${marker} */`)).length;

const readTotal = { action: 'read', selector: '#total', as: 'total', description: 'Read the total' };

/** A run that stores what its reads read. */
function runReading(page: Page, aiClient: AiClient, retries = 1) {
  return executeStep(1, 1, 'Read the basket total, then verify it', {
    page,
    config: makeConfig(retries),
    aiClient,
    contextContent: '',
    testName: 'check-retry',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
  });
}

describe('a retry of a failed check asks the same question', () => {
  it('runs the failed check again, its code and all, without asking any AI, and fails again on it', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_FAILS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('failed');
    expect(result.retried).toBe(true);
    expect(result.error).toContain('Assertion failed: Total is $42.00 — expected "$42.00", got "$40.00"');
    // Two calls: the step AI once, then the code once. The retry asked no AI:
    // not the step AI, so it could not have written an easier check, and not
    // the code AI, so it could not have read the page another way.
    expect(ai.sent).toHaveLength(2);
    expect(evaluated(page, 'CHECK_FAILS')).toBe(2);
  });

  it('lets new code fix a wrong selector, for the same question', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_NOT_FOUND'), code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    // Found nothing, so it is not run again but written anew…
    expect(evaluated(page, 'CHECK_NOT_FOUND')).toBe(1);
    expect(isCodeRequest(ai.sent[2]!)).toBe(true);
    // …for the SAME question, told what the old code read and that the
    // question stays.
    expect(ai.sent[2]).toContain('the basket total, and no other total');
    expect(ai.sent[2]).toContain('An earlier attempt at this check failed');
    expect(ai.sent[2]).toContain('element not found: .cart-total');
    expect(ai.sent[2]).toContain('for the condition and the expected value given above');
    // The old code is quoted back, so the new code can differ from it.
    expect(ai.sent[2]).toContain('/* CHECK_NOT_FOUND */');
  });

  it('has the code written anew when it breaks on running again, told what it failed with', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), changing('CHECK_FAILS', 'CHECK_THROWS_PLAYWRIGHT'), code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(3);
    expect(isCodeRequest(ai.sent[2]!)).toBe(true);
    const sent = messagesOf(ai.sent[2]!);
    // How the check failed before, then the code run again as the model's own
    // reply, and what it failed with — its first line only.
    expect(sent[2]).toContain('Its code read: "$40.00"');
    expect(sent[3]).toContain('/* SEQ:CHECK_FAILS,CHECK_THROWS_PLAYWRIGHT */');
    expect(sent[4]).toContain('That code failed');
    expect(sent[4]).toContain('ReferenceError: total is not defined');
    expect(sent[4]).not.toContain('<anonymous>');
    // The report records the exchange as it was sent (steptix/steptix#70),
    // and the code run again was asked of no model.
    const recheck = result.assertions!.find((a) => a.aiInteraction?.attemptNumber === 2)!;
    expect(recheck.aiInteraction!.requestMessages!.map((m) => m.role))
      .toEqual(['system', 'user', 'user', 'assistant', 'user']);
    expect(recheck.supersededAiInteractions).toBeUndefined();
  });

  it('ends the step once the re-check passes, when the check was all the step had', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), changing('CHECK_FAILS', 'CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(2);
  });

  it('lets the step AI finish the step once the re-check passes, when it had more to do', async () => {
    const { page, click } = makePage();
    const ai = scripted([
      // "Verify the total, then click Pay": the check fails, so the click never ran.
      step(check, { action: 'click', selector: '#pay', description: 'Click Pay' }),
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      // Told the check passed, the step AI does the rest.
      step({ action: 'click', selector: '#pay', description: 'Click Pay' }),
    ]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(click).toHaveBeenCalledTimes(1);
    expect(ai.sent[2]).toContain('Verified, and it PASSED: Total is $42.00');
  });

  it('says where the text is in the failure, only when the check read the wrong place, and never to the re-check', async () => {
    const places = [{ text: '$42.00', selectors: ['#subtotal'] }];
    // Read "$40.00": the text is elsewhere on the page, and the failure says
    // where. New code for the re-check is not told: #subtotal may be another
    // total that holds it, and the part to read is the one the condition names.
    const wrongPlace = makePage(places);
    const ai1 = scripted([step(check), changing('CHECK_FAILS', 'CHECK_THROWS'), code('CHECK_FAILS')]);
    const wrong = await run(wrongPlace.page, ai1);
    expect(wrong.error).toContain('the page does show "$42.00" at #subtotal');
    expect(ai1.sent[2]).toContain('Its code read: \\"$40.00\\"');
    expect(ai1.sent[2]).not.toContain('the page does show');
    expect(ai1.sent[2]).not.toContain('#subtotal');
    expect(ai1.sent[2]).toContain('Read the part of the page the condition names, not wherever the expected text appears');

    // Read text that holds "$42.00": the right place, failing on something
    // else there, so there is nowhere smaller to point at.
    const rightPlace = makePage(places);
    const ai2 = scripted([step(check), code('CHECK_FAILS_HOLDING')]);
    const right = await run(rightPlace.page, ai2);
    expect(right.error).not.toContain('the page does show');
  });

  it('says where the text is on the page only for a check that may read the page: never for an API check', async () => {
    const places = [{ text: 'shipped', selectors: ['#status'] }];
    const shipped = {
      action: 'assert',
      against: 'api',
      condition: 'the status of the last order response',
      expected: 'shipped',
      description: 'Order status is shipped',
    };
    // An API check reads nothing on the page, so where the page shows the
    // text says nothing about what it read.
    const api = makePage(places);
    const result = await run(
      api.page,
      scripted([step(shipped), code('CHECK_FAILS_STATUS')]),
      0,
      'Verify the last order response says shipped',
    );
    expect(result.error).toContain('Assertion failed: Order status is shipped — expected "shipped", got "pending"');
    expect(result.error).not.toContain('the page does show');

    // One that may read the page or the API responses is still told.
    const either = makePage(places);
    const both = await run(
      either.page,
      scripted([step({ ...shipped, against: 'both' }), code('CHECK_FAILS_STATUS')]),
      0,
      'Verify the order status says shipped',
    );
    expect(both.error).toContain('the page does show "shipped" at #status');
  });

  it('does not run re-checked code that would change the page, and has it written again', async () => {
    const { page } = makePage();
    const acting = JSON.stringify({
      code: "(() => { document.querySelector('#apply-discount').click(); /* CHECK_HOLDS */ return { pass: true, actual: '' }; })()",
    });
    const ai = scripted([step(check), code('CHECK_NOT_FOUND'), acting, code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    // The code's own `.click()` would run inside `evaluate`, so what proves it
    // never ran is that no evaluated code carried it.
    const ran = (page.evaluate as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(ran.some((js) => js.includes('#apply-discount'))).toBe(false);
    expect(ai.sent[3]).toContain('That code would change the page (`.click(`), and was not run');
  });

  it('does not run again a failed check\'s code that would change the page, and has it written anew', async () => {
    const { page } = makePage();
    // A first check's code is not scanned, so this ran once, and came back false.
    const acting = JSON.stringify({
      code: "(() => { document.querySelector('#apply-discount').click(); /* CHECK_FAILS */ return { pass: false, actual: '' }; })()",
    });
    const ai = scripted([step(check), acting, code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    const ran = (page.evaluate as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(ran.filter((js) => js.includes('#apply-discount'))).toHaveLength(1);
    expect(isCodeRequest(ai.sent[2]!)).toBe(true);
    expect(ai.sent[2]).toContain('That code would change the page (`.click(`), so it is not run again');
    expect(ai.sent[2]).not.toContain('and was not run');
  });

  it('runs a first attempt\'s check code as it is: only a re-check\'s code is scanned', async () => {
    const { page } = makePage();
    const acting = JSON.stringify({
      code: "(() => { document.querySelector('#total').focus(); /* CHECK_HOLDS */ return { pass: true, actual: '' }; })()",
    });
    const ai = scripted([step(check), acting]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    const ran = (page.evaluate as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(ran.some((js) => js.includes("querySelector('#total').focus()"))).toBe(true);
  });

  it('runs as it is the code of a check the step AI writes after the re-check passed', async () => {
    const { page } = makePage();
    const heading = { action: 'assert', condition: 'the basket heading', expected: 'Basket', description: 'Heading says Basket' };
    const focusing = JSON.stringify({
      code: "(() => { document.querySelector('#basket').focus(); /* CHECK_HOLDS */ return { pass: true, actual: '' }; })()",
    });
    const ai = scripted([stepThenMore(check), changing('CHECK_FAILS', 'CHECK_HOLDS'), step(heading), focusing]);

    const result = await run(page, ai);

    // Not a re-check: its code is neither scanned nor told how a check failed.
    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(4);
    const ran = (page.evaluate as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(ran.some((js) => js.includes("querySelector('#basket').focus()"))).toBe(true);
    expect(isCodeRequest(ai.sent[3]!)).toBe(true);
    expect(ai.sent[3]).not.toContain('An earlier attempt at this check failed');
  });

  it('asks the same question again on every later attempt, with the same code', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_FAILS')]);

    // `retries: 2`: three attempts, an AI asked only on the first.
    const result = await run(page, ai, 2);

    expect(result.status).toBe('failed');
    expect(ai.sent).toHaveLength(2);
    expect(evaluated(page, 'CHECK_FAILS')).toBe(3);
  });

  it('gives the re-check a turn of its own: with one turn a step, the step AI still does the rest', async () => {
    const { page, click } = makePage();
    const ai = scripted([
      step(check, { action: 'click', selector: '#pay', description: 'Click Pay' }),
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      step({ action: 'click', selector: '#pay', description: 'Click Pay' }),
    ]);
    const config = makeConfig(1);
    config.execution.maxTurns = 1;

    const result = await executeStep(1, 1, 'Verify the basket total is $42.00, then click Pay', {
      page,
      config,
      aiClient: ai,
      contextContent: '',
      testName: 'check-retry',
      conversationHistory: [],
      csrfTokens: {},
    });

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(3);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('says the re-check\'s turn came on top when the step runs out of turns all the same', async () => {
    const { page } = makePage();
    const ai = scripted([
      step(check, { action: 'click', selector: '#pay', description: 'Click Pay' }),
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      // Its one turn spent, the step AI asks for another.
      stepThenMore({ action: 'click', selector: '#pay', description: 'Click Pay' }),
    ]);
    const config = makeConfig(1);
    config.execution.maxTurns = 1;

    const result = await executeStep(1, 1, 'Verify the basket total is $42.00, then click Pay', {
      page,
      config,
      aiClient: ai,
      contextContent: '',
      testName: 'check-retry',
      conversationHistory: [],
      csrfTokens: {},
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('multi-turn limit reached (1 turns, after the turn that checked again)');
  });

  it('re-checks a predicate as one: it has no expected value, and its code reads nothing', async () => {
    const atLeast = { action: 'assert', against: 'predicate', condition: '3 is at least 5', description: 'Count is at least 5' };
    const rerun = makePage();
    const same = await run(rerun.page, scripted([step(atLeast), code('CHECK_PREDICATE_FALSE')]), 1, 'Verify the count is at least 5');

    expect(same.status).toBe('failed');
    // Its failure says that the condition was false, as the report does.
    expect(same.error).toContain('Assertion failed: Count is at least 5 — predicate "3 is at least 5" was false: 3 >= 5 → false');
    expect(same.error).not.toContain('undefined');
    expect(evaluated(rerun.page, 'CHECK_PREDICATE_FALSE')).toBe(2);

    // Code written anew, after the old code broke on running again.
    const { page } = makePage();
    const ai = scripted([step(atLeast), changing('CHECK_PREDICATE_FALSE', 'CHECK_THROWS'), code('CHECK_PREDICATE_FALSE')]);
    await run(page, ai, 1, 'Verify the count is at least 5');
    expect(isCodeRequest(ai.sent[2]!)).toBe(true);
    const note = messagesOf(ai.sent[2]!)[2]!;
    expect(note).toContain('Write the code for this check again, for the condition given above');
    expect(note).toContain('read nothing from the page or from API responses');
    expect(note).toContain('Its code reported: "3 >= 5 → false"');
    expect(note).not.toContain('the expected value given above');
    expect(note).not.toContain('Read the part of the page');
    expect(note).not.toContain('__steptixNotices');
  });

  it('re-checks an API check against the API responses, not the page', async () => {
    const { page } = makePage();
    const shipped = {
      action: 'assert',
      against: 'api',
      condition: 'the status of the last order response',
      expected: 'shipped',
      description: 'Order status is shipped',
    };
    // New code: the old code broke on running again.
    const ai = scripted([step(shipped), changing('CHECK_FAILS', 'CHECK_THROWS'), code('CHECK_HOLDS')]);

    const result = await run(page, ai, 1, 'Verify the last order response says shipped');

    expect(result.status).toBe('passed');
    expect(isCodeRequest(ai.sent[2]!)).toBe(true);
    const note = messagesOf(ai.sent[2]!)[2]!;
    expect(note).toContain('for the condition and the expected value given above');
    expect(note).toContain('Take the value the condition names from the API responses');
    expect(note).not.toContain('Read the part of the page');
    expect(note).not.toContain('__steptixNotices');
  });

  it('re-checks a check that may read the page or the API responses against what the condition names in either', async () => {
    const { page } = makePage();
    const status = {
      action: 'assert',
      against: 'both',
      condition: 'the order status',
      expected: 'shipped',
      description: 'Order status is shipped',
    };
    // New code: the old code broke on running again.
    const ai = scripted([step(status), changing('CHECK_FAILS_STATUS', 'CHECK_THROWS'), code('CHECK_HOLDS')]);

    const result = await run(page, ai, 1, 'Verify the order status says shipped');

    expect(result.status).toBe('passed');
    expect(isCodeRequest(ai.sent[2]!)).toBe(true);
    const note = messagesOf(ai.sent[2]!)[2]!;
    expect(note).toContain('for the condition and the expected value given above');
    // Its code prompt lets it take the value from the API responses too, so
    // it is not told the page alone.
    expect(note).toContain('Read the part of the page, or take the value from the API responses, that the condition names');
    expect(note).toContain('searching nowhere else on the page or in the API responses for the text');
    expect(note).not.toContain('Read the part of the page the condition names');
    // It may read the page, so a notification that closed still counts.
    expect(note).toContain('__steptixNotices');
  });
});

describe('a retry of a flow-control step', () => {
  const condition = { action: 'assert', condition: 'the basket is empty', expected: '', description: 'Basket is empty' };

  it('asks the step AI again, as before: its check may be the condition or a check after an action', async () => {
    const { page } = makePage();
    const ai = scripted([step(condition), code('CHECK_FAILS'), step({ action: 'noop', description: 'The basket is not empty' })]);

    const result = await run(page, ai, 1, 'If the basket is empty, then return');

    expect(result.status).toBe('passed');
    expect(result.flowControl).toBeUndefined();
    // The retry's call is a step plan, not a re-check's code, told how the
    // check failed.
    expect(isCodeRequest(ai.sent[2]!)).toBe(false);
    expect(ai.sent[2]).toContain('Action \\"assert\\" failed: Assertion failed: Basket is empty');
  });

  it('tells the code of the check it plans again how the check failed before, as §2.25 did', async () => {
    const { page } = makePage();
    const ai = scripted([step(condition), code('CHECK_FAILS'), step(condition), code('CHECK_FAILS')]);

    await run(page, ai, 1, 'If the basket is empty, then return');

    expect(isCodeRequest(ai.sent[3]!)).toBe(true);
    expect(ai.sent[3]).toContain('An earlier attempt at this check failed');
    expect(ai.sent[3]).toContain('Do not read the same element again unless it really is what the step means');
    // Not a re-check's note: the check may ask something else.
    expect(ai.sent[3]).not.toContain('for the condition and the expected value given above');
  });

  it('runs the code of the check it plans again as it is: only a re-check\'s code is scanned', async () => {
    const { page } = makePage();
    const focusing = JSON.stringify({
      code: "(() => { document.querySelector('#basket').focus(); /* CHECK_FAILS */ return { pass: false, actual: '' }; })()",
    });
    const ai = scripted([step(condition), code('CHECK_FAILS'), step(condition), focusing]);

    await run(page, ai, 1, 'If the basket is empty, then return');

    // Not refused and written again: run as it was.
    expect(ai.sent).toHaveLength(4);
    const ran = (page.evaluate as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(ran.some((js) => js.includes("querySelector('#basket').focus()"))).toBe(true);
  });

  it('keeps telling the step AI how its check failed, however many attempts on', async () => {
    const { page } = makePage();
    const ai = scripted([
      step(condition),
      code('CHECK_FAILS'),
      // Attempt 2 fails on something else; attempt 3 plans the line again.
      step({ action: 'type', selector: '#note', value: '{{missing_note}}', description: 'Type a note' }),
      step({ action: 'noop', description: 'The basket is not empty' }),
    ]);

    const result = await run(page, ai, 2, 'If the basket is empty, then return');

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(4);
    // Never re-checked, so its failure is never answered: it is still told.
    expect(ai.sent[3]).toContain('Assertion failed: Basket is empty');
  });

  it('keeps telling the code of the check it plans again how the check failed, however many attempts on', async () => {
    const { page } = makePage();
    const ai = scripted([
      step(condition),
      code('CHECK_FAILS'),
      // Attempt 2 fails on something else; attempt 3 plans the line again.
      step({ action: 'type', selector: '#note', value: '{{missing_note}}', description: 'Type a note' }),
      step(condition),
      code('CHECK_FAILS'),
    ]);

    await run(page, ai, 2, 'If the basket is empty, then return');

    expect(ai.sent).toHaveLength(5);
    expect(isCodeRequest(ai.sent[4]!)).toBe(true);
    // Never re-checked, so its failure still stands two attempts on.
    expect(ai.sent[4]).toContain('An earlier attempt at this check failed');
    expect(ai.sent[4]).toContain('Assertion failed: Basket is empty');
  });

  it('fails a check after an action that fails twice — it is not taken for the condition', async () => {
    const { page, click } = makePage();
    const toast = { action: 'assert', condition: 'the toast text', expected: 'Saved', description: 'Toast says Saved' };
    const ai = scripted([
      step({ action: 'click', selector: '#save', description: 'Click Save' }, toast, { action: 'return', description: 'Saved' }),
      code('CHECK_FAILS'),
      step(toast, { action: 'return', description: 'Saved' }),
      code('CHECK_FAILS'),
    ]);

    const result = await run(page, ai, 1, 'If the Save button is visible, click it, verify the page says Saved, then return');

    expect(result.status).toBe('failed');
    expect(ai.sent).toHaveLength(4);
    expect(result.flowControl).toBeUndefined();
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('what a re-check carries from the attempt before it', () => {
  it('re-checks only the check the attempt just before failed on', async () => {
    const { page, click } = makePage();
    const ai = scripted([
      // Attempt 1: the check fails before the click.
      step(check, { action: 'click', selector: '#pay', description: 'Click Pay' }),
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      // Attempt 2: the re-check passes, then the rest of the step fails on a
      // value the run does not have — not a check.
      step({ action: 'type', selector: '#note', value: '{{missing_note}}', description: 'Type a note' }),
      // Attempt 3: retried as after any other failure, by the step AI.
      step({ action: 'click', selector: '#pay', description: 'Click Pay' }),
    ]);

    const result = await run(page, ai, 2);

    expect(result.status).toBe('passed');
    expect(isCodeRequest(ai.sent[3]!)).toBe(false);
    expect(ai.sent[3]).toContain('Retry Attempt 3');
    // Told of the failure that stands, not of the check its re-check passed.
    expect(ai.sent[3]).toContain('missing_note');
    expect(ai.sent[3]).not.toContain('Assertion failed: Total is $42.00');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('still tells the step AI it is a retry when the only failure recorded was answered since', async () => {
    const { page } = makePage();
    const ai = scripted([
      stepThenMore(check),
      // Attempt 2: the re-check passes, then a reply that does not parse ends
      // the attempt without recording why.
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      'not a plan',
      // Attempt 3 plans the step again.
      step({ action: 'noop', description: 'Nothing is left to do' }),
    ]);

    const result = await run(page, ai, 2);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(4);
    expect(ai.sent[3]).toContain('Retry Attempt 3');
    expect(ai.sent[3]).not.toContain('Assertion failed: Total is $42.00');
  });

  it('tells a check written again after its re-check passed nothing of how it failed', async () => {
    const { page } = makePage();
    const ai = scripted([
      step(check, { action: 'click', selector: '#pay', description: 'Click Pay' }),
      // Attempt 2: the re-check passes, then the step fails on something else.
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      step({ action: 'type', selector: '#note', value: '{{missing_note}}', description: 'Type a note' }),
      // Attempt 3 plans the step again, and checks the total again.
      step(check, { action: 'click', selector: '#pay', description: 'Click Pay' }),
      code('CHECK_HOLDS'),
    ]);

    const result = await run(page, ai, 2);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(5);
    expect(isCodeRequest(ai.sent[4]!)).toBe(true);
    expect(ai.sent[4]).not.toContain('An earlier attempt at this check failed');
  });

  it('tells the step AI what the failed attempt already did, once the re-check passes', async () => {
    const { page, click } = makePage();
    const ai = scripted([
      // `needs_reeval`: the step has more to do after the check.
      stepThenMore({ action: 'click', selector: '#add', description: 'Click Add' }, check),
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      step({ action: 'noop', description: 'Nothing is left to do' }),
    ]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(click).toHaveBeenCalledTimes(1);
    expect(ai.sent[2]).toContain('Click Add');
    expect(ai.sent[2]).toContain('Verified, and it PASSED: Total is $42.00');
  });

  it('tells the step AI which checks the failed attempt had passed, and does not ask them again', async () => {
    const { page } = makePage();
    const heading = { action: 'assert', condition: 'the basket heading', expected: 'Basket', description: 'Heading says Basket' };
    const ai = scripted([
      stepThenMore(heading, check),
      code('CHECK_HOLDS'),
      // Attempt 2 re-checks only the total.
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      step({ action: 'noop', description: 'Nothing is left to do' }),
    ]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(4);
    expect(evaluated(page, 'CHECK_HOLDS')).toBe(1);
    expect(ai.sent[3]).toContain('Verified, and it PASSED: Heading says Basket');
    expect(ai.sent[3]).toContain('Verified, and it PASSED: Total is $42.00');
  });

  it('resolves a placeholder in the re-sent check again', async () => {
    const { page } = makePage();
    const ai = scripted([step({ ...check, expected: '{{total}}' }), changing('CHECK_FAILS', 'CHECK_HOLDS')]);

    const result = await executeStep(1, 1, 'Verify the basket total is {{total}}', {
      page,
      config: makeConfig(1),
      aiClient: ai,
      contextContent: '',
      testName: 'check-retry',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: { total: '$42.00' },
    });

    expect(result.status).toBe('passed');
    // Looked up again as the same value, so the code written for it runs again.
    expect(ai.sent).toHaveLength(2);
    expect(ai.sent[1]).toContain('Expected: $42.00');
    // Sent again as the model wrote it, so the value is looked up again.
    const recheck = result.turns
      .filter((t) => t.attemptNumber === 2)
      .flatMap((t) => t.subActions)
      .find((sub) => sub.action.action === 'assert');
    expect(recheck?.action.expected).toBe('{{total}}');
  });

  it('reads again first a value the step stored since an action last changed the page', async () => {
    // The total was read before the page had finished updating.
    const { page } = makePage([], ['$40.00', '$42.00']);
    const ai = scripted([
      stepThenMore(readTotal),
      step({ ...check, expected: '{{total}}' }),
      code('CHECK_FAILS'),
      code('CHECK_HOLDS'),
    ]);

    const result = await runReading(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent[2]).toContain('Expected: $40.00');
    // Read again before the re-check, which compares against what the page
    // shows now. The code written for "$40.00" holds that value, so it is
    // not run again but written anew.
    expect(evaluated(page, 'CHECK_FAILS')).toBe(1);
    expect(isCodeRequest(ai.sent[3]!)).toBe(true);
    expect(ai.sent[3]).toContain('Expected: $42.00');
    expect(ai.sent[3]).toContain('An earlier attempt at this check failed');
  });

  it('lists a value read again once in what the step has done, when it goes on', async () => {
    const { page } = makePage([], ['$40.00', '$42.00']);
    const ai = scripted([
      stepThenMore(readTotal),
      stepThenMore({ ...check, expected: '{{total}}' }),
      code('CHECK_FAILS'),
      code('CHECK_HOLDS'),
      step({ action: 'noop', description: 'Nothing is left to do' }),
    ]);

    const result = await runReading(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(5);
    expect(ai.sent[4]!.split('Read the total')).toHaveLength(2);
  });

  it('lists a value read again once in what the step has done, after a re-check that fails again', async () => {
    const { page } = makePage([], ['$40.00', '$41.00', '$42.00']);
    const ai = scripted([
      stepThenMore(readTotal),
      stepThenMore({ ...check, expected: '{{total}}' }),
      code('CHECK_FAILS'),
      // Attempt 2's re-check fails again; attempt 3's passes and goes on.
      code('CHECK_FAILS'),
      code('CHECK_HOLDS'),
      step({ action: 'noop', description: 'Nothing is left to do' }),
    ]);

    const result = await runReading(page, ai, 2);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(6);
    expect(ai.sent[5]!.split('Read the total')).toHaveLength(2);
  });

  it('does not read again a value stored before an action that may have changed the page', async () => {
    // "Read the total, click Add, verify the total": read again after the
    // click, the total from before it would be lost.
    const { page, click } = makePage([], ['$40.00', '$42.00']);
    const ai = scripted([
      stepThenMore(readTotal, { action: 'click', selector: '#add', description: 'Click Add' }),
      step({ ...check, expected: '{{total}}' }),
      code('CHECK_FAILS'),
    ]);

    const result = await runReading(page, ai);

    expect(result.status).toBe('failed');
    // Not read again, the value is the same, so the code written for it runs again.
    expect(ai.sent).toHaveLength(3);
    expect(evaluated(page, 'CHECK_FAILS')).toBe(2);
    expect(click).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('expected "$40.00"');
  });

  it('quotes to a re-check only its own check\'s failures, and nothing to a check a later turn wrote', async () => {
    const { page } = makePage();
    const orders = { action: 'assert', condition: 'the order count', expected: '3 orders', description: 'Order count is 3' };
    const ai = scripted([
      // Attempt 1: the total check fails, with more to do after it.
      stepThenMore(check),
      // Attempt 2: its re-check passes; the step AI then writes another
      // check, which fails on its own, finding nothing.
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      step(orders),
      code('CHECK_NOT_FOUND'),
      // Attempt 3: that other check is re-checked, with new code.
      code('CHECK_HOLDS'),
    ]);

    const result = await run(page, ai, 2);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(5);
    // A check the step AI wrote on a later turn asks something else: it is
    // told nothing about the check that failed before it.
    expect(isCodeRequest(ai.sent[3]!)).toBe(true);
    expect(ai.sent[3]).not.toContain('An earlier attempt at this check failed');
    // Its re-check hears its own failure, not the total check's.
    expect(isCodeRequest(ai.sent[4]!)).toBe(true);
    expect(ai.sent[4]).toContain('the order count');
    expect(ai.sent[4]).toContain('element not found: .cart-total');
    expect(ai.sent[4]).not.toContain('got \\"$40.00\\"');
  });

  it('re-checks again after a re-check that came to no verdict', async () => {
    const { page } = makePage();
    const breaking = changing('CHECK_FAILS', 'CHECK_THROWS_PLAYWRIGHT');
    const ai = scripted([
      step(check), breaking,
      // Attempt 2: the code run again throws, and so does the code written
      // anew — no verdict.
      code('CHECK_THROWS_PLAYWRIGHT'),
      // Attempt 3 asks the same question again, not the step AI. The code
      // that came back false runs again first — what ended attempt 2 may not
      // have been the code — and throws again, so it is written anew.
      code('CHECK_HOLDS'),
    ]);

    const result = await run(page, ai, 2);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(4);
    expect(ai.sent.slice(1).every(isCodeRequest)).toBe(true);
    expect(evaluated(page, 'SEQ:CHECK_FAILS,CHECK_THROWS_PLAYWRIGHT')).toBe(3);
    // The failure the attempt with no verdict carried on is quoted once, and
    // why that re-check came to no verdict is said.
    expect(ai.sent[3]!.split('Its code read:')).toHaveLength(2);
    expect(ai.sent[3]).toContain('Asked again, it came to no verdict');
    expect(ai.sent[3]).toContain('ReferenceError: total is not defined');
    // Its first line only: the stack says nothing to the next code.
    expect(ai.sent[3]).not.toContain('<anonymous>');
    // That attempt asked no model for a plan and recorded no action, and the
    // report still shows it.
    expect(result.turns.some((t) => t.attemptNumber === 2)).toBe(true);
  });

  it('re-checks again after a re-check whose code would change the page both times', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_NOT_FOUND'), actingCode, actingCode, code('CHECK_HOLDS')]);

    const result = await run(page, ai, 2);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(5);
    expect(ai.sent.slice(1).every(isCodeRequest)).toBe(true);
  });

  it('re-checks again after a re-check whose value to read again could not be read', async () => {
    const { page } = makePage([], ['$40.00', null, '$42.00']);
    const ai = scripted([
      stepThenMore(readTotal),
      step({ ...check, expected: '{{total}}' }),
      code('CHECK_FAILS'),
      // Attempt 2 fails reading the total again, before its check runs.
      // Attempt 3 reads it and re-checks.
      code('CHECK_HOLDS'),
    ]);

    const result = await runReading(page, ai, 2);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(4);
    expect(ai.sent[3]).toContain('Expected: $42.00');
  });

  it('lets new code compare the right part as the requirements say, with no pointer elsewhere', async () => {
    // The first code compared the label with its required-field mark; the
    // label is right, and the page shows "Return date" nowhere smaller.
    const { page } = makePage([{ text: 'Return date', selectors: ['label#return'] }]);
    const label = {
      action: 'assert',
      condition: 'the label of the return date field',
      expected: 'Return date',
      description: 'Field is labelled Return date',
    };
    // New code: the old code broke on running again.
    const ai = scripted([step(label), changing('CHECK_FAILS_LABEL', 'CHECK_THROWS'), code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent[2]).toContain('If it read that part, read it again and compare it as the requirements above say');
    expect(ai.sent[2]).not.toContain('the page does show');
  });

  it('records in the report every message the re-check\'s code AI was sent', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_NOT_FOUND'), actingCode, code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    const recheck = result.assertions!.find((a) => a.aiInteraction?.attemptNumber === 2)!;
    // The system prompt, the check, how it failed, then the refused reply and why.
    const sent = recheck.aiInteraction!.requestMessages!;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'user']);
    expect(sent[2]!.content).toContain('An earlier attempt at this check failed');
    expect(sent[4]!.content).toContain('That code would change the page');
    const refused = recheck.supersededAiInteractions![0]!;
    expect(refused.requestMessages!.map((m) => m.role)).toEqual(['system', 'user', 'user']);
  });

  it('fails the step when the re-check\'s code would change the page both times', async () => {
    const { page } = makePage();
    const acting = actingCode;
    const ai = scripted([step(check), code('CHECK_NOT_FOUND'), acting, acting]);

    const result = await run(page, ai);

    expect(result.status).toBe('failed');
    expect(ai.sent).toHaveLength(4);
    expect(result.error).toContain('would change the page');
    const ran = (page.evaluate as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(ran.some((js) => js.includes('#apply-discount'))).toBe(false);
  });

  it('tells the step AI that what the failed attempt did was done before this attempt', async () => {
    const { page } = makePage();
    const ai = scripted([
      stepThenMore({ action: 'click', selector: '#add', description: 'Click Add' }, check),
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      step({ action: 'noop', description: 'Nothing is left to do' }),
    ]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    // This attempt's one turn only checked again; the click was the attempt before's.
    expect(messagesOf(ai.sent[2]!)[1]).toContain(
      'Actions completed before this attempt:\n  - Click Add\n\n' +
        'Actions completed so far (turns 1–1):\n  - Verified, and it PASSED: Total is $42.00',
    );
  });

  it('reads a value read twice again where its later read ran', async () => {
    // The total, then the subtotal, then the total again.
    const { page } = makePage([], ['$40.00', '$1.00', '$41.00', '$2.00', '$42.00']);
    const readSubtotal = { action: 'read', selector: '#subtotal', as: 'subtotal', description: 'Read the subtotal' };
    const ai = scripted([
      stepThenMore(readTotal, readSubtotal),
      stepThenMore(readTotal),
      step({ ...check, expected: '{{total}}' }),
      code('CHECK_FAILS'),
      code('CHECK_HOLDS'),
    ]);

    const result = await runReading(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent[3]).toContain('Expected: $41.00');
    // Read again in the order they last ran — the subtotal, then the total —
    // so the total holds the last value read.
    expect(isCodeRequest(ai.sent[4]!)).toBe(true);
    expect(ai.sent[4]).toContain('Expected: $42.00');
  });

  it('quotes once a failure that came back the same', async () => {
    const { page } = makePage();
    // `retries: 2`: the re-check's new code is the first code again, and finds
    // nothing the same way, so attempt 3 has one failure to quote, recorded
    // twice.
    const ai = scripted([step(check), code('CHECK_NOT_FOUND'), code('CHECK_NOT_FOUND'), code('CHECK_HOLDS')]);

    const result = await run(page, ai, 2);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(4);
    expect(ai.sent[3]!.split('Its code read:')).toHaveLength(2);
  });

  it('quotes to a re-check nothing of a check that differs from it only in its expected value', async () => {
    const { page } = makePage();
    const other = { ...check, expected: '$41.00' };
    const ai = scripted([
      // Attempt 1: the check fails, with more to do after it.
      stepThenMore(check),
      // Attempt 2: its re-check passes; the step AI then checks the same total
      // for another value, which fails on its own, finding nothing.
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      step(other),
      code('CHECK_NOT_FOUND'),
      // Attempt 3 re-checks that one, with new code.
      code('CHECK_HOLDS'),
    ]);

    const result = await run(page, ai, 2);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(5);
    expect(isCodeRequest(ai.sent[4]!)).toBe(true);
    expect(ai.sent[4]).toContain('Expected: $41.00');
    expect(ai.sent[4]).toContain('element not found: .cart-total');
    expect(ai.sent[4]).not.toContain('got \\"$40.00\\"');
  });

  it('lists a check the failed attempt passed once, as a check that passed', async () => {
    const { page } = makePage();
    const heading = { action: 'assert', condition: 'the basket heading', expected: 'Basket', description: 'Heading says Basket' };
    const ai = scripted([
      stepThenMore(heading, check),
      code('CHECK_HOLDS'),
      changing('CHECK_FAILS', 'CHECK_HOLDS'),
      step({ action: 'noop', description: 'Nothing is left to do' }),
    ]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(4);
    expect(ai.sent[3]!.split('Heading says Basket')).toHaveLength(2);
    expect(ai.sent[3]).toContain('Verified, and it PASSED: Heading says Basket');
  });

  it('quotes at most so much of the old error, what its code read, and the code', async () => {
    const { page } = makePage();
    // New code: the old code broke on running again.
    const longCode = JSON.stringify({
      code: `(() => { /* SEQ:CHECK_FAILS_LONG,CHECK_THROWS */ const pad = '${'p'.repeat(2500)}'; return { pass: false, actual: pad }; })()`,
    });
    const ai = scripted([step(check), longCode, code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    const lines = messagesOf(ai.sent[2]!)[2]!.split('\n');
    const error = lines.find((l) => l.startsWith('- Assertion failed'))!;
    const read = lines.find((l) => l.startsWith('  Its code read: '))!;
    const oldCode = lines.find((l) => l.startsWith('  Its code: '))!;
    // The error repeats the read, so it may be twice as long.
    expect(error).toBe(`- ${'Assertion failed: Total is $42.00 — expected "$42.00", got "'.concat('r'.repeat(1500)).slice(0, 1000)}…`);
    expect(read).toBe(`  Its code read: ${JSON.stringify(`${'r'.repeat(500)}…`)}`);
    expect(oldCode).toBe(`  Its code: ${JSON.parse(longCode).code.slice(0, 2000)}…`);
  });
});

describe('what check code is asked to do', () => {
  it('asks every check\'s code to only read, and to return what it read as it read it', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_HOLDS')]);

    await run(page, ai);

    // A first check's code (index 1), not only a re-check's.
    expect(ai.sent[1]).toContain('`actual` being what the code read, as it read it');
    expect(ai.sent[1]).toContain('Only read: never click, type, focus, scroll, submit, dispatch events or change the DOM');
  });

  it("asks every check's code to read only the part the condition names, and only what a person sees there", async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_HOLDS')]);

    await run(page, ai);

    // A first check's code (index 1), not only a re-check's
    // (SPEC-verify-checks.md, section 7).
    const sent = ai.sent[1]!;
    expect(sent).toContain('Read the part of the page the condition names');
    expect(sent).toContain('and nothing beyond it: not another row, not another section');
    expect(sent).toContain('what that part shows decides the check');
    // How to read only what is shown is the AI's to work out; it is told the
    // reads that hold more, each seen in a real run: script code through
    // `textContent`, a hidden element's own `innerText`, and a dropdown option
    // nobody chose.
    expect(sent).toContain('Read only what a person sees there');
    expect(sent).toContain("an element's `textContent` holds both");
    expect(sent).toContain('an element that is itself hidden (`display: none`) still hands back its text from `innerText`');
    expect(sent).toContain('hold every option, chosen or not');
    expect(sent).not.toContain("el.textContent.includes('Alice')");
  });
});

describe('letter case in checks', () => {
  it('tells the code AI that letter case counts unless the condition says to ignore it', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_HOLDS')]);

    await run(page, ai);

    expect(ai.sent[1]).toContain('Letter case counts');
    expect(ai.sent[1]).toContain('ignoring letter case');
    // Text CSS shows in another case counts in either, and hidden markup in
    // neither — left out by reading, which a re-check's scan lets through.
    expect(ai.sent[1]).toContain('text-transform');
    expect(ai.sent[1]).toContain('checkVisibility({ visibilityProperty: true })');
    expect(ai.sent[1]).toContain('rather than remove hidden parts from a copy');
  });

  it('tells the code AI to compare both ways round when ignoring case, and which text the markup leaves out', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_HOLDS')]);

    await run(page, ai);

    // In lower case alone, "Hauptstraße" is not "HAUPTSTRASSE". The texts
    // "match" rather than the check "passes": a "not" condition fails on a match.
    expect(ai.sent[1]).toContain('compare both sides in lower case and both in upper case: the texts match if either comparison does');
    // A live run's check lowered the markup too, which would pass "Express
    // Courier" on markup written "Express courier": the markup keeps its case.
    expect(ai.sent[1]).toContain('the text matches in the case shown and in its markup\'s case, and in no other');
    expect(ai.sent[1]).toContain('Compare the markup with letter case kept: never lower- or upper-case it');
    // Text a page does not show as text is no part of the markup it shows.
    expect(ai.sent[1]).toContain(
      'text nodes that are not inside a `textarea`, `canvas`, `video`, `audio`, `iframe`, `object`, `progress` or `meter`',
    );
  });

  it('tells the step AI to keep how to compare in the condition, add no way of its own, and copy quoted values', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_HOLDS')]);

    await run(page, ai);

    // Seen in three runs: "says" became "says exactly", and the re-check,
    // asking the same question, failed again. The third came after the rule
    // said to add none, so it now shows the condition for an invented step.
    expect(ai.sent[0]).toContain('and add none it does not use');
    expect(ai.sent[0]).toContain('asks whether the part holds it, not whether that is all it holds');
    expect(ai.sent[0]).toContain('\\"condition\\" is \\"the banner says\\", not \\"the banner says exactly\\"');
    expect(ai.sent[0]).toContain('letter case included');
    expect(ai.sent[0]).toContain('unless the instruction says to ignore it, letter case counts');
  });
});

describe('failures that are not a check that came back false', () => {
  it('retry as before: a check whose code threw has no verdict', async () => {
    const { page, click } = makePage();
    const ai = scripted([
      step(check), code('CHECK_THROWS'), code('CHECK_THROWS'),
      step({ action: 'click', selector: '#refresh', description: 'Refresh the totals' }),
    ]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(click).toHaveBeenCalled();
    // The thrown check recorded no failure, so the step is planned afresh, as
    // before: no retry section nudging it to do something else.
    expect(ai.sent[3]).not.toContain('Retry Attempt');
  });

  it('tells the code AI what its code failed with, when it asks for that code again', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_THROWS'), code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent).toHaveLength(3);
    // The second request quotes the code that threw, and what it threw.
    expect(ai.sent[2]).toContain('/* CHECK_THROWS */');
    expect(ai.sent[2]).toContain('That code failed');
    expect(ai.sent[2]).toContain('total is not defined');
    // The first request had nothing to quote.
    expect(ai.sent[1]).not.toContain('That code failed');
  });

  it('quotes at most 300 characters of the first line of what the code failed with', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_THROWS_LONG'), code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    const told = messagesOf(ai.sent[2]!).at(-1)!;
    expect(/^That code failed: (.*)\. Write it again/.exec(told)?.[1]).toBe(`${`Error: ${'e'.repeat(400)}`.slice(0, 300)}…`);
  });

  it('tells it the same when its code returned something other than { pass, actual }', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_WRONG_SHAPE'), code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent[2]).toContain('That code failed');
    expect(ai.sent[2]).toContain('unexpected shape');
  });

  it('quotes only the first line of an error, and sends the code back as the model\'s own reply', async () => {
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_THROWS_PLAYWRIGHT'), code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    expect(ai.sent[2]).toContain('ReferenceError: total is not defined');
    expect(ai.sent[2]).not.toContain('<anonymous>');
    // The report records the exchange as it was sent (steptix/steptix#70).
    const assertion = result.assertions![0]!;
    const sent = assertion.aiInteraction!.requestMessages!;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[2]!.content).toContain('/* CHECK_THROWS_PLAYWRIGHT */');
    expect(sent[3]!.content).toContain('That code failed');
    expect(assertion.supersededAiInteractions).toHaveLength(1);
  });

  it('polls a check on with the same code while it finds nothing yet', async () => {
    const { page } = makePage();
    // A short interval under a generous ceiling: the check holds the second time it runs.
    const polled = { ...check, poll: { timeoutMs: 30000, intervalMs: 1 } };
    const ai = scripted([step(polled), code('CHECK_HOLDS_SECOND_TIME')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    // `{ pass: false, actual: undefined }` is not a verdict yet: the poll ran
    // the same code again rather than end and ask for new code.
    expect(ai.sent).toHaveLength(2);
    expect(evaluated(page, 'CHECK_HOLDS_SECOND_TIME')).toBe(2);
  });

  it('stops polling at a result that is not an object, rather than throw on it', async () => {
    const { page } = makePage();
    const polled = { ...check, poll: { timeoutMs: 1000 } };
    const returnsNull = JSON.stringify({ code: '(() => { /* RETURNS_NULL */ return null; })()' });
    const ai = scripted([step(polled), returnsNull, code('CHECK_HOLDS')]);

    const result = await run(page, ai);

    expect(result.status).toBe('passed');
    // Run once: polling `null` on would come to nothing more.
    expect(evaluated(page, 'RETURNS_NULL')).toBe(1);
    // Told what it returned, not an error of the poll's own.
    expect(ai.sent[2]).toContain('unexpected shape: null');
    expect(ai.sent[2]).not.toContain('Cannot read properties');
  });

  it('never takes a result in the wrong shape for a verdict, when the last code fails too', async () => {
    // `pass: "false"` is truthy: kept past the attempt that rejected it, it
    // passed the check once the next code threw.
    const { page } = makePage();
    const ai = scripted([step(check), code('CHECK_PASS_AS_TEXT'), code('CHECK_THROWS')]);

    const result = await run(page, ai, 0);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Assertion code failed after 2 attempts');
  });

  it('comes to no verdict, not to a crash, when its code returns the wrong shape twice', async () => {
    const { page } = makePage();
    // A number for what it read once crashed the gate that decides on the
    // section-2.25 hint (`read.trim`).
    const ai = scripted([step(check), code('CHECK_NUMBER_READ'), code('CHECK_NUMBER_READ')]);

    const result = await run(page, ai, 0);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('unexpected shape');
  });

  it('retry as before: an action that failed', async () => {
    const { page, click } = makePage();
    const ai = scripted([
      // Attempt 1 fails on a reference the run does not have — not a check.
      step({ action: 'type', selector: '#name', value: '{{missing_name}}', description: 'Type the name' }),
      step({ action: 'click', selector: '#go', description: 'Click Go' }),
    ]);

    const result = await run(page, ai, 1, 'Click Go');

    expect(result.status).toBe('passed');
    expect(click).toHaveBeenCalled();
  });
});

describe('check-retry helpers', () => {
  it('readHoldsExpected sets letter case aside and collapses spacing', () => {
    expect(readHoldsExpected('Harbour Plumbing,  Northside Dental', 'Northside Dental')).toBe(true);
    // Differing only in letter case, the check most likely read the right
    // place: what is wrong there is the case itself, and pointing elsewhere
    // would invite an easier check. (It was compared with case kept before,
    // which pointed a strict check at any other element showing the step's
    // capitals.)
    expect(readHoldsExpected('Payment received', 'Payment Received')).toBe(true);
    expect(readHoldsExpected('ADA DENTAL, BOB GLAZING', 'Ada Dental')).toBe(true);
    expect(readHoldsExpected('Total\n   $42.00', 'Total $42.00')).toBe(true);
    expect(readHoldsExpected('anything', undefined)).toBe(false);
    expect(readHoldsExpected('anything', '')).toBe(false);
    // Found nothing: its selector naming the text is no read of it.
    expect(readHoldsExpected('element not found: [aria-label="Close"]', 'Close')).toBe(false);
  });

  it('readHoldsExpected compares in upper case too: "ß" upper-cases to "SS"', () => {
    expect(readHoldsExpected('HAUPTSTRASSE 5', 'Hauptstraße 5')).toBe(true);
    expect(readHoldsExpected('Hauptstraße 5', 'HAUPTSTRASSE 5')).toBe(true);
  });

  it('codeToRunAgain gives back code that read the page and answered, for the same condition and expected value', () => {
    const now = { condition: 'the basket total', expected: '$42.00' };
    const failed = { read: '$40.00', code: 'CODE', resolved: now };
    expect(codeToRunAgain(failed, now)).toBe('CODE');
    // Found nothing: a wrong selector, for new code to fix.
    expect(codeToRunAgain({ ...failed, read: 'element not found: .cart-total' }, now)).toBeUndefined();
    expect(codeToRunAgain({ ...failed, read: '  Element not found: #x' }, now)).toBeUndefined();
    // Read something that mentions it, not a report of finding nothing.
    expect(codeToRunAgain({ ...failed, read: 'No element not found here' }, now)).toBe('CODE');
    expect(codeToRunAgain({ ...failed, code: undefined }, now)).toBeUndefined();
    expect(codeToRunAgain({ ...failed, code: '  ' }, now)).toBeUndefined();
    // Resolved again to something else: the code holds the old value.
    expect(codeToRunAgain(failed, { ...now, expected: '$41.00' })).toBeUndefined();
    expect(codeToRunAgain(failed, { ...now, condition: 'the order total' })).toBeUndefined();
    // A predicate has no expected value.
    const predicate = { condition: '3 is at least 5', expected: undefined };
    expect(codeToRunAgain({ ...failed, resolved: predicate }, { ...predicate })).toBe('CODE');
  });

  it('earlierCheckErrors leaves out a check a re-check passed, and says each failure once', () => {
    const failed = (attempt: number, error: string, action: object = check): PriorFailureContext =>
      ({ selector: '', actionType: 'assert', error, check: { action, read: '', hadMore: false, attempt, done: [], rereads: [] } }) as unknown as PriorFailureContext;
    const clickFailed = { selector: '#pay', actionType: 'click', error: 'Click failed' } as PriorFailureContext;
    // Attempt 1's check failed; attempt 2 re-checked it and it passed, then
    // failed on a click. The check read the right element after all.
    expect(earlierCheckErrors([failed(1, 'A'), clickFailed], 3, true)).toEqual([]);
    // Re-checked and failed again: still unanswered, and said once.
    expect(earlierCheckErrors([failed(1, 'A'), failed(2, 'A')], 3, true)).toEqual(['A']);
    // An `If …, then …` line never re-checks: each failed check counts.
    const other = { ...check, description: 'Order count is 3' };
    expect(earlierCheckErrors([failed(1, 'A'), failed(2, 'B', other)], 3, false)).toEqual(['A', 'B']);
    // Failed at 1, failed again at 2, passed at 3, then a click failed: by
    // attempt 4 none of it stands.
    expect(earlierCheckErrors([failed(1, 'A'), failed(2, 'A2'), clickFailed], 4, true)).toEqual([]);
  });

  it('standingFailures keeps a check still being asked, and every failure of an If-line', () => {
    const failed = (attempt: number, noVerdict?: string): PriorFailureContext =>
      ({
        selector: '',
        actionType: 'assert',
        error: 'A',
        check: { action: check, read: '$40.00', hadMore: false, attempt, done: [], rereads: [], ...(noVerdict && { noVerdict }) },
      }) as unknown as PriorFailureContext;
    // Last recorded at attempt 2, so attempt 3 is the one asking it again.
    expect(standingFailures([failed(1), failed(2, 'Assertion code failed')], 3, true)).toHaveLength(2);
    // An `If …, then …` line is never re-checked, so nothing it recorded is answered.
    expect(standingFailures([failed(1), failed(2)], 4, false)).toHaveLength(2);
  });

  it('recheckResponse sends the failed check unchanged, and asks for another turn only when the step had more', () => {
    const failed = { action: { ...check }, read: '$40.00', hadMore: false, rereads: [] } as unknown as Parameters<typeof recheckResponse>[0];
    expect(recheckResponse(failed).actions).toEqual([check]);
    expect(recheckResponse(failed).needs_reeval).toBeUndefined();
    expect(recheckResponse({ ...failed, hadMore: true }).needs_reeval).toBe(true);
    // Reads to do again come first, in the order they ran.
    const rereads = [readTotal] as unknown as Parameters<typeof recheckResponse>[0]['rereads'];
    expect(recheckResponse({ ...failed, rereads }).actions).toEqual([readTotal, check]);
  });

  it('recheckNote quotes the old code and what it read, and keeps the question', () => {
    const note = recheckNote([{ error: 'Assertion failed: X', read: '$40.00', code: '(() => 1)()' }]);
    expect(note).toContain('- Assertion failed: X');
    expect(note).toContain('Its code read: "$40.00"');
    expect(note).toContain('Its code: (() => 1)()');
    expect(note).toContain('drop no part of it');
    // A right read compared wrongly may be compared again, as the requirements
    // say — which search for the text only inside the part the condition
    // names — but not by searching anywhere else on the page.
    expect(note).toContain('compare it as the requirements above say, searching nowhere else on the page for the text');
    // What that part holds decides the check — a "no longer shown" check too.
    expect(note).toContain('What that part holds decides the check');
    // Which part is the condition's to say, not where the expected text shows.
    expect(note).toContain('Read the part of the page the condition names, not wherever the expected text appears');
    // Reading the notices log is not the search it rules out.
    expect(note).toContain('window.__steptixNotices');
  });

  it('assertionCodeFailed quotes an error\'s first line, with one full stop', () => {
    const note = assertionCodeFailed('Error: "#a b" is not a valid selector.\n    at evaluate (<anonymous>:1:5)');
    expect(note).toContain('That code failed: Error: "#a b" is not a valid selector. Write it again');
    expect(note).not.toContain('..');
    expect(note).not.toContain('<anonymous>');
    // The error need not be the code's: whatever in the code caused it, if anything.
    expect(note).toContain('fixing whatever in the code made it fail');
  });

  it('checkCodeMutation names a page change and ignores comments', () => {
    expect(checkCodeMutation("(() => { document.querySelector('#go').click(); return { pass: true, actual: '' }; })()")).toBe('.click(');
    expect(checkCodeMutation("(() => { /* never .click() */ return { pass: true, actual: '' }; })()")).toBeUndefined();
  });

  it('checkCodeMutation reads a regex after `throw` as a regex, so its `/*` hides nothing after it', () => {
    expect(checkCodeMutation(String.raw`(() => { if (!el) throw /a\/*b/; el.click(); })()`)).toBe('.click(');
  });

  it('checkCodeMutation catches a scroll, a method called through call, apply or bind, and one named in brackets', () => {
    const doing = (body: string): string =>
      `(() => { const el = document.querySelector('#item'); ${body} return { pass: true, actual: '' }; })()`;
    expect(checkCodeMutation(doing('window.scroll(0, 0);'))).toBe('.scroll(');
    expect(checkCodeMutation(doing('el.scroll({ top: 0 });'))).toBe('.scroll(');
    expect(checkCodeMutation(doing('HTMLElement.prototype.click.call(el);'))).toBe('.click.call(');
    expect(checkCodeMutation(doing('HTMLElement.prototype.focus.apply(el, []);'))).toBe('.focus.apply(');
    expect(checkCodeMutation(doing('const go = el.click.bind(el); go();'))).toBe('.click.bind(');
    expect(checkCodeMutation(doing("el['click']();"))).toBe("['click'](");
    expect(checkCodeMutation(doing('el["focus"].call(el);'))).toBe('["focus"].call(');
  });

  it('checkCodeMutation lets reads through that name what it catches', () => {
    const reads = `(() => {
      const el = document.querySelector('#item');
      const box = el.getBoundingClientRect();
      const scrolled = el.scrollTop > 0 || window.scrollY >= 1 || el.scrollHeight > el.clientHeight;
      const value = el.value;
      const picked = el['value'];
      const names = Array.prototype.map.call(document.querySelectorAll('li'), (li) => li.textContent);
      return { pass: box.width > 0 && !scrolled && value === picked && names.length > 0, actual: value };
    })()`;
    expect(checkCodeMutation(reads)).toBeUndefined();
  });
});
