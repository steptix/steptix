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
  COMPUTER_CONDITION_NO_DOM,
  evaluateConditions,
  executeStep,
} from '../src/runner/step-executor.js';
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

describe('a condition on the computer surface is judged from the screen', () => {
  it('sends the capture and no DOM', async () => {
    const adapter = new FakeDesktopAdapter({ width: 200, height: 150 });
    const client = scriptedClient([
      JSON.stringify({ matched: 'A', actions: [], reasoning: 'the Save As window is up' }),
    ]);

    const verdict = await evaluateConditions(['a window titled "Save As" is open'], {
      page: undefined as never,
      config: CONFIG,
      aiClient: client,
      contextContent: '',
      testName: 'computer-condition',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      computer: { adapter, settleMs: 0, maxImageWidth: 200, reportScreenshots: true },
    });

    expect(verdict.selected).toBe(0);
    // No DOM was captured at all — not a captured one that was then dropped.
    expect(domCalls.count).toBe(0);
    const blocks = blocksOf(client.requests[0]!);
    const image = blocks.find((b) => b.type === 'image_url');
    expect(image).toBeDefined();
    expect(image!.image_url!.url).toMatch(/^data:image\/png;base64,/);
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    expect(text).toContain(COMPUTER_CONDITION_NO_DOM);
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
    expect(text).not.toContain(COMPUTER_CONDITION_NO_DOM);
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
