/**
 * The executor half of the `… otherwise fail with message "…"` / `… otherwise
 * continue` tail (stories/step-failure-outcomes.md, decisions 4, 5, 6, 10): the
 * model never sees the tail, every failed result leaves through the one
 * `applyFailureTail` seam, and a step that passed is touched by nothing.
 * Harness as `flow-control-executor.test.ts` — fake page, scripted client, the
 * real `executeStep`, mocked actions so a test picks which one fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepCache } from '../src/cache/step-cache.js';
import type { StepResult } from '../src/report/types.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseFailureTail } from '../src/parser/failure-tail.js';

const actions = vi.hoisted(() => ({ received: [] as AIAction[] }));

// `#missing…` is an ordinary failure a re-plan could fix; `#fatal…` is one the
// action layer tagged non-retryable (a missing upload file — upload-action.md,
// decision 8). Everything else works, so one harness drives both directions.
vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) => {
      actions.received.push(action);
      if (action.selector?.startsWith('#fatal')) {
        return {
          success: false,
          error: `Upload file not found: ${action.filePath ?? action.selector}`,
          retryable: false,
        };
      }
      return action.selector?.startsWith('#missing')
        ? { success: false, error: `Element not found: ${action.selector}` }
        : { success: true };
    }),
  };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: vi.fn(async () => '<html><body>dom</body></html>') };
});

vi.mock('../src/browser/page-state.js', () => ({
  diagnosePageState: async () => ({
    isLoading: false,
    loadingIndicators: [],
    hasErrorOverlay: false,
    errorMessages: [],
    hasModal: false,
    documentLoading: false,
  }),
  waitForPageStability: async () => {},
  waitForPostActionSettle: async () => {},
  capturePageSignal: async () => ({ url: 'https://app.test/', domLength: 1 }),
  PageActivityTracker: class {
    isIdle(): boolean { return true; }
    dispose(): void {}
  },
}));

import { executeStep } from '../src/runner/step-executor.js';
import { buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';

const repoRoot = path.resolve(__dirname, '..');

function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'https://app.test/account',
    context: () => ({ browser: () => ({}) }),
    evaluate: async () => { throw new Error('no DOM in this test'); },
    screenshot: async () => { throw new Error('no screenshot in this test'); },
    waitForLoadState: async () => {},
  } as unknown as Page;
}

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, headed: false },
  execution: {
    ...DEFAULT_CONFIG.execution,
    retries: 0,
    maxTurns: 3,
    promptOnAmbiguity: false,
    screenshotOnFailure: false,
  },
};

/** A question may be asked and there is no console to answer it on — the
 *  Sessions API / errand shape (issues/014). */
const UNATTENDED: Config = {
  ...CONFIG,
  execution: { ...CONFIG.execution, promptOnAmbiguity: true },
};

function scriptedClient(responses: string[]): AiClient & { requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  let turn = 0;
  return {
    requests,
    complete: async (messages: ChatMessage[]) => {
      requests.push(messages);
      const text = responses[turn] ?? responses[responses.length - 1]!;
      turn++;
      return { text, model: 'stub' };
    },
  } as unknown as AiClient & { requests: ChatMessage[][] };
}

function plan(acts: AIAction[], needsReeval = false): string {
  return JSON.stringify({ actions: acts, reasoning: 'because', needs_reeval: needsReeval });
}

/** One planned turn at one selector; the mock decides how it goes. `reeval` asks
 *  for a continuation turn. */
const turn = (action: AIAction['action'], selector: string, reeval = false): string =>
  plan([{ action, selector, description: 'do the step`s work' }], reeval);
const noopTurn = (): string => plan([{ action: 'noop', description: 'nothing left to do' }]);
const failing = (selector: string, action: AIAction['action'] = 'click'): string[] => [
  turn(action, selector),
];

/** A cache that replays one turn: the action is the whole point. */
function cacheOf(action: AIAction): StepCache {
  const cached = { rawResponse: plan([action]), actions: [action], reasoning: 'cached' };
  return {
    read: async () => [cached],
    write: async () => {},
    invalidateStep: async () => {},
    readAssertion: async () => null,
    writeAssertion: async () => {},
    invalidateAssertion: async () => {},
  } as unknown as StepCache;
}

/** A cached upload whose file is missing — the non-retryable replay. */
const CACHED_FATAL: RunOpts = {
  stepCache: cacheOf({
    action: 'upload',
    selector: '#fatal-statement-file',
    filePath: 'attachments/nope.png',
    description: 'Upload the statement',
  }),
  cacheEnabled: true,
};

const ASK = plan([{ action: 'prompt', description: 'which banner?', question: 'which banner?' }]);

/** A binding with an entry written in-line: `runCodeBehindEntry` needs the entry
 *  and the scope, and nothing here turns on the file behind it. */
function bindingFor(source: string, entry: CodeBehindBinding['entry']): CodeBehindBinding {
  return {
    file: path.join(repoRoot, 'tests', 'x.steps.ts'),
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    entry,
  };
}

/** A compiled step whose expectation fails — the replay half of a failed step. */
function failingBinding(line: string, error = 'the footer showed no build number'): CodeBehindBinding {
  return bindingFor(line, {
    source: line,
    run({ step }) { step.expect(false, error); },
  });
}

/** The STEP text of one turn, as one string. The system prompt is left out on
 *  purpose: its flow-control rules name the grammar's own words, so a search
 *  across the whole request would match the rulebook rather than the step. */
function textOf(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    )
    .join('\n');
}

type RunOpts = {
  config?: Config;
  stepCache?: StepCache;
  cacheEnabled?: boolean;
  codeBehind?: CodeBehindBinding;
  /** No console to answer an AI question on. */
  nonInteractive?: boolean;
  /** Omit the tail the loop would have computed: the control that shows a
   *  behaviour belongs to the tail, not to the wording of the line. */
  noTail?: boolean;
  /** The line as WRITTEN, when the loop enriched the one it dispatched — the tail
   *  is a fact about the authored line (decision 12). Defaults to `instruction`. */
  authored?: string;
  /** The run's parameters: `runSecrets` reads the SECRET-NAMED values out of them,
   *  and those are what a masked warning must come back without. */
  parameters?: Record<string, string>;
};

/** Run one step, with the tail computed off the same line a run loop computes it
 *  from, so the two cannot disagree here. */
async function runStep(
  instruction: string,
  responses: string[],
  opts: RunOpts = {},
): Promise<{ result: StepResult; client: AiClient & { requests: ChatMessage[][] } }> {
  const client = scriptedClient(responses);
  const authored = opts.authored ?? instruction;
  const tail = opts.noTail ? null : parseFailureTail(authored);
  const result = await executeStep(1, 3, instruction, {
    page: fakePage(),
    config: opts.config ?? CONFIG,
    aiClient: client,
    contextContent: '',
    testName: 'failure tails',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: opts.parameters ?? {},
    testSteps: [instruction],
    ...(tail && { failureTail: tail }),
    ...(opts.stepCache && { stepCache: opts.stepCache }),
    ...(opts.cacheEnabled !== undefined && { cacheEnabled: opts.cacheEnabled }),
    ...(opts.codeBehind && { codeBehind: opts.codeBehind }),
    ...(opts.nonInteractive && { nonInteractive: true }),
  }, authored);
  return { result, client };
}

const FAIL_TAIL =
  'Verify the title contains "Account details" otherwise fail the test with ' +
  'message "Page did not contain account details"';
const CONTINUE_TAIL = 'Dismiss the promo banner otherwise continue';
const WARN_TAIL =
  'Verify the footer shows the build number otherwise continue with warning ' +
  '"Footer build number missing"';

beforeEach(() => {
  actions.received = [];
});

// ── What the model is shown ────────────────────────────────────────────────

/**
 * The tail is stripped from the two prompt texts and NOTHING else, so the report
 * row, the console line, the cache key and the run log keep the line the author
 * wrote (decision 4). A model shown "otherwise continue" would answer `noop`; one
 * shown "otherwise fail with message" would answer `fail`.
 */
const HIDING: Array<{
  label: string;
  instruction: string;
  authored?: string;
  responses: string[];
  /** 2 means the CONTINUATION builder ran — a second chance to leak. */
  turns?: number;
  shown: string[];
  hidden: string[];
  /** Defaults to a pass: only the enriched row below fails. */
  status?: StepResult['status'];
  /** Exact `result.instruction` — what the row, log and cache key are built from. */
  instructionKept?: string;
  tolerated?: true;
}> = [
  {
    label: 'hides the tail on turn 1 AND on a continuation turn, while the result keeps it',
    instruction: FAIL_TAIL,
    responses: [turn('click', '#ok', true), noopTurn()],
    turns: 2,
    shown: ['Verify the title contains "Account details"'],
    hidden: ['otherwise', 'Page did not contain account details'],
    instructionKept: FAIL_TAIL,
  },
  {
    label: 'hides an `otherwise continue` tail too — the one a model would read as "optional"',
    instruction: CONTINUE_TAIL,
    responses: failing('#promo-close'),
    turns: 1,
    shown: ['Dismiss the promo banner'],
    hidden: ['otherwise continue'],
  },
  {
    // What every loop builds for a capturing step (`buildEnrichedInstruction`), and
    // it survives only because the continuation builder renders the AUTHORED line.
    label: 'hides it on a continuation turn of an `[output:]` step, marker kept',
    instruction: 'Read the total otherwise continue [store as: total]',
    authored: '[output: total] Read the total otherwise continue',
    responses: [turn('read', '#total', true), noopTurn()],
    turns: 2,
    shown: ['Read the total', '[store as: total]'],
    hidden: ['otherwise'],
    instructionKept: 'Read the total otherwise continue [store as: total]',
  },
  {
    // The row above with nothing covering for it: the `$`-anchored grammar had
    // stopped reaching a tail with ` [store as:]` behind it, so the model was shown
    // "otherwise continue" AND the loops' own parse answered null.
    label: 'hides it on an enriched line with no separate authored form, and still applies the tail',
    instruction: 'Read the total otherwise continue [store as: total]',
    responses: failing('#missing-total'),
    shown: ['Read the total', '[store as: total]'],
    hidden: ['otherwise'],
    status: 'failed',
    tolerated: true,
  },
  {
    // The control: stripping is the grammar's doing, not a blanket rewrite.
    label: 'leaves a line with no tail exactly as it was',
    instruction: 'Dismiss the promo banner and continue to the dashboard',
    responses: failing('#promo-close'),
    turns: 1,
    shown: ['Dismiss the promo banner and continue to the dashboard'],
    hidden: [],
  },
];

describe('the prompt texts', () => {
  it.each(HIDING)('$label', async (row) => {
    const { result, client } = await runStep(row.instruction, row.responses, {
      ...(row.authored && { authored: row.authored }),
    });

    expect(result.status).toBe(row.status ?? 'passed');
    if (row.turns !== undefined) expect(client.requests).toHaveLength(row.turns);
    for (const request of client.requests) {
      const text = textOf(request);
      for (const shown of row.shown) expect(text).toContain(shown);
      for (const hidden of row.hidden) expect(text).not.toContain(hidden);
    }
    if (row.instructionKept) expect(result.instruction).toBe(row.instructionKept);
    if (row.tolerated) expect(result.tolerated).toBe(true);
  });
});

// ── The four paths into a failed result ────────────────────────────────────

/**
 * Every failed result leaving `executeStep` passes through `applyFailureTail`
 * (decisions 5 and 6): a second copy of that decision is a second place for
 * `tolerated` to be forgotten, and a forgotten `tolerated` is a run that stops
 * when the author said to carry on. A row supplies only how it fails a step.
 */
type FailingPath = {
  path: string;
  /** The step as written, without a tail. */
  body: string;
  /** The author's message on a `fail` tail. */
  message: string;
  /** The error the framework itself produced, before any tail. */
  error: string;
  /** A phrase from the explanation this path writes when no tail applies. */
  untouched: string;
  /** The model was not asked at all. */
  noModel?: true;
  fromCodeBehind?: true;
  fail: (line: string, opts?: RunOpts) => ReturnType<typeof runStep>;
};

const PATHS: FailingPath[] = [
  {
    path: 'the AI flow',
    body: 'Verify the title contains "Account details"',
    message: 'Page did not contain account details',
    error: 'Element not found: #missing-title',
    untouched: 'Failed to execute step. Last error:',
    fail: (line, opts) => runStep(line, failing('#missing-title'), opts),
  },
  {
    // A cached upload with no file fails NON-retryably and never reaches the AI
    // flow: it is re-thrown from the first attempt into the shared handler.
    path: 'a replayed cached action no re-planning could fix',
    body: 'Upload the statement',
    message: 'No statement to upload',
    error: 'Upload file not found: attachments/nope.png',
    untouched: 'Failed to execute step. Last error:',
    noModel: true,
    // The scripted turn is there to be left unused: `noModel` proves it was.
    fail: (line, opts) => runStep(line, [noopTurn()], { ...CACHED_FATAL, ...opts }),
  },
  {
    // The one failed result that leaves `executeStepAttempt` by RETURNING, so the
    // catch never sees it — and a stop the tail was written to prevent.
    path: 'an unanswerable clarification',
    body: 'Dismiss the promo banner',
    message: 'The promo banner was still in the way',
    error:
      'AI needs clarification, but this run has no interactive prompt to answer it: which banner?',
    untouched: 'AI asked for clarification: which banner?',
    fail: (line, opts) => runStep(line, [ASK], { config: UNATTENDED, nonInteractive: true, ...opts }),
  },
  {
    // A compiled step is the step the author wrote the tail on, so a failed
    // replay must be tolerated as the AI run was — or compiling changes the test.
    path: 'a code-behind replay',
    body: 'Verify the footer shows the build number',
    message: 'Sign in did not reach the account page',
    error: 'the footer showed no build number',
    untouched: 'A `step.expect` in this step\'s code-behind failed',
    noModel: true,
    fromCodeBehind: true,
    fail: (line, opts) => runStep(line, [], { codeBehind: failingBinding(line), ...opts }),
  },
];

describe.each(PATHS)('the same seam on $path', (p) => {
  it('tolerates the failure under `otherwise continue`, keeping the framework`s error', async () => {
    const { result, client } = await p.fail(`${p.body} otherwise continue`);

    if (p.noModel) expect(client.requests).toHaveLength(0);
    expect(result.status).toBe('failed');
    expect(result.tolerated).toBe(true);
    // The error stays the framework's — the row still has to say what went wrong.
    expect(result.error).toBe(p.error);
    expect(result.aiExplanation).toBe(
      `The run continued past this step (otherwise continue). What failed: ${p.error}`,
    );
    if (p.fromCodeBehind) expect(result.fromCodeBehind).toBe(true);
  });

  it('renames it under a `fail` tail, keeping the original in the explanation', async () => {
    const { result } = await p.fail(
      `${p.body} otherwise fail the test with message "${p.message}"`,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe(p.message);
    expect(result.aiExplanation).toBe(`Failed as the step says. What failed: ${p.error}`);
    // A renamed failure is still a failure: nothing here tolerates it.
    expect(result.tolerated).toBeUndefined();
    expect(result.deliberate).toBeUndefined();
  });

  it('is the tail doing it, not the wording of the line', async () => {
    // Same line, same failure, no tail computed: the untouched result.
    const { result } = await p.fail(
      `${p.body} otherwise fail the test with message "${p.message}"`,
      { noTail: true },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe(p.error);
    expect(result.tolerated).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(result.aiExplanation).toContain(p.untouched);
  });
});

// ── The message and the warning the tail can carry ─────────────────────────

describe('the tail`s own words', () => {
  it('changes nothing when a `fail` tail names no message', async () => {
    // Legal and a no-op: it exists so the two forms are one grammar, not two.
    const { result } = await runStep('Click Save otherwise fail', failing('#missing-save'));
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Element not found: #missing-save');
    expect(result.tolerated).toBeUndefined();
  });

  it('leads with the author`s warning when one was written', async () => {
    const { result } = await runStep(WARN_TAIL, failing('#missing-footer'));
    expect(result.tolerated).toBe(true);
    expect(result.error).toBe('Element not found: #missing-footer');
    expect(result.aiExplanation).toBe(
      'Footer build number missing. The run continued past this step ' +
      '(otherwise continue). What failed: Element not found: #missing-footer',
    );
  });

  it('puts the warning on its own field as well as in the explanation', async () => {
    // Structural: the explanation does not travel on the `step:fail` wire event
    // and the warning has to — it is the TestBench hover's first line.
    const { result } = await runStep(WARN_TAIL, failing('#missing-footer'));
    expect(result.warning).toBe('Footer build number missing');

    // A bare tail has none to carry, and the field is ABSENT rather than empty —
    // a client reads its presence.
    const { result: bare } = await runStep(CONTINUE_TAIL, failing('#missing-promo'));
    expect(bare.tolerated).toBe(true);
    expect(Object.hasOwn(bare, 'warning')).toBe(false);
  });

  it('masks a secret the author put in the warning, at the same seam the error is masked at', async () => {
    // The field is new; the rule is not — a warning reaches the wire, the report
    // and the log as an error does, so it is redacted where it is composed.
    const { result } = await runStep(
      'Verify the footer otherwise continue with warning "signed in as hunter2"',
      failing('#missing-footer'),
      { parameters: { password: 'hunter2' } },
    );
    expect(result.warning).toBe('signed in as ***');
    expect(result.aiExplanation).not.toContain('hunter2');
  });
});

// ── `{{name}}` inside the tail's own message ───────────────────────────────

/**
 * Decision 3: a `{{name}}` in a tail message resolves like one anywhere else in
 * the line. The tail is parsed off the AUTHORED line — the same answer on every
 * run and in every runner — so its message still holds the braces, and the
 * executor re-reads the message off the INTERPOLATED line the result carries.
 * `${env.X}` needs no row: the loops resolve it by the same pass into the same
 * instruction string, so these cross the one seam there is.
 */
const footerWarn = (msg: string) => `Verify the footer otherwise continue with warning "${msg}"`;
const titleFail = (msg: string) =>
  `Verify the title contains "Account details" otherwise fail the test with message "${msg}"`;

const PLACEHOLDERS: Array<{
  label: string;
  instruction: string;
  authored: string;
  /** The selector that trips the step up. A row without one fails through a
   *  code-behind entry instead, where no model ran at all. */
  selector?: string;
  action?: AIAction['action'];
  parameters?: Record<string, string>;
  warning?: string;
  error?: string;
  explains?: string[];
  /** Must appear in none of `error`, `warning`, `aiExplanation`. */
  omits?: string[];
}> = [
  {
    // Field and explanation are one place: both are composed from that string.
    label: 'resolves in the warning of a `continue` tail, on the field and in the explanation',
    instruction: footerWarn('Missing build number for 4.2.1'),
    authored: footerWarn('Missing build number for {{release}}'),
    selector: '#missing-footer',
    warning: 'Missing build number for 4.2.1',
    explains: ['Missing build number for 4.2.1'],
    omits: ['{{release}}'],
  },
  {
    label: 'resolves in the error of a `fail` tail',
    instruction: titleFail('Expected the account page for Ada Lovelace'),
    authored: titleFail('Expected the account page for {{name}}'),
    selector: '#missing-title',
    error: 'Expected the account page for Ada Lovelace',
    explains: ['Element not found: #missing-title'],
    omits: ['{{name}}'],
  },
  {
    // Every capturing step's shape: the loop appends ` [store as: total]` AFTER
    // the tail, so read off the wrong line the message would keep its braces on
    // exactly the steps that capture the values it quotes.
    label: 'resolves an enriched `[store as:]` line, where the tail is not last on the line',
    instruction:
      'Read the total otherwise continue with warning "No total on the 4.2.1 page" [store as: total]',
    authored:
      '[output: total] Read the total otherwise continue with warning "No total on the {{release}} page"',
    selector: '#missing-total',
    action: 'read',
    warning: 'No total on the 4.2.1 page',
  },
  {
    label: 'resolves on the code-behind path, where no model ran at all',
    instruction: footerWarn('Missing build number for 4.2.1'),
    authored: footerWarn('Missing build number for {{release}}'),
    warning: 'Missing build number for 4.2.1',
  },
  {
    // The resolution must happen BEFORE the redact: a `{{password}}` masked while
    // still a token is masked AS the token, and the secret reaches the wire.
    label: 'masks a secret the placeholder resolved to, at the seam the literal one is masked at',
    instruction: footerWarn('signed in as hunter2'),
    authored: footerWarn('signed in as {{password}}'),
    selector: '#missing-footer',
    parameters: { password: 'hunter2' },
    warning: 'signed in as ***',
    omits: ['hunter2'],
  },
  {
    // The one reachable fallback, and the one the `fail` verb takes: a value
    // holding the `"` that ENDS the message leaves a line the `$`-anchored
    // grammar no longer matches, so there is no resolved message to read.
    label: 'falls back to the authored text — placeholder and all — when the value carries the closing quote',
    instruction: 'Verify the vendor row otherwise continue with warning "Missing Acme "Ltd""',
    authored: 'Verify the vendor row otherwise continue with warning "Missing {{vendor}}"',
    selector: '#missing-vendor',
    warning: 'Missing {{vendor}}',
  },
];

describe('a placeholder in the tail`s message', () => {
  it.each(PLACEHOLDERS)('$label', async (row) => {
    const { result, client } = await runStep(
      row.instruction,
      row.selector ? failing(row.selector, row.action) : [],
      {
        authored: row.authored,
        ...(row.parameters && { parameters: row.parameters }),
        ...(row.selector ? {} : { codeBehind: failingBinding(row.instruction) }),
      },
    );

    if (!row.selector) expect(client.requests).toHaveLength(0);
    expect(result.status).toBe('failed');
    if (row.warning !== undefined) {
      expect(result.tolerated).toBe(true);
      expect(result.warning).toBe(row.warning);
    }
    if (row.error !== undefined) expect(result.error).toBe(row.error);
    for (const phrase of row.explains ?? []) expect(result.aiExplanation).toContain(phrase);
    for (const gone of row.omits ?? []) {
      expect(result.error ?? '').not.toContain(gone);
      expect(result.warning ?? '').not.toContain(gone);
      expect(result.aiExplanation ?? '').not.toContain(gone);
    }
  });
});

// ── A passing body ─────────────────────────────────────────────────────────

describe('a step whose body passes', () => {
  it('is an ordinary pass with no flags, under either tail', async () => {
    for (const line of [FAIL_TAIL, CONTINUE_TAIL, WARN_TAIL]) {
      const { result } = await runStep(line, failing('#ok'));
      expect(result.status).toBe('passed');
      expect(result.tolerated).toBeUndefined();
      expect(result.deliberate).toBeUndefined();
      expect(result.error).toBeUndefined();
      // The tail did nothing at all, including to the explanation.
      expect(result.aiExplanation).toBe('because');
    }
  });
});

// ── The code-behind path's own two answers ─────────────────────────────────

describe('a code-behind entry that is not a tolerated failure', () => {
  it('words a `step.fail` failure for what it is, and flags it deliberate', async () => {
    // The `fail` verb compiled (decision 10), not a tail — but it reaches the same
    // branch, since `step.fail` throws the class `step.expect` throws. Worded as a
    // failed expectation it sends the reader after a `step.expect` that does not
    // exist, and inside `brokenCode` it would heal under AI and lose its entry.
    const line =
      'If {{a}} is "peanuts" then fail the test with error ' +
      '"The variable value was peanuts. Expected apples"';
    expect(parseFailureTail(line)).toBeNull();
    const binding = bindingFor(line, {
      source: line,
      run({ step }) {
        step.fail('The variable value was peanuts. Expected apples');
      },
    });
    const { result, client } = await runStep(line, [], { codeBehind: binding });

    expect(client.requests).toHaveLength(0);
    expect(result.status).toBe('failed');
    expect(result.deliberate).toBe(true);
    expect(result.error).toBe('The variable value was peanuts. Expected apples');
    expect(result.aiExplanation).toContain('step.fail');
    expect(result.aiExplanation).not.toContain('step.expect');
    // The entry was kept and nothing was flagged stale: it did its job.
    expect(binding.entry).toBeDefined();
    expect(result.codeBehindStale).toBeUndefined();
  });

  it('leaves a passing entry alone', async () => {
    const { result } = await runStep(CONTINUE_TAIL, [], {
      codeBehind: bindingFor(CONTINUE_TAIL, {
        source: CONTINUE_TAIL,
        run() { /* the banner was not there; nothing to do */ },
      }),
    });
    expect(result.status).toBe('passed');
    expect(result.tolerated).toBeUndefined();
  });
});

// ── What the generator is told about a tail ────────────────────────────────

const GENERATION: Array<{
  label: string;
  step: string;
  actions: Parameters<typeof buildStepCodePrompt>[0]['actions'];
  contains: string[];
  omits: string[];
}> = [
  {
    label: 'names the BODY as the thing to compile, and the author`s message as the expect message',
    step: FAIL_TAIL,
    actions: [{ action: 'read', selector: 'title' }],
    contains: [
      'compile its BODY',
      'Verify the title contains "Account details"',
      '"Page did not contain account details"',
      // `source` stays the WHOLE line: it is what the runner matches the entry by.
      JSON.stringify(FAIL_TAIL),
    ],
    omits: [],
  },
  {
    // The mistake in the other direction: an entry that "handles" its own failure
    // reports a step that did not do its work as a pass.
    label: 'forbids swallowing the failure under a `continue` tail',
    step: CONTINUE_TAIL,
    actions: [{ action: 'click', selector: '#promo-close' }],
    contains: ['compile its BODY', '`try`/`catch`', "the runner's doing, not the entry's"],
    omits: [],
  },
  {
    label: 'says nothing at all to a step with no tail',
    step: 'Dismiss the promo banner',
    actions: [{ action: 'click', selector: '#promo-close' }],
    contains: ['End with a post-condition'],
    omits: ['compile its BODY'],
  },
];

describe('the generation prompt for a step with a tail', () => {
  it.each(GENERATION)('$label', ({ step, actions: acts, contains, omits }) => {
    const text = contentBlocksToText(
      buildStepCodePrompt({ rawStepText: step, parameters: [], actions: acts }).content,
    );
    for (const phrase of contains) expect(text).toContain(phrase);
    for (const gone of omits) expect(text).not.toContain(gone);
  });
});
