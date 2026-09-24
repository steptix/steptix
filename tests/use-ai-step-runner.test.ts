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
    // checked against the real one.
    const scope = { today: '2031-01-05', email: 'demo@bank.test' };
    const { outcome, calls } = await run(
      '[use ai] Today is {{today}}. Give the date 3 days later as yyyymmdd [store as: days_from_now]',
      ['{"value": "20310108"}'],
      { scope },
    );
    expect(outcome.result.status).toBe('passed');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((m) => m.role)).toEqual(['system', 'user']);
    expect(userText(calls)).toBe('Today is 2031-01-05. Give the date 3 days later as yyyymmdd');
    // Nothing from the run leaks in anywhere: no other variable, no
    // `## Values` block, no history, no clock.
    const all = JSON.stringify(calls);
    const realToday = new Date().toISOString().slice(0, 10);
    expect(all).not.toContain('demo@bank.test');
    expect(all).not.toContain('## Values');
    expect(all).not.toContain('Prior Steps');
    expect(all).not.toContain(realToday);
    expect(all).not.toContain(String(new Date().getFullYear()));
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
