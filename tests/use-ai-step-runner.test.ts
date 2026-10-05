import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../src/ai/types.js';
import { parseUseAiReply } from '../src/ai/action-parser.js';
import { buildUseAiPrompt } from '../src/ai/prompts.js';
import { parseUseAiStep } from '../src/parser/use-step.js';
import { parseFailureTail } from '../src/parser/failure-tail.js';
import { runSecrets } from '../src/utils/secrets.js';
import { runUseAiStep, type UseAiModel } from '../src/runner/use-ai-step-runner.js';

/**
 * `[use ai] <step>` below the loops (stories/use-ai-step.md §Tests): the reply
 * parser, the prompt, and the one runner all four loops share — driven with a
 * fake model that records exactly what it was sent, because verification rule
 * 1 is a claim about the WIRE: one system message, one user message, and the
 * user message is the step's text with nothing else from the test in it.
 */

// ---------------------------------------------------------------------------
// parseUseAiReply
// ---------------------------------------------------------------------------

describe('parseUseAiReply', () => {
  it('reads the value shape, trimmed, with its name', () => {
    expect(parseUseAiReply('{"as": "random_name", "value": "  AUTO4821 "}')).toEqual({
      kind: 'value',
      as: 'random_name',
      value: 'AUTO4821',
    });
  });

  it('reads the error shape as a real outcome, with the reason', () => {
    expect(parseUseAiReply('{"error": " The step does not say what today is. "}')).toEqual({
      kind: 'error',
      reason: 'The step does not say what today is.',
    });
  });

  it('stores a number or a boolean as its string form', () => {
    expect(parseUseAiReply('{"as": "n", "value": 42}')).toEqual({ kind: 'value', as: 'n', value: '42' });
    expect(parseUseAiReply('{"as": "b", "value": false}')).toEqual({
      kind: 'value',
      as: 'b',
      value: 'false',
    });
  });

  it('refuses a list and an object — lists are not in this story', () => {
    expect(parseUseAiReply('{"as": "x", "value": ["a", "b"]}')).toMatchObject({
      kind: 'malformed',
      why: expect.stringContaining('list'),
    });
    expect(parseUseAiReply('{"as": "x", "value": {"a": 1}}')).toMatchObject({
      kind: 'malformed',
      why: expect.stringContaining('object'),
    });
  });

  it('refuses both keys, and neither', () => {
    expect(parseUseAiReply('{"value": "v", "error": "e"}')).toMatchObject({
      kind: 'malformed',
      why: expect.stringContaining('both'),
    });
    expect(parseUseAiReply('{"as": "x"}')).toMatchObject({
      kind: 'malformed',
      why: expect.stringContaining('neither'),
    });
  });

  it('tolerates a fence and prose around the object — only the value is stored', () => {
    expect(parseUseAiReply('```json\n{"as": "x", "value": "v"}\n```')).toEqual({
      kind: 'value',
      as: 'x',
      value: 'v',
    });
    expect(parseUseAiReply('Sure! Here it is: {"as": "x", "value": "v"} Hope that helps.')).toEqual({
      kind: 'value',
      as: 'x',
      value: 'v',
    });
  });

  it('refuses an empty or whitespace value rather than storing ""', () => {
    for (const raw of ['{"as": "x", "value": ""}', '{"as": "x", "value": "   \\n "}']) {
      expect(parseUseAiReply(raw), raw).toMatchObject({ kind: 'malformed', why: '"value" was empty' });
    }
  });

  it('refuses text that is not JSON, and JSON that is not an object', () => {
    expect(parseUseAiReply('AUTO4821')).toMatchObject({ kind: 'malformed' });
    expect(parseUseAiReply('["AUTO4821"]')).toMatchObject({ kind: 'malformed' });
  });

  it('leaves out an `as` that is not a non-empty string', () => {
    expect(parseUseAiReply('{"as": 7, "value": "v"}')).toEqual({ kind: 'value', value: 'v' });
    expect(parseUseAiReply('{"as": "  ", "value": "v"}')).toEqual({ kind: 'value', value: 'v' });
  });
});

// ---------------------------------------------------------------------------
// buildUseAiPrompt
// ---------------------------------------------------------------------------

/** The sentence that says what the mask is (issue 060), word for word. */
const MASK_SENTENCE =
  'Each *** in the step stands for a value that is hidden from you. If the step ' +
  'needs a hidden value, reply with "error" and say so.';

describe('buildUseAiPrompt', () => {
  it('is one system message and one user message, the user message the text alone', () => {
    const messages = buildUseAiPrompt('Give me a name');
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]!.content).toBe('Give me a name');
    expect(messages[0]!.content).toContain('the step below is everything you know');
    expect(messages[0]!.content).toContain('"as" is the variable name the step asks for');
  });

  it('with an explicit name, asks for no "as"', () => {
    const [system] = buildUseAiPrompt('Give me a name', 'name');
    expect(system!.content).toContain('The framework already knows the variable\'s name; omit "as".');
    expect(system!.content).not.toContain('"as" is the variable name the step asks for');
  });

  it('carries a retry reason in the system message, never as a third message', () => {
    const messages = buildUseAiPrompt('Give me a name', undefined, '"value" was empty');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toContain('Your previous reply could not be used: "value" was empty.');
    expect(messages[1]!.content).toBe('Give me a name');
  });

  it('says what *** is, beside the do-not-guess rule, only when a value was hidden (issue 060)', () => {
    const [masked] = buildUseAiPrompt('Repeat *** back', undefined, undefined, true);
    expect(masked!.content).toContain(`Do not guess to fill the gap. ${MASK_SENTENCE}`);
    // A step that hid nothing gets the prompt it always had: told otherwise,
    // a model asked for "a row of ***" could refuse the author's own stars.
    const [plain] = buildUseAiPrompt('Write a row of *** as a divider');
    expect(plain!.content).toContain('Do not guess to fill the gap.');
    expect(plain!.content).not.toContain('hidden from you');
  });
});

// ---------------------------------------------------------------------------
// runUseAiStep
// ---------------------------------------------------------------------------

/** A model that answers from a queue and records every request. */
function fakeModel(replies: Array<string | Error>): { model: UseAiModel; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    model: {
      async complete(messages) {
        calls.push(messages);
        const next = replies.shift();
        if (next === undefined) throw new Error('the model was asked more times than scripted');
        if (next instanceof Error) throw next;
        return { text: next, model: 'fake-model' };
      },
    },
  };
}

type Args = Parameters<typeof runUseAiStep>[0];

/** One step, run with sensible defaults; `line` is the authored line. */
async function run(
  line: string,
  replies: Array<string | Error>,
  over: Partial<Args> = {},
) {
  const { model, calls } = fakeModel(replies);
  const scope = over.scope ?? {};
  const outcome = await runUseAiStep({
    parsed: parseUseAiStep(line)!,
    index: 5,
    instruction: line,
    scope,
    secrets: runSecrets({ parameters: scope }),
    aiClient: model,
    retries: 1,
    ...over,
  });
  return { outcome, calls, scope };
}

const userText = (calls: ChatMessage[][], n = 0): unknown => calls[n]![1]!.content;

describe('runUseAiStep — what the model is sent', () => {
  it('exactly the resolved text: one system message, one user message, nothing else from the test', async () => {
    // A date that is NOT today, so "the framework added no date" can be
    // checked against the real one. Its year is built from the clock: a fixed
    // future year would become the current year one day, and the "no current
    // year in the request" check below would then fail on every run.
    const year = new Date().getFullYear() + 5;
    const scope = { today: `${year}-01-05`, email: 'demo@bank.test' };
    const { outcome, calls } = await run(
      '[use ai] Today is {{today}}. Give the date 3 days later as yyyymmdd [store as: days_from_now]',
      [`{"value": "${year}0108"}`],
      { scope },
    );
    expect(outcome.result.status).toBe('passed');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((m) => m.role)).toEqual(['system', 'user']);
    expect(userText(calls)).toBe(`Today is ${year}-01-05. Give the date 3 days later as yyyymmdd`);
    // Nothing from the run leaks in anywhere: no other variable, no
    // `## Values` block, no history, no clock.
    const all = JSON.stringify(calls);
    const realToday = new Date().toISOString().slice(0, 10);
    expect(all).not.toContain('demo@bank.test');
    expect(all).not.toContain('## Values');
    expect(all).not.toContain('Prior Steps');
    expect(all).not.toContain(realToday);
    expect(all).not.toContain(String(new Date().getFullYear()));
    // Nothing was hidden, so the model is not told anything was.
    expect(calls[0]![0]!.content).not.toContain('hidden from you');
  });

  it('an unresolved reference fails the step before any model call, in Set\'s words', async () => {
    const { outcome, calls } = await run('[use ai] Today is {{today}}. Give tomorrow', []);
    expect(calls).toHaveLength(0);
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.error).toBe(
      'The [use ai] step references `{{today}}`, which is not a parameter or captured variable of this run.',
    );
  });

  it('an unresolvable ${…} fails the same way, even with no environment', async () => {
    const { outcome, calls } = await run('[use ai] Today is ${env.TODAY}. Give tomorrow', []);
    expect(calls).toHaveLength(0);
    expect(outcome.result.error).toContain('references `${env.TODAY}`');
  });

  it('a name the step DEFINES in prose is neither refused nor filled', async () => {
    // Second pass through a loop: `colour` already holds the first value, and
    // the model must not be told it.
    const scope = { colour: 'teal' };
    const { outcome, calls } = await run(
      '[use ai] Pick a colour and store it as {{colour}}',
      ['{"value": "plum"}'],
      { scope },
    );
    expect(userText(calls)).toBe('Pick a colour and store it as {{colour}}');
    expect(calls[0]![0]!.content).not.toContain('hidden from you');
    expect(outcome.result.status).toBe('passed');
    expect(scope.colour).toBe('plum');
  });

  it('a secret-named value arrives as ***, and an unmask: name arrives as itself', async () => {
    const scope = { api_token: 'tok-SECRET-123', keyword: 'AU-KEYWORD' };
    const masked = await run(
      '[use ai] Make a label from {{api_token}} and {{keyword}} [store as: label]',
      ['{"value": "L"}'],
      { scope },
    );
    expect(userText(masked.calls)).toBe('Make a label from *** and ***');

    const unmasked = await run(
      '[use ai] Make a label from {{api_token}} and {{keyword}} [store as: label]',
      ['{"value": "L"}'],
      { scope: { ...scope }, unmask: new Set(['keyword']) },
    );
    expect(userText(unmasked.calls)).toBe('Make a label from *** and AU-KEYWORD');
  });

  it('a ${…} secret is masked by its path', async () => {
    const envData = { env: { PASSWORD: 'hunter2-ENV', REGION: 'eu' } };
    const { calls } = await run(
      '[use ai] Describe ${env.REGION} without mentioning ${env.PASSWORD} [store as: d]',
      ['{"value": "x"}'],
      { envData, secrets: runSecrets({ parameters: {}, envData }) },
    );
    expect(userText(calls)).toBe('Describe eu without mentioning ***');
  });

  it('the failure tail is stripped from what the model reads', async () => {
    const line = '[use ai] Write a line [store as: l] otherwise continue with warning "no line"';
    const { calls } = await run(line, ['{"value": "x"}'], {
      failureTail: parseFailureTail(line),
    });
    expect(userText(calls)).toBe('Write a line');
    expect(calls[0]![0]!.content).not.toContain('hidden from you');
  });
});

describe('runUseAiStep — the name', () => {
  it('an explicit name overrides the model\'s "as"', async () => {
    const { outcome, scope } = await run(
      '[use ai] Give a name [store as: chosen]',
      ['{"as": "something_else", "value": "Ada"}'],
    );
    expect(outcome.result.status).toBe('passed');
    expect(scope).toEqual({ chosen: 'Ada' });
    expect(outcome).toMatchObject({ name: 'chosen', value: 'Ada' });
    expect(outcome.result.outputs).toEqual({ chosen: 'Ada' });
    expect(outcome.result.aiExplanation).toBe('[use ai] chosen = "Ada"');
  });

  it('with no explicit name, the model\'s name is used when the step says it as a whole word', async () => {
    const { outcome, scope } = await run(
      '[use ai] Create a name starting with "AUTO" and ending with a random 4 digit number and store it in random_name',
      ['{"as": "random_name", "value": "AUTO4821"}'],
    );
    expect(outcome.result.status).toBe('passed');
    expect(scope).toEqual({ random_name: 'AUTO4821' });
  });

  it('…case-insensitively, in the STEP\'s spelling', async () => {
    const { scope } = await run('[use ai] Give a code and store it in Promo_Code', [
      '{"as": "promo_code", "value": "SAVE10"}',
    ]);
    expect(scope).toEqual({ Promo_Code: 'SAVE10' });
  });

  it('fails, naming the model\'s choice and the two fixes, when the step never said it', async () => {
    const { outcome, calls, scope } = await run(
      '[use ai] Write a random paragraph of text about Australia',
      [
        '{"as": "australia_paragraph", "value": "Kangaroos."}',
        '{"as": "paragraph_text", "value": "Kangaroos."}',
      ],
    );
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.error).toContain('`paragraph_text`');
    expect(outcome.result.error).toContain('which the step does not mention');
    expect(outcome.result.error).toContain('say what to call it in the step, or add `[store as: name]`');
    // Retried like any formatting failure, with the reason in the retry prompt.
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]!.content).toContain('`australia_paragraph`, which the step does not mention');
    expect(scope).toEqual({});
  });

  it('a part-word match is not a match', async () => {
    const { outcome } = await run('[use ai] Give a username', ['{"as": "user", "value": "u"}'], {
      retries: 0,
    });
    expect(outcome.result.status).toBe('failed');
  });

  it('a skill-internal name is bound and never reported, as runSetStep does it', async () => {
    const { outcome, scope } = await run('[use ai] Give a code [store as: __skill1_code]', [
      '{"value": "C-1"}',
    ]);
    expect(scope).toEqual({ __skill1_code: 'C-1' });
    expect(outcome.result.status).toBe('passed');
    expect(outcome.result.outputs).toBeUndefined();
    expect(outcome.name).toBeUndefined();
  });
});

describe('runUseAiStep — errors and retries', () => {
  it('an {"error": …} reply fails with the reason and is NOT retried', async () => {
    const { outcome, calls, scope } = await run(
      '[use ai] Give the date 3 days from today as yyyymmdd and store it in days_from_now',
      ['{"error": "The step does not say what today is."}', '{"as": "days_from_now", "value": "20990101"}'],
      { retries: 3 },
    );
    expect(calls).toHaveLength(1);
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.error).toContain('The step does not say what today is.');
    expect(scope).toEqual({});
  });

  it('a malformed reply is retried within execution.retries, the retry saying what was wrong', async () => {
    const { outcome, calls, scope } = await run('[use ai] Give a name [store as: n]', [
      '{"value": ""}',
      '{"value": "Ada"}',
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]!.content).toContain('Your previous reply could not be used: "value" was empty');
    expect(outcome.result.status).toBe('passed');
    expect(outcome.result.retried).toBe(true);
    expect(scope).toEqual({ n: 'Ada' });
    // One turn per attempt, each holding its model call and no actions.
    expect(outcome.result.turns.map((t) => t.aiInteractions[0]!.purpose)).toEqual(['use-ai', 'use-ai']);
    expect(outcome.result.turns.every((t) => t.subActions.length === 0)).toBe(true);
  });

  it('gives up after the retries, saying why, and stores nothing', async () => {
    const { outcome, calls, scope } = await run(
      '[use ai] Give a name [store as: n]',
      ['{"value": ["a"]}', 'not json'],
      { retries: 1 },
    );
    expect(calls).toHaveLength(2);
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.error).toContain('The [use ai] step stored nothing');
    expect(scope).toEqual({});
  });

  it('a machine that has no AI fails on the first attempt with the client\'s own message', async () => {
    const keyless = Object.assign(new Error('AI is not configured: set AI_API_KEY'), {
      name: 'AiNotConfiguredError',
    });
    const { outcome, calls } = await run('[use ai] Give a name [store as: n]', [keyless], {
      retries: 3,
    });
    expect(calls).toHaveLength(1);
    expect(outcome.result.error).toBe('AI is not configured: set AI_API_KEY');
  });

  it('refuses a line with two names at run time, with the parser\'s message, and asks nothing', async () => {
    const { outcome, calls } = await run('[use ai] Pick a colour [store as: a] [as: b]', []);
    expect(calls).toHaveLength(0);
    expect(outcome.result.error).toContain('A `[use ai]` step produces one value');
  });

  it('applies an `otherwise continue` tail to a failure, as any step does', async () => {
    const line = '[use ai] Give a name [store as: n] otherwise continue with warning "no name today"';
    const { outcome } = await run(line, ['{"error": "no"}'], { failureTail: parseFailureTail(line) });
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.tolerated).toBe(true);
    expect(outcome.result.warning).toBe('no name today');
  });

  it('applies an `otherwise fail … with message` tail in the author\'s words', async () => {
    const line = '[use ai] Give a name [store as: n] otherwise fail the test with error "no name for {{who}}"';
    const { outcome } = await run(line, ['{"error": "no"}'], {
      failureTail: parseFailureTail(line),
      scope: { who: 'Ada' },
    });
    expect(outcome.result.error).toBe('no name for Ada');
    expect(outcome.result.aiExplanation).toContain('What failed:');
  });
});

/**
 * A model that echoes its input: the user message back, verbatim, as the
 * value. The bluntest form of what the real model did with the issue-060
 * probe, which answered `***`. Records what it was sent.
 */
function echoModel(): { model: UseAiModel; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    model: {
      async complete(messages) {
        calls.push(messages);
        return { text: JSON.stringify({ value: messages[1]!.content }), model: 'echo-model' };
      },
    },
  };
}

describe('runUseAiStep — a value hidden from the model (issue 060)', () => {
  const PROBE =
    '[use ai] Repeat this back exactly, character for character: {{password}} and store it in echo';
  const SECRET = 'hunter2-probe';
  /** What a name-rule mask adds to either error: the name is the reason. */
  const PASSWORD_HINT =
    ' `{{password}}` is hidden by its name, which contains "password"; if it is not a secret, rename it.';
  const PASSWORD_ERROR =
    'The value contains `***` — the mask for `{{password}}`, which is hidden from the model; ' +
    'a [use ai] step cannot use a secret.' +
    PASSWORD_HINT;

  it('a model that echoes its input fails the step, naming {{password}} and never its value', async () => {
    const echo = echoModel();
    const { outcome, scope } = await run(PROBE, [], {
      scope: { password: SECRET },
      aiClient: echo.model,
      retries: 3,
    });
    // What the model read: the mask, as designed, and the sentence saying what it is.
    expect(userText(echo.calls)).toBe(
      'Repeat this back exactly, character for character: *** and store it in echo',
    );
    expect(echo.calls[0]![0]!.content).toContain(MASK_SENTENCE);
    // The step failed on that answer: not retried, nothing stored or reported.
    // The echo names no variable and the step pins none, so this also holds
    // the order: the mask is checked before the name, whose failure retries.
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.error).toBe(PASSWORD_ERROR);
    expect(echo.calls).toHaveLength(1);
    expect(scope).toEqual({ password: SECRET });
    expect(outcome.name).toBeUndefined();
    expect(outcome.result.outputs).toBeUndefined();
    // The secret is in nothing the step reports, and was in nothing it sent.
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(JSON.stringify(echo.calls)).not.toContain(SECRET);
  });

  it('so does the real model\'s recorded answer to the probe, {"as": "echo", "value": "***"}', async () => {
    const { outcome, scope } = await run(PROBE, ['{"as": "echo", "value": "***"}'], {
      scope: { password: SECRET },
    });
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.error).toBe(PASSWORD_ERROR);
    expect(scope).toEqual({ password: SECRET });
  });

  it('a model that says it needs the hidden value fails the step with its own reason, not retried', async () => {
    const { outcome, calls, scope } = await run(
      PROBE,
      ['{"error": "The value to repeat is hidden from me."}', '{"as": "echo", "value": "hunter2"}'],
      { scope: { password: SECRET }, retries: 3 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.content).toContain(MASK_SENTENCE);
    expect(outcome.result.status).toBe('failed');
    // The model's reason says THAT something is hidden; the framework adds WHAT.
    expect(outcome.result.error).toBe(
      'The model could not do the [use ai] step as written: The value to repeat is hidden from me. ' +
        '(Hidden from the model: `{{password}}`.)' +
        PASSWORD_HINT,
    );
    expect(outcome.result.aiExplanation).toBe('The model declined: The value to repeat is hidden from me.');
    expect(scope).toEqual({ password: SECRET });
  });

  it('…and says the NAME is the reason when a name only looks secret, as `{{keyword}}` does', async () => {
    // The likeliest false positive: `keyword` contains `key`. Renaming is the
    // fix under every client; `unmask:` is honoured only by `steptix run`.
    const { outcome } = await run(
      '[use ai] Write a search phrase that uses {{keyword}} [store as: phrase]',
      ['{"error": "The keyword is hidden"}'],
      { scope: { keyword: 'AU' } },
    );
    expect(outcome.result.error).toBe(
      'The model could not do the [use ai] step as written: The keyword is hidden. ' +
        '(Hidden from the model: `{{keyword}}`.) ' +
        '`{{keyword}}` is hidden by its name, which contains "key"; if it is not a secret, rename it.',
    );
  });

  it('a declined step that hid nothing keeps the model\'s reason alone', async () => {
    const { outcome } = await run('[use ai] Give tomorrow as yyyymmdd [store as: d]', [
      '{"error": "The step does not say what today is."}',
    ]);
    expect(outcome.result.error).toBe(
      'The model could not do the [use ai] step as written: The step does not say what today is.',
    );
  });

  it('with nothing hidden, an answer holding *** is stored, and the prompt never mentions a mask', async () => {
    const { outcome, calls, scope } = await run(
      '[use ai] Write the word "hello" in Markdown bold italic [store as: styled]',
      ['{"value": "***hello***"}'],
    );
    expect(outcome.result.status).toBe('passed');
    expect(scope).toEqual({ styled: '***hello***' });
    expect(calls[0]![0]!.content).not.toContain('hidden from you');
  });

  it('…as it is when a value merely holds asterisks, or an unmask: name is shown as itself', async () => {
    // Neither was masked — the model saw the real text — so neither is a mask.
    // And the model is not told a value is hidden: the text it reads holds
    // `***`, but nothing was hidden to put it there.
    const rating = await run('[use ai] Repeat {{rating}} exactly [store as: copy]', ['{"value": "***"}'], {
      scope: { rating: '***' },
    });
    expect(userText(rating.calls)).toBe('Repeat *** exactly');
    expect(rating.calls[0]![0]!.content).not.toContain('hidden from you');
    expect(rating.outcome.result.status).toBe('passed');
    expect(rating.scope.copy).toBe('***');

    const keyword = await run('[use ai] Repeat {{keyword}} exactly [store as: copy]', ['{"value": "AU***"}'], {
      scope: { keyword: 'AU***' },
      unmask: new Set(['keyword']),
    });
    expect(userText(keyword.calls)).toBe('Repeat AU*** exactly');
    expect(keyword.calls[0]![0]!.content).not.toContain('hidden from you');
    expect(keyword.outcome.result.status).toBe('passed');
    expect(keyword.scope.copy).toBe('AU***');
  });

  it('a known secret inside a value whose name says nothing is named as PART of it', async () => {
    // The free-text rule: `{{greeting}}` is not secret-named, but the run
    // knows `hunter2` as a password, so the model reads it masked in place.
    const scope = { password: 'hunter2', greeting: 'Hello hunter2' };
    const echo = echoModel();
    const { outcome } = await run('[use ai] Repeat {{greeting}} exactly [store as: copy]', [], {
      scope,
      aiClient: echo.model,
    });
    expect(userText(echo.calls)).toBe('Repeat Hello *** exactly');
    expect(echo.calls[0]![0]!.content).toContain(MASK_SENTENCE);
    // No name hint: the name is not the reason, and renaming would not help.
    expect(outcome.result.error).toBe(
      'The value contains `***` — the mask for part of `{{greeting}}`, which is hidden from the model; ' +
        'a [use ai] step cannot use a secret.',
    );
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
  });

  it('a value that IS a known secret, under a name that says nothing, is named without the name hint', async () => {
    const echo = echoModel();
    const { outcome } = await run('[use ai] Repeat {{saved}} exactly [store as: copy]', [], {
      scope: { password: 'hunter2', saved: 'hunter2' },
      aiClient: echo.model,
    });
    expect(userText(echo.calls)).toBe('Repeat *** exactly');
    expect(outcome.result.error).toBe(
      'The value contains `***` — the mask for `{{saved}}`, which is hidden from the model; ' +
        'a [use ai] step cannot use a secret.',
    );
  });

  it('inside a skill, names the variable as the author wrote it, not as `__skill1_…`', async () => {
    // `applySkillScope` renames a skill-internal `{{token}}` per call.
    const echo = echoModel();
    const { outcome } = await run('[use ai] Repeat {{__skill1_token}} exactly [store as: __skill1_copy]', [], {
      scope: { __skill1_token: 'tok-SECRET-9' },
      aiClient: echo.model,
    });
    expect(outcome.result.error).toBe(
      'The value contains `***` — the mask for `{{token}}`, which is hidden from the model; ' +
        'a [use ai] step cannot use a secret. ' +
        '`{{token}}` is hidden by its name, which contains "token"; if it is not a secret, rename it.',
    );
    expect(outcome.result.error).not.toContain('__skill');
  });

  it('a secret inside a record is named as PART of the reference that holds it', async () => {
    const echo = echoModel();
    const { outcome } = await run('[use ai] Repeat {{account}} exactly [store as: copy]', [], {
      scope: { account: '{"user":"bob","password":"abc12"}' },
      aiClient: echo.model,
    });
    expect(userText(echo.calls)).toBe('Repeat {"user":"bob","password":"***"} exactly');
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.error).toBe(
      'The value contains `***` — the mask for part of `{{account}}`, which is hidden from the model; ' +
        'a [use ai] step cannot use a secret.',
    );
    expect(JSON.stringify(outcome)).not.toContain('abc12');
  });

  it('holds the mask however an echo spells it: spaced, escaped, punctuated, or in a lookalike', async () => {
    // Each was stored, and the step passed, before the value was normalised.
    const echoes = [
      '* * *',
      '*  *  *',
      '\\*\\*\\*',
      '\\\\*\\\\*\\\\*', // escaped twice: two backslashes between, more than one separator
      '*-*-*',
      '* - * - *',
      '*.*.*',
      '*_*_*',
      '\uFF0A\uFF0A\uFF0A', // ＊ fullwidth
      '\u2217\u2217\u2217', // ∗ asterisk operator
      '\u204E\u204E\u204E', // ⁎ low asterisk
      '\u2731\u2731\u2731', // ✱ heavy asterisk
      '\uFE61\uFE61\uFE61', // ﹡ small asterisk
      '\u2042', // ⁂ asterism: three asterisks in one character
      '\u2051*', // ⁑ two, and one more
      'Your password is *\uFF0A* ok',
    ];
    for (const value of echoes) {
      const { outcome, scope } = await run(PROBE, [JSON.stringify({ as: 'echo', value })], {
        scope: { password: SECRET },
      });
      expect(outcome.result.status, value).toBe('failed');
      expect(outcome.result.error, value).toBe(PASSWORD_ERROR);
      expect(scope, value).toEqual({ password: SECRET });
    }
  });

  it('…but two asterisks are not three, and with nothing hidden none of it is asked about', async () => {
    const hid = await run(
      '[use ai] Write the word bold in Markdown bold. Unrelated, do not use it: {{password}} [store as: b]',
      ['{"value": "**bold**"}'],
      { scope: { password: SECRET } },
    );
    expect(hid.calls[0]![0]!.content).toContain(MASK_SENTENCE);
    expect(hid.outcome.result.status).toBe('passed');
    expect(hid.scope.b).toBe('**bold**');

    for (const value of ['**bold**', '* * *', '\\*\\*\\*', '\u2042', '***']) {
      const plain = await run('[use ai] Write a divider line [store as: divider]', [JSON.stringify({ value })]);
      expect(plain.calls[0]![0]!.content, value).not.toContain('hidden from you');
      expect(plain.outcome.result.status, value).toBe('passed');
      expect(plain.scope.divider, value).toBe(value);
    }
  });

  it('a step that hides a value it does not need still passes', async () => {
    const { outcome, calls, scope } = await run(
      '[use ai] Write a one-line greeting for the user in {{account}} [store as: greeting]',
      ['{"value": "Hello, bob!"}'],
      { scope: { account: '{"user":"bob","password":"abc12"}' } },
    );
    expect(calls[0]![0]!.content).toContain(MASK_SENTENCE);
    expect(outcome.result.status).toBe('passed');
    expect(scope.greeting).toBe('Hello, bob!');
  });

  it('names every hidden reference once, ${…} included, in the step\'s order', async () => {
    const envData = { env: { PASSWORD: 'env-SECRET-pw' } };
    const scope = { api_token: 'tok-SECRET-123' };
    const echo = echoModel();
    const { outcome } = await run(
      '[use ai] Join {{api_token}}, ${env.PASSWORD} and {{api_token}} with dashes [store as: joined]',
      [],
      { scope, envData, secrets: runSecrets({ parameters: scope, envData }), aiClient: echo.model },
    );
    expect(userText(echo.calls)).toBe('Join ***, *** and *** with dashes');
    expect(outcome.result.error).toBe(
      'The value contains `***` — the mask for `{{api_token}}` and `${env.PASSWORD}`, which are ' +
        'hidden from the model; a [use ai] step cannot use a secret. ' +
        '`{{api_token}}` and `${env.PASSWORD}` are hidden by their names, which contain "token" and ' +
        '"PASSWORD"; rename any that is not a secret.',
    );
    const reported = JSON.stringify(outcome);
    expect(reported).not.toContain('tok-SECRET-123');
    expect(reported).not.toContain('env-SECRET-pw');
  });

  it('once a value is hidden, asterisks of the model\'s own fail too — the chosen trade-off', async () => {
    const { outcome, scope } = await run(
      '[use ai] Write a Markdown bold-italic welcome for the user whose password is {{password}} [store as: welcome]',
      ['{"value": "***Welcome back!***"}'],
      { scope: { password: SECRET } },
    );
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.error).toBe(PASSWORD_ERROR);
    expect(scope).toEqual({ password: SECRET });
  });

  it('an `otherwise continue` tail tolerates the failure, and still stores nothing', async () => {
    const line = '[use ai] Repeat {{password}} exactly [store as: copy] otherwise continue with warning "no copy"';
    const { outcome, scope } = await run(line, ['{"value": "***"}'], {
      scope: { password: SECRET },
      failureTail: parseFailureTail(line),
    });
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.tolerated).toBe(true);
    expect(outcome.result.warning).toBe('no copy');
    expect(scope).toEqual({ password: SECRET });
  });
});

describe('runUseAiStep — a secret written into the step\'s own words (issue 060)', () => {
  // What a skill argument or a looped section's row leaves behind: the
  // expander wrote the value into the text, so no `{{…}}` is left to name it,
  // and the loop's mask set (`runSecretsWithInputs`) is the only thing that
  // knows it. Here the set is handed over as a loop would hand it.
  const ROW_SECRET = 'row-SECRET-9';
  const IN_TEXT_HINT =
    " A secret's value is masked wherever it appears in the step's text, including where a " +
    "skill's argument or a looped section's row put it.";

  it('reaches the model masked, with the sentence, and an echo fails the step', async () => {
    const echo = echoModel();
    const { outcome, scope } = await run(`[use ai] Repeat ${ROW_SECRET} exactly [store as: copy]`, [], {
      secrets: [ROW_SECRET],
      aiClient: echo.model,
    });
    expect(userText(echo.calls)).toBe('Repeat *** exactly');
    expect(echo.calls[0]![0]!.content).toContain(MASK_SENTENCE);
    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.error).toBe(
      "The value contains `***` — the mask for a secret written into the step's text, which is hidden " +
        'from the model; a [use ai] step cannot use a secret.' +
        IN_TEXT_HINT,
    );
    expect(scope).toEqual({});
    expect(JSON.stringify(echo.calls)).not.toContain(ROW_SECRET);
    // The report row keeps the authored line, as for any step: masking that is
    // each loop's job, with the same set.
    expect(JSON.stringify({ ...outcome.result, instruction: undefined })).not.toContain(ROW_SECRET);
  });

  it('is named beside a hidden reference, and in a declined step\'s error', async () => {
    const { outcome } = await run(
      `[use ai] Join {{password}} and ${ROW_SECRET} [store as: joined]`,
      ['{"error": "Both values are hidden."}'],
      { scope: { password: 'hunter2-probe' }, secrets: ['hunter2-probe', ROW_SECRET] },
    );
    expect(outcome.result.error).toBe(
      'The model could not do the [use ai] step as written: Both values are hidden. ' +
        "(Hidden from the model: `{{password}}` and a secret written into the step's text.) " +
        '`{{password}}` is hidden by its name, which contains "password"; if it is not a secret, rename it.' +
        IN_TEXT_HINT,
    );
  });

  it('never touches a reference: a `{{…}}` token survives a secret that matches inside it', async () => {
    // `word` is a (short) secret value; the defined name `keyword_list` holds
    // it too. The token is left for the framework, the prose is masked.
    const { calls, outcome, scope } = await run(
      '[use ai] Pick a word and store it as {{keyword_list}}',
      ['{"value": "plum"}'],
      { secrets: ['word'] },
    );
    expect(userText(calls)).toBe('Pick a *** and store it as {{keyword_list}}');
    expect(outcome.result.status).toBe('passed');
    expect(scope).toEqual({ keyword_list: 'plum' });
  });

  it('masks a short secret wherever its characters occur, as the report does — unless `unmask:` names it', async () => {
    // The mask set has no floor for a name the author chose, so a `keyword` of
    // `AU` hides the "AU" in "AUstralia" here exactly as it does in the
    // report, and the model is told something is hidden.
    const scope = { keyword: 'AU' };
    const masked = await run('[use ai] Describe AUstralia in one line [store as: d]', ['{"value": "Big."}'], {
      scope,
    });
    expect(userText(masked.calls)).toBe('Describe ***stralia in one line');
    expect(masked.calls[0]![0]!.content).toContain(MASK_SENTENCE);

    // `unmask: keyword` exempts the value in the step's words too, not only
    // where `{{keyword}}` names it.
    const unmasked = await run('[use ai] Describe AUstralia in one line [store as: d]', ['{"value": "Big."}'], {
      scope: { ...scope },
      unmask: new Set(['keyword']),
    });
    expect(userText(unmasked.calls)).toBe('Describe AUstralia in one line');
    expect(unmasked.calls[0]![0]!.content).not.toContain('hidden from you');
    expect(unmasked.outcome.result.status).toBe('passed');
  });
});
