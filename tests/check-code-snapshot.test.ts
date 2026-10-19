/**
 * The snapshot a check's code is written from (step-executor.ts
 * `captureCheckCodeDom`).
 *
 * A check is planned by the step AI and its code written by a second request
 * (docs/specs/SPEC-verify-checks.md §2). That second request is sent the
 * page's whole markup, hidden elements included. It used to be clipped at a
 * fixed 100,000 characters, whatever `browser.domSnapshotCharLimit` said, so on
 * a page whose hidden menus came first the code AI never saw what the check
 * was about and guessed where it was (survey test c45).
 *
 * Against the real step loop (`executeStep`, real Chromium, a scripted model):
 *
 *  - a page that fits is sent whole, hidden elements included;
 *  - the limit is `browser.domSnapshotCharLimit`, not 100,000;
 *  - a page over the limit is sent with hidden elements left out, so what is
 *    shown after them is still there, and the code AI is told so.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { DOM_SNAPSHOT_TRUNCATION_MARKER } from '../src/browser/dom-cleaner.js';
import { executeStep } from '../src/runner/step-executor.js';

const ORIGIN = 'http://check-code-snapshot.test';

/** A collapsed menu of `links` hidden links, then the part the check reads. */
function pageWithHiddenMenu(links: number): string {
  const items = Array.from({ length: links }, (_, i) => `<li><a href="/p${i}">Menu page ${i}</a></li>`).join('');
  return `<!doctype html><html><head><title>Saved</title></head><body>
<nav><a href="/">Home</a><ul style="display:none">${items}</ul></nav>
<div id="toast" style="display:none">Draft saved</div>
<h2>Saved Values</h2>
<ul><li id="saved-note">Hello Ada</li></ul>
</body></html>`;
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function openPage(html: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto(`${ORIGIN}/saved`);
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

function textOf(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    )
    .join('\n');
}

function configWithLimit(domSnapshotCharLimit: number): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
    browser: { ...DEFAULT_CONFIG.browser, headed: false, captureScreenshotsPerAction: false, domSnapshotCharLimit },
    execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 2, promptOnAmbiguity: false },
  };
}

/** Runs the check and returns what its code AI was sent. */
async function codeRequestFor(page: Page, config: Config): Promise<string> {
  const { client, requests } = scriptedClient([
    JSON.stringify({
      actions: [{
        action: 'assert',
        condition: 'the note in the Saved Values section shows',
        expected: 'Hello Ada',
        description: 'The saved note is Hello Ada',
      }],
      reasoning: 'scripted',
      needs_reeval: false,
    }),
    JSON.stringify({
      code: "(() => { const el = document.querySelector('#saved-note'); "
        + "if (!el) return { pass: false, actual: 'element not found: #saved-note' }; "
        + "return { pass: el.innerText.trim() === 'Hello Ada', actual: el.innerText }; })()",
    }),
  ]);
  const result = await executeStep(1, 1, 'Verify the "Saved Values" section shows the note "Hello Ada"', {
    page,
    config,
    aiClient: client,
    contextContent: '',
    testName: 'check-code-snapshot',
    conversationHistory: [],
    csrfTokens: {},
    nonInteractive: true,
  });
  expect(result.status).toBe('passed');
  expect(requests.length).toBe(2);
  return textOf(requests[1]!);
}

describe('the snapshot a check code is written from', () => {
  it('sends a page that fits whole, hidden elements included', async () => {
    const page = await openPage(pageWithHiddenMenu(20));
    try {
      const sent = await codeRequestFor(page, configWithLimit(300_000));
      expect(sent).toContain('## Current Page DOM (full, uncompacted)');
      expect(sent).toContain('Menu page 19');
      expect(sent).toContain('Draft saved');
      expect(sent).toContain('id="saved-note"');
      expect(sent).not.toContain(DOM_SNAPSHOT_TRUNCATION_MARKER);
    } finally {
      await page.context().close();
    }
  });

  it('clips at browser.domSnapshotCharLimit, not at 100,000 characters', async () => {
    // About 150,000 characters of hidden menu: over the old fixed cut, under
    // the limit the config sets.
    const page = await openPage(pageWithHiddenMenu(3_000));
    try {
      const sent = await codeRequestFor(page, configWithLimit(300_000));
      expect(sent.length).toBeGreaterThan(100_000);
      expect(sent).toContain('## Current Page DOM (full, uncompacted)');
      expect(sent).toContain('Menu page 2999');
      expect(sent).toContain('id="saved-note"');
      expect(sent).not.toContain(DOM_SNAPSHOT_TRUNCATION_MARKER);
    } finally {
      await page.context().close();
    }
  });

  it('leaves hidden elements out of a page over the limit, and says so', async () => {
    const page = await openPage(pageWithHiddenMenu(3_000));
    try {
      const sent = await codeRequestFor(page, configWithLimit(20_000));
      expect(sent).toContain('## Current Page DOM (uncompacted, hidden elements left out)');
      expect(sent).toContain('<!-- hidden: ');
      expect(sent).not.toContain('Menu page 0');
      expect(sent).not.toContain('Draft saved');
      // What the check is about comes after the menu, and is there.
      expect(sent).toContain('Saved Values');
      expect(sent).toContain('<li id="saved-note">');
      expect(sent).not.toContain(DOM_SNAPSHOT_TRUNCATION_MARKER);
    } finally {
      await page.context().close();
    }
  });
});
