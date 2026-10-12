/**
 * The browser-dialog note reaches the model that acts (issue 31).
 *
 * A page that opens `alert`, `confirm` or `prompt` is answered at once and the
 * dialog recorded; the model learns about it from a note after the markup of
 * its next snapshot (SPEC-web-survey-fixes.md §2.1). Every capture used to
 * mark the records shown, and the step loop takes a capture for the report
 * straight after each action — so the note was used up before the model's
 * next turn, and the model never learned an alert had appeared.
 *
 * Against the real step loop (`executeStep`, real Chromium, a scripted model):
 *
 *  - the turn after the click that raised the alert is told about it, once;
 *  - the report's capture after the click carries the note too;
 *  - a `get_page_content` read in between (the server's `capturePageContent`)
 *    gets its own note and does not use up the model's.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';

/** What runs while the step loop settles after an action: between the action
 *  (and its report capture) and the model's next turn. */
const between = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));

/** How many of the next DOM captures fail as a timed-out capture does: in
 *  band, before the dialog note is added (dom-cleaner.ts). */
const failing = vi.hoisted(() => ({ captures: 0 }));

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return {
    ...actual,
    captureDomSnapshot: async (...args: Parameters<typeof actual.captureDomSnapshot>) => {
      if (failing.captures > 0) {
        failing.captures--;
        return '<error>DOM capture timed out: scripted</error>';
      }
      return actual.captureDomSnapshot(...args);
    },
  };
});

// The post-action settle is timing and nothing else, and it is the one place
// the loop waits between an action and the next turn — so it is where a
// reader outside the run gets its chance to read the page.
vi.mock('../src/browser/page-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser/page-state.js')>()),
  waitForPostActionSettle: async () => {
    await between.hook?.();
  },
}));

import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { installDialogGuard } from '../src/browser/manager.js';
import { executeStep } from '../src/runner/step-executor.js';
import { capturePageContent } from '../src/server/page-capture.js';

const ORIGIN = 'http://dialog-note.test';

/** One button that raises an alert, one that does nothing a dialog would. */
const PAGE = `<!doctype html><html><head><title>Greeting</title></head><body>
<button id="ask" type="button">Ask</button>
<button id="next" type="button">Continue</button>
<p id="out"></p>
<script>
  document.getElementById('ask').addEventListener('click', () => { alert('Hello Ada'); });
  document.getElementById('next').addEventListener('click', () => {
    document.getElementById('out').textContent = 'continued';
  });
</script>
</body></html>`;

const NOTE = 'Browser dialogs answered since the last snapshot';
const ALERT = '[alert] "Hello Ada" — dismissed by default';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});
beforeEach(() => {
  between.hook = null;
  failing.captures = 0;
});

/** A fresh context per test: dialog records are kept per context. */
async function greetingPage(): Promise<Page> {
  const context = await browser.newContext();
  installDialogGuard(context);
  const page = await context.newPage();
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  await page.goto(`${ORIGIN}/start`);
  return page;
}

/** Replays `responses` in order, repeating the last, and keeps every request. */
function scriptedClient(responses: string[]): { client: AiClient; requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const text = responses[Math.min(requests.length, responses.length - 1)]!;
      requests.push(messages);
      return { text, model: 'scripted' };
    },
  } as unknown as AiClient;
  return { client, requests };
}

function turn(action: Record<string, unknown>, needsReeval: boolean): string {
  return JSON.stringify({ actions: [action], reasoning: 'scripted', needs_reeval: needsReeval });
}

function textOf(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    )
    .join('\n');
}

const config: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, headed: false, captureScreenshotsPerAction: false },
  reports: { ...DEFAULT_CONFIG.reports, includeDomSnapshots: true },
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 3, promptOnAmbiguity: false },
};

/** "Click Ask and check what the alert said, then click Continue", as three
 *  turns: the click that raises the alert, a look, and Continue. */
async function runGreeting(page: Page) {
  const { client, requests } = scriptedClient([
    turn({ action: 'click', selector: '#ask', description: 'Click Ask' }, true),
    turn({ action: 'scroll', direction: 'down', description: 'Look at the page' }, true),
    turn({ action: 'click', selector: '#next', description: 'Click Continue' }, false),
  ]);
  const result = await executeStep(1, 1, 'Click Ask and check what the alert said, then click Continue', {
    page,
    config,
    aiClient: client,
    contextContent: '',
    testName: 'dialog-note',
    conversationHistory: [],
    csrfTokens: {},
    nonInteractive: true,
  });
  return { result, requests };
}

describe('the dialog note reaches the model that acts (issue 31)', () => {
  it('tells the turn after the click about the alert, and only that turn', async () => {
    const page = await greetingPage();
    try {
      const { result, requests } = await runGreeting(page);
      expect(result.status).toBe('passed');
      expect(requests).toHaveLength(3);

      // Turn 1 ran before the alert.
      expect(textOf(requests[0]!)).not.toContain(NOTE);
      // Turn 2 is the model's first look since the alert: it is told.
      expect(textOf(requests[1]!)).toContain(NOTE);
      expect(textOf(requests[1]!)).toContain(ALERT);
      // Turn 3 has been told already.
      expect(textOf(requests[2]!)).not.toContain(NOTE);

      // The report's capture after the click shows it as well — taking it
      // is what used to use the note up.
      const afterClick = result.turns[0]!.subActions[0]!.domSnapshot ?? '';
      expect(afterClick).toContain(ALERT);
      expect(await page.textContent('#out')).toBe('continued');
    } finally {
      await page.context().close();
    }
  });

  it('a turn whose reply never arrives does not use up the note: the retry is told', async () => {
    const page = await greetingPage();
    try {
      const { client, requests } = scriptedClient([
        turn({ action: 'click', selector: '#ask', description: 'Click Ask' }, true),
        'not a reply the parser can read',
        turn({ action: 'click', selector: '#next', description: 'Click Continue' }, false),
      ]);
      const result = await executeStep(1, 1, 'Click Ask and check what the alert said, then click Continue', {
        page,
        config: { ...config, execution: { ...config.execution, retries: 1 } },
        aiClient: client,
        contextContent: '',
        testName: 'dialog-note',
        conversationHistory: [],
        csrfTokens: {},
        nonInteractive: true,
      });
      expect(requests).toHaveLength(3);
      // The turn whose reply failed was sent the note…
      expect(textOf(requests[1]!)).toContain(ALERT);
      // …and the retry, the model that goes on to act, is sent it too.
      expect(textOf(requests[2]!)).toContain(ALERT);
      expect(result.status).toBe('passed');
    } finally {
      await page.context().close();
    }
  });

  it('a turn whose capture failed does not use up the note: the next turn is told', async () => {
    const page = await greetingPage();
    // After the click: the report's capture and turn 2's both fail.
    let armed = true;
    between.hook = async () => {
      if (armed) failing.captures = 2;
      armed = false;
    };
    try {
      const { result, requests } = await runGreeting(page);
      expect(requests).toHaveLength(3);
      // Turn 2 was sent the failure, not the note…
      expect(textOf(requests[1]!)).toContain('DOM capture timed out: scripted');
      expect(textOf(requests[1]!)).not.toContain(NOTE);
      // …so turn 3 is the model's first sight of the alert.
      expect(textOf(requests[2]!)).toContain(ALERT);
      expect(result.status).toBe('passed');
    } finally {
      await page.context().close();
    }
  });

  it('a get_page_content read between the turns gets the note without using up the model\'s', async () => {
    const page = await greetingPage();
    const reads: string[] = [];
    between.hook = async () => {
      const read = await capturePageContent(page, config.browser, { format: 'dom', maxChars: 1_000_000 });
      reads.push(read.content);
    };
    try {
      const { requests } = await runGreeting(page);
      expect(requests).toHaveLength(3);

      // The reader after the click is told; the reader after the next action
      // has been told already.
      expect(reads[0]).toContain(ALERT);
      expect(reads.slice(1).some((r) => r.includes(NOTE))).toBe(false);

      // And the model is told all the same.
      expect(textOf(requests[1]!)).toContain(ALERT);
      expect(textOf(requests[2]!)).not.toContain(NOTE);
    } finally {
      await page.context().close();
    }
  });
});
