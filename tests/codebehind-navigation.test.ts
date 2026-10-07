import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { StepResult, SubActionResult } from '../src/report/types.js';
import { buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { actionsOf, readRecording, writeRecording, type RecordedAction } from '../src/codebehind/recording.js';
import { entryFaults, generateStepEntry, unwaitedNavigationComplaint } from '../src/codebehind/generate.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * Show the generator which actions navigated
 * (docs/specs/SPEC-codebehind-robustness.md §6.7).
 *
 * The runtime already knew, per action, the URL it ran on and the URL the page
 * was on after it. `actionsOf` dropped both, so the generator was never told
 * that failure A's sign-in click led to another page — and wrote an entry that
 * read the title 57 ms after the click.
 */

const SIGN_IN = 'Click the Sign in button';
const SIGN_IN_PAGE = 'http://localhost:8787/index.html';
const DASHBOARD = 'http://localhost:8787/dashboard.html';

/** Failure A's line 33 entry, as compiled (§3.1). */
const A_ENTRY = `{
  source: '${SIGN_IN}',
  async run({ page, step }) {
    await page.locator('#sign-in-btn').click();
    const dashboard = (await page.title()).includes('Dashboard');
    const signInFormVisible = await page.locator('#email').isVisible();
    step.expect(
      dashboard || signInFormVisible,
      'Sign-in attempt reached the dashboard or left the sign-in form available',
    );
  },
}`;

/** The same click, waited for. */
const SETTLED_ENTRY = `{
  source: '${SIGN_IN}',
  async run({ page, step }) {
    await page.locator('#sign-in-btn').click();
    await step.settle();
  },
}`;

const CLICK: RecordedAction = { action: 'click', selector: '#sign-in-btn' };
const NAVIGATED: RecordedAction = { ...CLICK, navigated: { from: SIGN_IN_PAGE, to: DASHBOARD } };

function subAction(over: Partial<SubActionResult> = {}): SubActionResult {
  return { index: 1, action: { action: 'click', selector: '#sign-in-btn' }, durationMs: 1, ...over };
}

function resultWith(...subActions: SubActionResult[]): StepResult {
  return {
    index: 1,
    instruction: SIGN_IN,
    status: 'passed',
    turns: [{ turnNumber: 1, attemptNumber: 1, timestamp: '2026-10-08T00:00:00.000Z', aiInteractions: [], subActions }],
    durationMs: 4,
    retried: false,
  };
}

// ── actionsOf ────────────────────────────────────────────────────────────────

describe('actionsOf carries where an action moved the page', () => {
  it('adds navigated: { from, to } when the action ran on another URL than it left', () => {
    const [action] = actionsOf(resultWith(subAction({ pageUrl: DASHBOARD, actionPageUrl: SIGN_IN_PAGE })));
    expect(action).toEqual({ action: 'click', selector: '#sign-in-btn', navigated: { from: SIGN_IN_PAGE, to: DASHBOARD } });
  });

  it('adds nothing for an action that stayed on its page, and returns the action itself', () => {
    const sa = subAction({ pageUrl: SIGN_IN_PAGE });
    const [action] = actionsOf(resultWith(sa));
    expect(action).toBe(sa.action);
    expect(action).not.toHaveProperty('navigated');
  });

  it('keeps navigated beside the measurement', () => {
    const [action] = actionsOf(
      resultWith(subAction({ pageUrl: DASHBOARD, actionPageUrl: SIGN_IN_PAGE, targeting: { matchCount: 1 } })),
    );
    expect(action).toEqual({
      action: 'click',
      selector: '#sign-in-btn',
      targeting: { matchCount: 1 },
      navigated: { from: SIGN_IN_PAGE, to: DASHBOARD },
    });
  });
});

describe('the recording on disk', () => {
  let tmpBase: string;
  let dir: string;
  let counter = 0;
  beforeAll(async () => {
    tmpBase = await makeScratchBase('navigation');
  });
  beforeEach(async () => {
    dir = path.join(tmpBase, `t${counter++}`);
    await fs.mkdir(dir, { recursive: true });
  });
  afterAll(async () => {
    await removeScratchBase(tmpBase);
  });

  it('masks a secret in a navigated URL, as it masks every field of the action', async () => {
    const test = path.join(dir, 'reset.md');
    await writeRecording(test, {
      steps: [
        resultWith(
          subAction({
            pageUrl: 'http://localhost:8787/reset?token=hunter2-horse',
            actionPageUrl: SIGN_IN_PAGE,
          }),
        ),
      ],
      status: 'passed',
      startedAt: '2026-10-08T00:00:00.000Z',
      parameters: { password: 'hunter2-horse' },
      source: 'cli',
    });
    const recording = (await readRecording(test))!;
    expect(recording.steps[0]!.actions[0]!.navigated).toEqual({
      from: SIGN_IN_PAGE,
      to: 'http://localhost:8787/reset?token=***',
    });
  });
});

// ── The prompt ───────────────────────────────────────────────────────────────

const LEGEND =
  "An action with `navigated` changed the page's URL on this run. The entry must wait for the page it leads to " +
  'before anything after it, with `await step.settle()`, and must not hard-code the URL: other rows of a data ' +
  'table may not navigate.';

describe('the generation prompt', () => {
  const prompt = (actions: RecordedAction[], secrets?: string[]) =>
    buildStepCodePrompt({ rawStepText: SIGN_IN, parameters: [], actions, ...(secrets && { secrets }) })
      .content as string;

  it('explains navigated once, above a transcript that has it', () => {
    const text = prompt([{ action: 'type', selector: '#email', value: '{{username}}' }, NAVIGATED]);
    expect(text).toContain(LEGEND);
    expect(text.split(LEGEND)).toHaveLength(2);
    expect(text).toContain(`"navigated": {\n      "from": "${SIGN_IN_PAGE}",\n      "to": "${DASHBOARD}"\n    }`);
  });

  it('is byte-identical to before for a transcript where nothing navigated', () => {
    const text = prompt([CLICK]);
    expect(text).not.toContain(LEGEND);
    expect(text).not.toContain('"navigated"');
    expect(text).not.toContain('`navigated`');
  });

  it('masks a secret in a navigated URL', () => {
    const text = prompt([{ ...CLICK, navigated: { from: SIGN_IN_PAGE, to: `${DASHBOARD}?session=tok-9f2` } }], ['tok-9f2']);
    expect(text).toContain(`"to": "${DASHBOARD}?session=***"`);
    expect(text).not.toContain('tok-9f2');
  });
});

// ── The static check ─────────────────────────────────────────────────────────

describe('unwaitedNavigationComplaint', () => {
  it("fires on failure A's line 33 entry", () => {
    const complaint = unwaitedNavigationComplaint(A_ENTRY, [NAVIGATED]);
    expect(complaint).toBe(
      `On the recorded run, the \`click\` action changed the page's URL, from ${SIGN_IN_PAGE} to ${DASHBOARD}, ` +
        "and this entry does not wait after its last action (`.click(`). Compiled code runs in milliseconds, so " +
        'without a wait whatever comes next reads or acts on the page being left. Put `await step.settle()` ' +
        'straight after the action that leads to another page: it waits for every request the action started ' +
        'and the navigation they begin, then for the page to hold still. Do not wait for that URL by name: other ' +
        'rows of a data table may not navigate.',
    );
  });

  it('is satisfied by step.settle() — or another wait — after the last action', () => {
    expect(unwaitedNavigationComplaint(SETTLED_ENTRY, [NAVIGATED])).toBeUndefined();
    expect(
      unwaitedNavigationComplaint(
        `{ source: 'x', async run({ page }) { await page.click('#go'); await page.waitForLoadState('domcontentloaded'); } }`,
        [NAVIGATED],
      ),
    ).toBeUndefined();
    expect(
      unwaitedNavigationComplaint(
        `{ source: 'x', async run({ page }) { await page.click('#go'); await expect(page).toHaveTitle(/Dashboard/); } }`,
        [NAVIGATED],
      ),
    ).toBeUndefined();
  });

  it('asks for the wait AFTER the last action: one before it, or around it, does not count', () => {
    expect(
      unwaitedNavigationComplaint(
        `{ source: 'x', async run({ page }) { await Promise.all([page.waitForURL('**/dashboard.html'), page.click('#go')]); } }`,
        [NAVIGATED],
      ),
    ).toBeDefined();
  });

  it('says nothing when no recorded action navigated', () => {
    expect(unwaitedNavigationComplaint(A_ENTRY, [CLICK])).toBeUndefined();
    expect(unwaitedNavigationComplaint(A_ENTRY, [])).toBeUndefined();
  });

  it('says nothing about an entry that ends on a goto, which waits for its own page', () => {
    expect(
      unwaitedNavigationComplaint(`{ source: 'x', async run({ page }) { await page.goto('/dashboard.html'); } }`, [
        { action: 'navigate', url: '/dashboard.html', navigated: { from: SIGN_IN_PAGE, to: DASHBOARD } },
      ]),
    ).toBeUndefined();
  });

  it('masks a secret in the URLs it quotes', () => {
    const complaint = unwaitedNavigationComplaint(
      A_ENTRY,
      [{ ...CLICK, navigated: { from: SIGN_IN_PAGE, to: `${DASHBOARD}?session=tok-9f2` } }],
      ['tok-9f2'],
    );
    expect(complaint).toContain(`to ${DASHBOARD}?session=***,`);
  });

  it('is one of the faults Review holds a revision to', () => {
    const checks = entryFaults(A_ENTRY, { source: SIGN_IN, actions: [NAVIGATED] }).map((f) => f.check);
    expect(checks).toContain('unwaited-navigation');
    expect(entryFaults(SETTLED_ENTRY, { source: SIGN_IN, actions: [NAVIGATED] })).toEqual([]);
  });
});

describe('generation re-asks an entry that does not wait for its navigation', () => {
  const binding: CodeBehindBinding = {
    file: path.resolve(path.sep, 'nowhere', 'x.steps.ts'),
    source: SIGN_IN,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
  };
  const BARE_CLICK = `{
  source: '${SIGN_IN}',
  async run({ page }) {
    await page.locator('#sign-in-btn').click();
  },
}`;

  function scripted(...answers: string[]): { client: AiClient; prompts: string[] } {
    const prompts: string[] = [];
    const client = {
      complete: async (messages: ChatMessage[]) => {
        const last = messages[messages.length - 1]!;
        prompts.push(typeof last.content === 'string' ? last.content : contentBlocksToText(last.content));
        return { text: JSON.stringify({ entry: answers[Math.min(prompts.length - 1, answers.length - 1)] }), model: 'stub' };
      },
    } as unknown as AiClient;
    return { client, prompts };
  }

  it('tells the model why, and keeps the answer that waits', async () => {
    const { client, prompts } = scripted(BARE_CLICK, SETTLED_ENTRY);
    const result = await generateStepEntry({
      binding,
      actions: [NAVIGATED],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'sign-in.md',
    });
    expect(result).toMatchObject({ kind: 'entry', code: SETTLED_ENTRY });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(LEGEND);
    expect(prompts[1]).toContain('## Your previous answer was refused');
    expect(prompts[1]).toContain("changed the page's URL");
  });

  it('asks once for an entry that already waits', async () => {
    const { client, prompts } = scripted(SETTLED_ENTRY);
    const result = await generateStepEntry({
      binding,
      actions: [NAVIGATED],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'sign-in.md',
    });
    expect(result).toMatchObject({ kind: 'entry', code: SETTLED_ENTRY });
    expect(prompts).toHaveLength(1);
  });
});
