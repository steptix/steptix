/**
 * Two rules that live inside `step-executor.ts` rather than in the run loops:
 *
 *  - §5.6 — an `If … then` / `While` / `Repeat … until` condition on the
 *    COMPUTER surface is judged from a capture of the screen, with no DOM.
 *  - §4.6 — `switchBrowser default` on a tracker that never launched launches
 *    it on demand, because the default browser is the one the deferred
 *    launcher opens and asking for it by name IS the request to open it.
 *
 * Harness copied from `step-executor-placeholders.test.ts`: a fake page, a
 * scripted client, and the real executor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const domCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return {
    ...actual,
    captureDomSnapshot: vi.fn(async () => {
      domCalls.count++;
      return '<html><body><div id="page-dom">real page markup</div></body></html>';
    }),
  };
});

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return { ...actual, executeAction: vi.fn(async () => ({ success: true })) };
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

import {
  buildStepValues,
  evaluateConditions,
  executeStep,
  type StepExecutorOptions,
} from '../src/runner/step-executor.js';
import {
  buildConditionJudgeMessage,
  buildSystemPrompt,
  formatTestInfo,
} from '../src/ai/prompts.js';
import { COMPUTER_JUDGE_SYSTEM_TEXT } from '../src/desktop/judge-prompt.js';
import { FakeDesktopAdapter } from '../src/desktop/fake-adapter.js';

function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'https://app.test/dashboard',
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
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 3, promptOnAmbiguity: false },
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

function blocksOf(messages: ChatMessage[]): Array<{ type: string; text?: string; image_url?: { url: string } }> {
  const user = messages[messages.length - 1]!;
  return typeof user.content === 'string'
    ? [{ type: 'text', text: user.content }]
    : (user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>);
}

beforeEach(() => {
  domCalls.count = 0;
});

// ---------------------------------------------------------------------------
// §5.6
// ---------------------------------------------------------------------------

/** Every text block of a request — system and user — joined: what the model
 *  reads, without the image. */
function requestText(messages: ChatMessage[]): string {
  return messages
    .flatMap((m) =>
      typeof m.content === 'string'
        ? [m.content]
        : (m.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? ''),
    )
    .join('\n');
}

/** Markers only the PAGE judge's request carries: the browser system prompt's
 *  opening line and two of its headings, and the DOM fence. */
const PAGE_PROMPT_MARKERS = [
  'You are an expert UI test automation agent',
  'SELECTOR STRATEGY',
  '## DOM Snapshot',
  '## Test Information',
];

function computerOpts(
  client: AiClient,
  adapter: FakeDesktopAdapter,
  extra: Partial<StepExecutorOptions> = {},
): StepExecutorOptions {
  return {
    page: undefined as never,
    config: CONFIG,
    aiClient: client,
    contextContent: '',
    testName: 'computer-condition',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
    computer: { adapter, settleMs: 0, maxImageWidth: 200, reportScreenshots: true },
    ...extra,
  };
}

function pageOpts(client: AiClient, extra: Partial<StepExecutorOptions> = {}): StepExecutorOptions {
  return {
    page: fakePage(),
    config: CONFIG,
    aiClient: client,
    contextContent: '',
    testName: 'page-condition',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
    ...extra,
  };
}

describe('a condition on the computer surface is judged from the screen', () => {
  it('sends the capture and no DOM', async () => {
    const adapter = new FakeDesktopAdapter({ width: 200, height: 150 });
    const client = scriptedClient([
      JSON.stringify({ matched: 'A', actions: [], reasoning: 'the Save As window is up' }),
    ]);

    const verdict = await evaluateConditions(
      ['a window titled "Save As" is open'],
      computerOpts(client, adapter),
    );

    expect(verdict.selected).toBe(0);
    // No DOM was captured at all — not a captured one that was then dropped.
    expect(domCalls.count).toBe(0);
    const blocks = blocksOf(client.requests[0]!);
    const image = blocks.find((b) => b.type === 'image_url');
    expect(image).toBeDefined();
    expect(image!.image_url!.url).toMatch(/^data:image\/png;base64,/);
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    expect(text).not.toContain('page-dom');
    // The capture went even though `ai.sendScreenshots` is false (§5.2).
    expect(CONFIG.ai.sendScreenshots).toBe(false);
    expect(adapter.callsOf('grab')).toHaveLength(1);
  });

  it('the page surface is untouched — DOM in, no desktop grab', async () => {
    const adapter = new FakeDesktopAdapter({ width: 200, height: 150 });
    const client = scriptedClient([
      JSON.stringify({ matched: 'none', actions: [], reasoning: 'nothing held' }),
    ]);

    const verdict = await evaluateConditions(['the banner is visible'], {
      page: fakePage(),
      config: CONFIG,
      aiClient: client,
      contextContent: '',
      testName: 'page-condition',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
    });

    expect(verdict.selected).toBeNull();
    expect(domCalls.count).toBe(1);
    expect(adapter.callsOf('grab')).toHaveLength(0);
    const text = blocksOf(client.requests[0]!)
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('page-dom');
    expect(requestText(client.requests[0]!)).not.toContain(COMPUTER_JUDGE_SYSTEM_TEXT);
  });
});

// ---------------------------------------------------------------------------
// §5.6 — the computer surface's judge gets its own short request (D1)
// ---------------------------------------------------------------------------

describe('the computer-surface judge sends a short request of its own', () => {
  it('carries none of the page prompt, and says what the image is and its size', async () => {
    const adapter = new FakeDesktopAdapter({ width: 200, height: 150 });
    const client = scriptedClient([
      JSON.stringify({ matched: 'A', actions: [], reasoning: 'the Save As window is up' }),
    ]);

    await evaluateConditions(['a window titled "Save As" is open'], computerOpts(client, adapter));

    const request = client.requests[0]!;
    const text = requestText(request);
    for (const marker of PAGE_PROMPT_MARKERS) expect(text, marker).not.toContain(marker);
    // No page action vocabulary either — the page prompt's action list names these.
    expect(text).not.toMatch(/"action": ?"(?:click|navigate|api_call)"/);
    expect(text).toContain(COMPUTER_JUDGE_SYSTEM_TEXT);
    expect(text).toContain('A) a window titled "Save As" is open');
    // The capture is 200 wide at maxImageWidth 200, so the image is the grab's size.
    expect(text).toContain('200×150 pixels');
    // Still exactly one image, and it is the capture.
    const images = blocksOf(request).filter((b) => b.type === 'image_url');
    expect(images).toHaveLength(1);
  });

  it('is under a quarter of the page judge\'s request for the same condition', async () => {
    const condition = ['a window titled "Save As" is open'];
    const history = ['Step 1: [✓ PASSED] Navigate to statement.pdf'];
    const context = '# App\nA statement viewer.';

    const computerClient = scriptedClient([JSON.stringify({ matched: 'none', actions: [], reasoning: 'no' })]);
    await evaluateConditions(
      condition,
      computerOpts(computerClient, new FakeDesktopAdapter({ width: 200, height: 150 }), {
        conversationHistory: history,
        contextContent: context,
      }),
    );
    const pageClient = scriptedClient([JSON.stringify({ matched: 'none', actions: [], reasoning: 'no' })]);
    await evaluateConditions(condition, pageOpts(pageClient, {
      conversationHistory: history,
      contextContent: context,
    }));

    // Text only: the image is the same bytes either way, and what the page
    // prompt added was words. The page request here carries a ~70-character
    // stand-in DOM, which is about what the old computer request carried in
    // its place (one sentence saying there was no DOM) — so this ratio is the
    // before/after of the change, give or take that sentence.
    const computerChars = requestText(computerClient.requests[0]!).length;
    const pageChars = requestText(pageClient.requests[0]!).length;
    expect(computerChars).toBeLessThan(pageChars / 4);
    // Both carry what both need: the project context and the prior steps.
    expect(requestText(computerClient.requests[0]!)).toContain('A statement viewer.');
    expect(requestText(computerClient.requests[0]!)).toContain('Navigate to statement.pdf');
  });

  it.each([
    ['the first condition', 'A', 0],
    ['the second condition', 'B', 1],
    ['none of them', 'none', null],
  ])('an answer naming %s still parses', async (_label, matched, selected) => {
    const client = scriptedClient([
      JSON.stringify({ matched, actions: [], reasoning: 'from the screenshot' }),
    ]);
    const verdict = await evaluateConditions(
      ['the Print dialog is open', 'the Save As dialog is open'],
      computerOpts(client, new FakeDesktopAdapter({ width: 200, height: 150 })),
    );
    expect(verdict.selected).toBe(selected);
    expect(verdict.reasoning).toBe('from the screenshot');
    // And the request labelled both, in chain order.
    const text = requestText(client.requests[0]!);
    expect(text).toContain('A) the Print dialog is open');
    expect(text).toContain('B) the Save As dialog is open');
  });

  it('masks a secret value in its ## Values block, as the page judge does', async () => {
    const client = scriptedClient([JSON.stringify({ matched: 'none', actions: [], reasoning: 'no' })]);
    await evaluateConditions(
      ['the title bar shows {{account}} and the prompt shows {{password}}'],
      computerOpts(client, new FakeDesktopAdapter({ width: 200, height: 150 }), {
        resolvedParameters: { account: 'ACME-42', password: 'hunter2-secret' },
      }),
    );
    const text = requestText(client.requests[0]!);
    expect(text).toContain('## Values');
    expect(text).toContain('ACME-42');
    expect(text).not.toContain('hunter2-secret');
  });

  it('keeps the unretryable rethrow when the model rejects the image (§15.4)', async () => {
    const message = 'copilot/o3-mini does not accept images.';
    const body = { message, type: 'invalid_request_error', code: 'image_input_unsupported' };
    const rejection = Object.assign(new Error(`400 ${message}`), {
      name: 'BadRequestError',
      status: 400,
      error: body,
      code: body.code,
    });
    const client = {
      requests: [] as ChatMessage[][],
      complete: async () => {
        throw rejection;
      },
    } as unknown as AiClient;

    const judged = evaluateConditions(
      ['the Print dialog is open'],
      computerOpts(client, new FakeDesktopAdapter({ width: 200, height: 150 })),
    );
    await expect(judged).rejects.toThrow(message);
    await expect(judged).rejects.toMatchObject({ retryable: false });
  });
});

describe('the page-surface judge request is unchanged', () => {
  it('is exactly the page system prompt plus buildConditionJudgeMessage, byte for byte', async () => {
    // Rebuilt here from the two builders with the arguments evaluateConditions
    // has always passed them. Any change to what the page judge sends — a new
    // block, a reordered argument, a surface check that leaks onto this path —
    // fails this deep equality.
    const client = scriptedClient([JSON.stringify({ matched: 'none', actions: [], reasoning: 'no' })]);
    const conditions = ['the plan is {{plan}}', 'the banner is visible'];
    const opts = pageOpts(client, {
      contextContent: '# App\ncontext',
      conversationHistory: ['Step 1: [✓ PASSED] Open the page'],
      baseUrl: 'https://app.test',
      resolvedParameters: { plan: 'gold' },
    });
    await evaluateConditions(conditions, opts);

    const expected: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt('# App\ncontext', undefined, { dismissalGuidance: false }) },
      buildConditionJudgeMessage(
        conditions,
        '<html><body><div id="page-dom">real page markup</div></body></html>',
        null,
        ['Step 1: [✓ PASSED] Open the page'],
        undefined,
        formatTestInfo('page-condition', 'https://app.test', undefined, undefined, CONFIG.browser.viewport, undefined),
        buildStepValues(conditions.join('\n'), opts),
      ),
    ];
    expect(client.requests[0]).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// §10.1 — `desktop.reportScreenshots: false` keeps the judge's capture out of
// the report (A8)
// ---------------------------------------------------------------------------

describe('the computer judge\'s recorded capture obeys desktop.reportScreenshots', () => {
  it('records no screenshot when the switch is off — but the model still got the image', async () => {
    const adapter = new FakeDesktopAdapter({ width: 200, height: 150 });
    const client = scriptedClient([JSON.stringify({ matched: 'A', actions: [], reasoning: 'yes' })]);

    const verdict = await evaluateConditions(
      ['the Print dialog is open'],
      computerOpts(client, adapter, {
        computer: { adapter, settleMs: 0, maxImageWidth: 200, reportScreenshots: false },
      }),
    );

    expect(verdict.aiInteractions).toHaveLength(1);
    // The interaction is what a guard's report row renders its turn from.
    expect(verdict.aiInteractions[0]!.screenshotBase64).toBeUndefined();
    expect(blocksOf(client.requests[0]!).some((b) => b.type === 'image_url')).toBe(true);
  });

  it('records it when the switch is on (the default)', async () => {
    const adapter = new FakeDesktopAdapter({ width: 200, height: 150 });
    const client = scriptedClient([JSON.stringify({ matched: 'A', actions: [], reasoning: 'yes' })]);

    const verdict = await evaluateConditions(['the Print dialog is open'], computerOpts(client, adapter));

    expect(verdict.aiInteractions[0]!.screenshotBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(verdict.aiInteractions[0]!.purpose).toBe('condition-judge [computer]');
  });
});

// ---------------------------------------------------------------------------
// §4.6 — switchBrowser default
// ---------------------------------------------------------------------------

describe('switchBrowser default launches the default browser on demand', () => {
  /** A tracker in the deferred state: nothing launched, `ensureLaunched`
   *  counted. Modelled rather than stubbed — a tracker that always has a
   *  browser would make the assertion vacuous. */
  function deferredTracker() {
    const page = { url: () => 'https://app.test/launched' } as unknown as Page;
    const state = { launched: false, ensureLaunched: vi.fn(), switchTo: vi.fn() };
    const tracker = {
      hasActive: () => state.launched,
      isLaunched: () => state.launched,
      async ensureLaunched() {
        state.ensureLaunched();
        state.launched = true;
        return { page };
      },
      switchTo(label: string) {
        state.switchTo(label);
        if (!state.launched) throw new Error('no browser has been launched in this session');
        return { page };
      },
      getActivePage: () => page,
      getActive: () => ({ page }),
      getActiveLabel: () => 'default',
      list: () => [],
      all: () => [],
      get count() { return state.launched ? 1 : 0; },
    };
    return { tracker, state };
  }

  async function runSwitch(label: string) {
    const { tracker, state } = deferredTracker();
    const client = scriptedClient([
      JSON.stringify({
        actions: [
          { action: 'switchBrowser', to: label, description: `Switch to ${label}` } as AIAction,
        ],
        reasoning: 'switching',
        needs_reeval: false,
      }),
    ]);
    const result = await executeStep(1, 1, `Switch to the ${label} browser`, {
      page: fakePage(),
      config: CONFIG,
      aiClient: client,
      contextContent: '',
      testName: 'switch-browser',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      browserTracker: tracker as never,
    });
    return { result, state };
  }

  it('launches, then switches, for the `default` label', async () => {
    const { result, state } = await runSwitch('default');

    expect(state.ensureLaunched).toHaveBeenCalledTimes(1);
    expect(state.switchTo).toHaveBeenCalledWith('default');
    expect(result.status).toBe('passed');
  });

  it('does not launch for any other label', async () => {
    // A named browser is one an `openBrowser` created; launching the DEFAULT
    // under that name would answer a question nobody asked.
    const { result, state } = await runSwitch('worker');

    expect(state.ensureLaunched).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('switchBrowser failed');
  });
});
