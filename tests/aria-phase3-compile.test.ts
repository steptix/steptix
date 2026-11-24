/**
 * Unit tests for Phase 3 of `docs/specs/SPEC-aria-ref-snapshots.md`:
 *  - §5.2 Plural `read[multiple]` and `count` via `containerRef` + `exampleRefs`
 *    (`deriveRepeatingSelectorInPage`), `listReadConcern`, `unprovenListRead`,
 *    and `formatListReadsSection` in `'aria'` mode
 *  - §7.1 Dual locator measurement (`normalizedLocator`, `normalizedBy`,
 *    `elementContextHtml` with password masking, `drag` target locators,
 *    and `noop` `foundRef` measurement)
 *  - §7.2 Zero-LLM `fromRecording` compilation for ref-based reads/counts and
 *    multi-turn `waitType: "change"` folding (`actionsOf`)
 *  - §7.3 Hard static guards across `generate.ts`, `review.ts`, and `repair.ts`
 *    (`ephemeralRefInCodeComplaint`, `recordedReadMismatch`, `buildRepairPrompt`,
 *    and `waitTimeoutDroppedComplaint`)
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import {
  buildContinuationMessage,
  buildStepCodePrompt,
  contentBlocksToText,
  formatListReadsSection,
} from '../src/ai/prompts.js';
import { captureAriaPageSnapshot, expandAriaSubtree } from '../src/browser/aria-snapshot.js';
import { executeAction } from '../src/browser/actions.js';
import { listReadConcern, unprovenListRead } from '../src/runner/list-read-review.js';
import type { StepResult, SubActionResult } from '../src/report/types.js';
import { actionsOf, type RecordedAction } from '../src/codebehind/recording.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import {
  EPHEMERAL_REF_WITHHELD,
  accountPlaceholders,
  askCheckedRepair,
  conditionEntryComplaint,
  entryFaults,
  entryFromRecording,
  ephemeralRefInCodeComplaint,
  generateStepEntry,
  recordedReadMismatch,
  waitTimeoutDroppedComplaint,
} from '../src/codebehind/generate.js';
import { Candidate } from '../src/codebehind/candidate.js';
import { LiveCompiler, type LiveCompileEvent } from '../src/codebehind/live-compile.js';
import { buildRepairPrompt } from '../src/codebehind/repair.js';
import { reviewCandidate } from '../src/codebehind/review.js';
import { logger } from '../src/utils/logger.js';

function extractRef(snapshot: string, lineMatcher: RegExp): string {
  const line = snapshot.split('\n').find((l) => lineMatcher.test(l));
  expect(
    line,
    `expected snapshot line matching ${lineMatcher}\n--- snapshot ---\n${snapshot}`,
  ).toBeDefined();
  const match = /\[ref=((?:f\d+)?e\d+|s\d+)\]/.exec(line!);
  expect(match, `expected [ref=...] on line: ${line}`).not.toBeNull();
  return match![1]!;
}

function bindingFor(source: string, over: Partial<CodeBehindBinding> = {}): CodeBehindBinding {
  return {
    file: path.resolve(path.sep, 'proj', 'shipments.steps.ts'),
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    ...over,
  };
}

function makeStepResult(
  turns: SubActionResult[][],
  over: Partial<StepResult> = {},
): StepResult {
  return {
    index: 1,
    instruction: 'Execute step',
    status: 'passed',
    durationMs: 25,
    retried: false,
    turns: turns.map((subActions, idx) => ({
      turnNumber: idx + 1,
      attemptNumber: 1,
      timestamp: '2026-11-24T00:00:00Z',
      aiInteractions: [],
      subActions,
    })),
    ...over,
  };
}

function scriptedAi(
  ...answers: Array<string | { entry: string | null; reason?: string } | { file: string }>
): { client: AiClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const last = messages[messages.length - 1]!;
      prompts.push(contentBlocksToText(last.content));
      const answer = answers[Math.min(prompts.length - 1, answers.length - 1)]!;
      const payload = typeof answer === 'string' ? { entry: answer } : answer;
      return { text: JSON.stringify(payload), model: 'phase3-stub' };
    },
  } as unknown as AiClient;
  return { client, prompts };
}

let browser: Browser;
let context: BrowserContext;
let tempDir: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-phase3-compile-'));
  await fs.writeFile(
    path.join(tempDir, '.prettierrc'),
    JSON.stringify({ singleQuote: true, printWidth: 100, trailingComma: 'all' }),
    'utf-8',
  );
}, 60_000);

afterAll(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function countDeriveArtifacts(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('[data-steptix-derive-root], [data-steptix-derive-ex]').length,
  );
}

// ---------------------------------------------------------------------------
// 1. Plural read[multiple] and count via containerRef + exampleRefs (SPEC §5.2)
// ---------------------------------------------------------------------------

describe('Phase 3 plural read[multiple] and count via containerRef + exampleRefs (SPEC §5.2)', () => {
  it('derives repeating selector for a 3-item card list after expandAriaSubtree, ignores sibling metadata, and cleans up derive attributes', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <ul id="shipments-list" aria-label="Shipments">
      <li class="shipment-card">
        <span class="item-title">Alpha</span>
        <span class="item-price">$10</span>
      </li>
      <li class="shipment-card">
        <span class="item-title">Bravo</span>
        <span class="item-price">$20</span>
      </li>
      <li class="shipment-card">
        <span class="item-title">Charlie</span>
        <span class="item-price">$30</span>
      </li>
    </ul>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const containerRef = extractRef(snapshot, /list "Shipments"/);

      const expanded = await expandAriaSubtree(page, { ref: containerRef });
      const sRef1Match = /<span[^>]*data-steptix-ref="(s\d+)"[^>]*>\s*Alpha/.exec(expanded.content);
      const sRef2Match = /<span[^>]*data-steptix-ref="(s\d+)"[^>]*>\s*Bravo/.exec(expanded.content);
      expect(sRef1Match, `expected stamped Alpha span in:\n${expanded.content}`).not.toBeNull();
      expect(sRef2Match, `expected stamped Bravo span in:\n${expanded.content}`).not.toBeNull();
      const sRef1 = sRef1Match![1]!;
      const sRef2 = sRef2Match![1]!;

      const readRes = await executeAction(
        page,
        {
          action: 'read',
          multiple: true,
          containerRef,
          exampleRefs: [sRef1, sRef2],
          as: 'item_titles',
          description: 'Read all item titles',
        },
        undefined,
        undefined,
        { measure: true },
      );

      expect(readRes.success, readRes.error).toBe(true);
      expect(readRes.capturedValues).toEqual(['Alpha', 'Bravo', 'Charlie']);
      expect(readRes.targeting?.matchCount).toBe(3);
      expect(readRes.targeting?.kinds).toEqual(['span.item-title']);
      expect(readRes.targeting?.resolvedSelector).toBeDefined();
      const derivedSel = readRes.targeting!.resolvedSelector!;
      expect(derivedSel).not.toContain('aria-ref=');
      expect(derivedSel).not.toContain('data-steptix-ref');
      expect(derivedSel).not.toContain('data-steptix-derive');
      expect(await page.locator(derivedSel).allTextContents()).toEqual(['Alpha', 'Bravo', 'Charlie']);
      expect(await countDeriveArtifacts(page)).toBe(0);

      const countRes = await executeAction(
        page,
        {
          action: 'count',
          containerRef,
          exampleRefs: [sRef1, sRef2],
          as: 'item_count',
          description: 'Count item titles',
        },
        undefined,
        undefined,
        { measure: true },
      );
      expect(countRes.success, countRes.error).toBe(true);
      expect(countRes.capturedValue).toBe('3');
      expect(countRes.targeting?.resolvedSelector).toBe(derivedSel);
      expect(countRes.targeting?.kinds).toEqual(['span.item-title']);
      expect(await countDeriveArtifacts(page)).toBe(0);
    });
  });

  it('derives a repeating nth-child/nth-of-type leaf selector when sibling spans have no class names', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <ul id="plain-shipments" aria-label="Shipments">
      <li><span>Alpha</span><span>$10</span></li>
      <li><span>Bravo</span><span>$20</span></li>
      <li><span>Charlie</span><span>$30</span></li>
    </ul>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const containerRef = extractRef(snapshot, /list "Shipments"/);
      const expanded = await expandAriaSubtree(page, { ref: containerRef });
      const sRef1 = /<span[^>]*data-steptix-ref="(s\d+)"[^>]*>\s*Alpha/.exec(expanded.content)?.[1];
      const sRef2 = /<span[^>]*data-steptix-ref="(s\d+)"[^>]*>\s*Bravo/.exec(expanded.content)?.[1];
      expect(sRef1).toBeDefined();
      expect(sRef2).toBeDefined();

      const res = await executeAction(
        page,
        {
          action: 'read',
          multiple: true,
          containerRef,
          exampleRefs: [sRef1!, sRef2!],
          as: 'plain_titles',
          description: 'Read unclassed item titles',
        },
        undefined,
        undefined,
        { measure: true },
      );

      expect(res.success, res.error).toBe(true);
      expect(res.capturedValues).toEqual(['Alpha', 'Bravo', 'Charlie']);
      expect(res.targeting?.kinds).toEqual(['span']);
      expect(res.targeting?.resolvedSelector).toBeDefined();
      expect(await page.locator(res.targeting!.resolvedSelector!).allTextContents()).toEqual([
        'Alpha',
        'Bravo',
        'Charlie',
      ]);
      expect(await countDeriveArtifacts(page)).toBe(0);
    });
  });

  it('derives repeating selector for a 1-item table/list via exampleRefs: [eRef1] and generalizes to additional rows', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <table id="shipments-table" aria-label="Shipments">
      <thead>
        <tr><th>Code</th><th>Owner</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><a class="shipment-link" href="#shp-101">SHP-101</a></td>
          <td>Ada</td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const containerRef = extractRef(snapshot, /table "Shipments"/);
      const eRef1 = extractRef(snapshot, /link "SHP-101"/);
      expect(eRef1).toMatch(/^e\d+$/);

      const readRes = await executeAction(
        page,
        {
          action: 'read',
          multiple: true,
          containerRef,
          exampleRefs: [eRef1],
          as: 'shipment_codes',
          description: 'Read shipment codes',
        },
        undefined,
        undefined,
        { measure: true },
      );

      expect(readRes.success, readRes.error).toBe(true);
      expect(readRes.capturedValues).toEqual(['SHP-101']);
      expect(readRes.targeting?.matchCount).toBe(1);
      expect(readRes.targeting?.resolvedSelector).toBeDefined();
      const derivedSel = readRes.targeting!.resolvedSelector!;
      expect(derivedSel).not.toContain('aria-ref=');
      expect(derivedSel).not.toContain('data-steptix-derive');
      expect(await countDeriveArtifacts(page)).toBe(0);

      const countRes = await executeAction(
        page,
        {
          action: 'count',
          containerRef,
          exampleRefs: [eRef1],
          as: 'shipment_count',
          description: 'Count shipments',
        },
        undefined,
        undefined,
        { measure: true },
      );
      expect(countRes.success, countRes.error).toBe(true);
      expect(countRes.capturedValue).toBe('1');
      expect(countRes.targeting?.resolvedSelector).toBe(derivedSel);
      expect(await countDeriveArtifacts(page)).toBe(0);

      // Adding a second row proves the derived selector repeats across rows rather than pinning row 1.
      await page.evaluate(() => {
        const tbody = document.querySelector('#shipments-table tbody')!;
        const tr = document.createElement('tr');
        tr.innerHTML = '<td><a class="shipment-link" href="#shp-102">SHP-102</a></td><td>Lin</td>';
        tbody.appendChild(tr);
      });
      expect(await page.locator(derivedSel).allTextContents()).toEqual(['SHP-101', 'SHP-102']);
    });
  });

  it('handles 0-item empty list (exampleRefs: []) with undefined resolvedSelector and unprovenListRead withholding compilation', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <section id="empty-shipments" aria-label="Shipments">
      <p>No shipments queued.</p>
    </section>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const containerRef = extractRef(snapshot, /region "Shipments"/);

      const readAction: AIAction = {
        action: 'read',
        multiple: true,
        containerRef,
        exampleRefs: [],
        as: 'shipments',
        description: 'Read queued shipments',
      };
      const readRes = await executeAction(page, readAction, undefined, undefined, { measure: true });
      expect(readRes.success, readRes.error).toBe(true);
      expect(readRes.capturedValues).toEqual([]);
      expect(readRes.targeting?.matchCount).toBe(0);
      expect(readRes.targeting?.resolvedSelector).toBeUndefined();

      const countAction: AIAction = {
        action: 'count',
        containerRef,
        exampleRefs: [],
        as: 'shipment_count',
        description: 'Count queued shipments',
      };
      const countRes = await executeAction(page, countAction, undefined, undefined, { measure: true });
      expect(countRes.success, countRes.error).toBe(true);
      expect(countRes.capturedValue).toBe('0');
      expect(countRes.targeting?.matchCount).toBe(0);
      expect(countRes.targeting?.resolvedSelector).toBeUndefined();

      const readConcern = listReadConcern(readAction, readRes);
      expect(readConcern).toBeDefined();
      expect(readConcern!.kind).toBe('empty');
      expect(readConcern!.name).toBe('shipments');
      expect(readConcern!.text).toContain(`containerRef=${containerRef} exampleRefs=[]`);

      const readStepResult = makeStepResult([
        [
          {
            index: 1,
            action: readAction,
            durationMs: 10,
            ...(readRes.targeting && { targeting: readRes.targeting }),
            listReview: {
              kind: readConcern!.kind,
              text: readConcern!.text,
              outcome: 'kept',
            },
          },
        ],
      ]);
      const unprovenRead = unprovenListRead(readStepResult);
      expect(unprovenRead).toBeDefined();
      expect(unprovenRead!.kind).toBe('empty');
      expect(unprovenRead!.name).toBe('shipments');

      const countConcern = listReadConcern(countAction, countRes);
      expect(countConcern?.kind).toBe('empty');
      const countStepResult = makeStepResult([
        [
          {
            index: 1,
            action: countAction,
            durationMs: 10,
            ...(countRes.targeting && { targeting: countRes.targeting }),
            listReview: {
              kind: countConcern!.kind,
              text: countConcern!.text,
              outcome: 'kept',
            },
          },
        ],
      ]);
      const unprovenCount = unprovenListRead(countStepResult);
      expect(unprovenCount).toBeDefined();
      expect(unprovenCount!.kind).toBe('empty');
      expect(unprovenCount!.name).toBe('shipment_count');
      expect(unprovenCount!.reason).toContain('counted 0');
    });
  });

  it('returns clean validation errors for missing exampleRefs, out-of-container exampleRef, and cross-frame mismatch', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <button id="outside-btn" type="button">Outside Control</button>
    <ul id="shipments-list" aria-label="Shipments">
      <li><a href="#shp-101">SHP-101</a></li>
    </ul>
    <iframe id="child-frame" title="Child Frame" srcdoc='<!doctype html><html><body><button id="frame-item" type="button">Frame Shipment</button></body></html>'></iframe>
  </body>
</html>`);
      await page.frameLocator('#child-frame').locator('#frame-item').waitFor({ state: 'visible' });

      const snapshot = await captureAriaPageSnapshot(page);
      const containerRef = extractRef(snapshot, /list "Shipments"/);
      const outsideRef = extractRef(snapshot, /button "Outside Control"/);
      const frameItemRef = extractRef(snapshot, /button "Frame Shipment"/);
      expect(frameItemRef).toMatch(/^f\d+e\d+$/);

      const missingExamples = await executeAction(page, {
        action: 'read',
        multiple: true,
        containerRef,
        as: 'shipments',
        description: 'Read without exampleRefs',
      });
      expect(missingExamples.success).toBe(false);
      expect(missingExamples.error).toContain('exampleRefs');

      const outsideExample = await executeAction(page, {
        action: 'read',
        multiple: true,
        containerRef,
        exampleRefs: [outsideRef],
        as: 'shipments',
        description: 'Read with exampleRef outside containerRef',
      });
      expect(outsideExample.success).toBe(false);
      expect(outsideExample.error).toContain('must sit inside containerRef');
      expect(await countDeriveArtifacts(page)).toBe(0);

      const crossFrame = await executeAction(page, {
        action: 'count',
        containerRef,
        exampleRefs: [frameItemRef],
        as: 'shipment_count',
        description: 'Count with cross-frame exampleRef',
      });
      expect(crossFrame.success).toBe(false);
      expect(crossFrame.error).toContain('same frame');
      expect(await countDeriveArtifacts(page)).toBe(0);
    });
  });

  it('formats listReadConcern and formatListReadsSection in aria mode with containerRef/exampleRefs/expand guidance', () => {
    const action: AIAction = {
      action: 'read',
      multiple: true,
      containerRef: 'e8',
      exampleRefs: ['e12', 'e15'],
      as: 'shipments',
      description: 'Read shipment titles',
    };

    const emptyConcern = listReadConcern(action, {
      success: true,
      capturedValues: [],
      listMatches: { groups: [] },
    });
    expect(emptyConcern).toBeDefined();
    expect(emptyConcern!.kind).toBe('empty');
    expect(emptyConcern!.text).toContain('`containerRef=e8 exampleRefs=[e12, e15]`');
    expect(emptyConcern!.summary).toContain('`containerRef=e8 exampleRefs=[e12, e15]`');

    const mixedConcern = listReadConcern(action, {
      success: true,
      capturedValues: ['SHP-101', '$10'],
      listMatches: {
        groups: [
          { kind: 'span.item-title', count: 1, samples: ['SHP-101'] },
          { kind: 'span.item-price', count: 1, samples: ['$10'] },
        ],
      },
    });
    expect(mixedConcern).toBeDefined();
    expect(mixedConcern!.kind).toBe('mixed');
    expect(mixedConcern!.text).toContain('`containerRef=e8 exampleRefs=[e12, e15]`');
    expect(mixedConcern!.text).toContain('span.item-title');
    expect(mixedConcern!.text).toContain('span.item-price');

    const ariaReviewPrompt = formatListReadsSection([mixedConcern!.text], true, 'aria');
    expect(ariaReviewPrompt).toContain('containerRef=e8 exampleRefs=[e12, e15]');
    expect(ariaReviewPrompt).toContain('"containerRef"');
    expect(ariaReviewPrompt).toContain('"exampleRefs"');
    expect(ariaReviewPrompt).toContain('"expand"');
    expect(ariaReviewPrompt).not.toContain('with a selector that matches only what the step asks for');

    const ariaContinuePrompt = formatListReadsSection([emptyConcern!.text], false, 'aria');
    expect(ariaContinuePrompt).toContain('"containerRef"');
    expect(ariaContinuePrompt).toContain('"exampleRefs"');
    expect(ariaContinuePrompt).toContain('"expand"');

    const domReviewPrompt = formatListReadsSection([mixedConcern!.text], true, 'dom');
    expect(domReviewPrompt).toContain('with a selector that matches only what the step asks for');
  });
});

// ---------------------------------------------------------------------------
// 2. Dual Locator Measurement (SPEC §7.1)
// ---------------------------------------------------------------------------

describe('Phase 3 dual locator measurement (SPEC §7.1)', () => {
  it('measures normalizedLocator, normalizedBy: "testid", and matchCount: 1 on a data-testid button clicked by ref', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <button data-testid="submit-btn" type="button" onclick="window.__saved = true">Save</button>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const saveRef = extractRef(snapshot, /button "Save"/);

      const res = await executeAction(
        page,
        { action: 'click', ref: saveRef, description: 'Click Save' },
        undefined,
        undefined,
        { measure: true },
      );

      expect(res.success, res.error).toBe(true);
      expect(res.targeting?.normalizedLocator).toBe("getByTestId('submit-btn')");
      expect(res.targeting?.normalizedBy).toBe('testid');
      expect(res.targeting?.matchCount).toBe(1);
      expect(res.targeting?.resolvedSelector).toBe('[data-testid="submit-btn"]');
      expect(await page.evaluate(() => (window as unknown as { __saved?: boolean }).__saved)).toBe(true);
    });
  });

  it('measures normalizedLocator and row elementContextHtml while masking password inputs in the same row', async () => {
    const secretVal = 'phase3-compile-test-secret';
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <table id="shipments">
      <tbody>
        <tr>
          <td>SHP-101</td>
          <td><label>Carrier<input type="text"></label></td>
          <td><input type="password" value="${secretVal}"></td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const carrierRef = extractRef(snapshot, /textbox "Carrier"/);

      const res = await executeAction(
        page,
        { action: 'type', ref: carrierRef, value: 'Ada Freight', description: 'Enter carrier' },
        undefined,
        undefined,
        { measure: true },
      );

      expect(res.success, res.error).toBe(true);
      expect(res.targeting?.matchCount).toBe(1);
      expect(res.targeting?.normalizedLocator).toBeDefined();
      expect(res.targeting!.normalizedLocator).toMatch(
        /^getBy(?:Role\('textbox',\s*\{\s*name:\s*'Carrier'\s*\}\)|Label\('Carrier'\))$/,
      );
      expect(['role', 'label']).toContain(res.targeting?.normalizedBy);

      const ctxHtml = res.targeting?.elementContextHtml;
      expect(ctxHtml).toBeDefined();
      expect(ctxHtml).toContain('<tr>');
      expect(ctxHtml).toContain('SHP-101');
      expect(ctxHtml).toContain('value="***"');
      expect(ctxHtml).not.toContain(secretVal);

      expect(await page.getByLabel('Carrier').inputValue()).toBe('Ada Freight');
    });
  });

  it('records targetNormalizedLocator and targetResolvedSelector on drag with ref + targetRef + measure: true', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <head>
    <style>
      #drag-source, #drop-zone {
        width: 180px;
        height: 48px;
        line-height: 48px;
        margin: 12px;
        padding: 0 12px;
        border: 1px solid #333;
      }
    </style>
  </head>
  <body>
    <button id="drag-source" type="button" draggable="true">SHP-101 Parcel</button>
    <div id="drop-zone" data-testid="dispatch-lane" role="region" aria-label="Dispatch Lane">Dispatch Lane</div>
    <p id="drop-result">waiting</p>
    <script>
      const src = document.getElementById('drag-source');
      const dst = document.getElementById('drop-zone');
      src.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', 'SHP-101');
        e.dataTransfer.effectAllowed = 'move';
      });
      dst.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      dst.addEventListener('drop', (e) => {
        e.preventDefault();
        document.getElementById('drop-result').textContent = 'dropped:' + e.dataTransfer.getData('text/plain');
      });
    </script>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const srcRef = extractRef(snapshot, /button "SHP-101 Parcel"/);
      const dstRef = extractRef(snapshot, /region "Dispatch Lane"/);

      const res = await executeAction(
        page,
        {
          action: 'drag',
          ref: srcRef,
          targetRef: dstRef,
          description: 'Drag parcel to Dispatch Lane',
        },
        undefined,
        undefined,
        { measure: true },
      );

      expect(res.success, res.error).toBe(true);
      expect(await page.locator('#drop-result').textContent()).toBe('dropped:SHP-101');
      expect(res.targeting?.resolvedSelector).toBe('#drag-source');
      expect(res.targeting?.normalizedLocator).toBeDefined();
      expect(res.targeting?.targetNormalizedLocator).toBe("getByTestId('dispatch-lane')");
      expect(res.targeting?.targetResolvedSelector).toBe('[data-testid="dispatch-lane"]');
      expect(res.targeting!.targetNormalizedLocator).not.toContain('aria-ref=');
      expect(await page.locator(res.targeting!.targetResolvedSelector!).getAttribute('id')).toBe('drop-zone');
    });
  });

  it('records targeting.normalizedLocator and targeting.resolvedSelector on noop with foundRef + measure: true', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <label for="otp-code">Verification code</label>
    <input id="otp-code" type="text">
    <iframe id="verify-frame" title="Verify Frame" srcdoc='<!doctype html><html><body><button id="frame-ready" data-testid="frame-ready-btn" type="button">Ready</button></body></html>'></iframe>
  </body>
</html>`);
      await page.frameLocator('#verify-frame').locator('#frame-ready').waitFor({ state: 'visible' });

      const snapshot = await captureAriaPageSnapshot(page);
      const otpRef = extractRef(snapshot, /textbox "Verification code"/);
      const frameBtnRef = extractRef(snapshot, /button "Ready"/);

      const mainRes = await executeAction(
        page,
        { action: 'noop', foundRef: otpRef, description: 'Verification code field appeared' },
        undefined,
        undefined,
        { measure: true },
      );
      expect(mainRes.success, mainRes.error).toBe(true);
      expect(mainRes.targeting?.matchCount).toBe(1);
      expect(mainRes.targeting?.resolvedSelector).toBe('#otp-code');
      expect(mainRes.targeting?.normalizedLocator).toBeDefined();
      expect(mainRes.targeting!.normalizedLocator).not.toContain('aria-ref=');
      expect(mainRes.targeting!.normalizedLocator).toContain('Verification code');
      expect(mainRes.targeting?.normalizedBy).toBeDefined();

      const frameRes = await executeAction(
        page,
        { action: 'noop', foundRef: frameBtnRef, description: 'Frame ready button appeared' },
        undefined,
        undefined,
        { measure: true },
      );
      expect(frameRes.success, frameRes.error).toBe(true);
      expect(frameRes.resolvedFrame).toBe('#verify-frame');
      expect(frameRes.targeting?.resolvedSelector).toBe('[data-testid="frame-ready-btn"]');
      expect(frameRes.targeting?.normalizedLocator).toBe("getByTestId('frame-ready-btn')");
      expect(frameRes.targeting!.normalizedLocator).not.toContain('contentFrame');
      expect(
        await page
          .frameLocator('#verify-frame')
          .locator(frameRes.targeting!.resolvedSelector!)
          .getAttribute('id'),
      ).toBe('frame-ready');
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Zero-LLM fromRecording Compilation & Wait Folding (SPEC §7.2)
// ---------------------------------------------------------------------------

describe('Phase 3 zero-LLM fromRecording compilation & wait folding (SPEC §7.2)', () => {
  it('compiles singular read, plural read, and plural count ref actions from recording with 0 LLM calls', async () => {
    const singularStep = 'Read the total amount [store as: total_amount]';
    const singularAction: RecordedAction = {
      action: 'read',
      ref: 'e5',
      as: 'total_amount',
      description: 'Read total amount',
      targeting: {
        matchCount: 1,
        resolvedSelector: '#total-amount',
        resolvedBy: 'attribute',
        kinds: ['span.total'],
      },
    };

    const pluralStep = 'Read every item title [store as: item_titles]';
    const expandAction: RecordedAction = {
      action: 'expand',
      ref: 'e8',
      description: 'Inspect item list',
    };
    const pluralAction: RecordedAction = {
      action: 'read',
      multiple: true,
      containerRef: 'e8',
      exampleRefs: ['s1', 's2'],
      as: 'item_titles',
      description: 'Read all item titles',
      targeting: {
        matchCount: 3,
        resolvedSelector: '#items > li > span.title',
        resolvedBy: 'scoped',
        kinds: ['span.title'],
      },
    };

    const countStep = 'Count the shipment items [store as: item_count]';
    const countAction: RecordedAction = {
      action: 'count',
      containerRef: 'e8',
      exampleRefs: ['s1', 's2'],
      as: 'item_count',
      description: 'Count shipment items',
      targeting: {
        matchCount: 3,
        resolvedSelector: '#items > li > span.title',
        resolvedBy: 'scoped',
        kinds: ['span.title'],
      },
    };

    // Direct `entryFromRecording` checks (generate.ts)
    const singularEntry = entryFromRecording({
      binding: bindingFor(singularStep),
      actions: [singularAction],
      resolvedParameters: {},
    });
    expect(singularEntry).toBeDefined();
    expect(singularEntry).toContain('fromRecording: true');
    expect(singularEntry).toContain("selector: '#total-amount'");
    expect(singularEntry).toContain("as: 'total_amount'");
    expect(singularEntry).not.toContain('e5');

    const pluralEntry = entryFromRecording({
      binding: bindingFor(pluralStep),
      actions: [expandAction, pluralAction],
      resolvedParameters: {},
    });
    expect(pluralEntry).toBeDefined();
    expect(pluralEntry).toContain('fromRecording: true');
    expect(pluralEntry).toContain("selector: '#items > li > span.title'");
    expect(pluralEntry).toContain('multiple: true');
    expect(pluralEntry).toContain("as: 'item_titles'");
    expect(pluralEntry).toContain("kinds: ['span.title']");
    expect(pluralEntry).not.toContain('e8');
    expect(pluralEntry).not.toContain('s1');

    const countEntry = entryFromRecording({
      binding: bindingFor(countStep),
      actions: [countAction],
      resolvedParameters: {},
    });
    expect(countEntry).toBeDefined();
    expect(countEntry).toContain('fromRecording: true');
    expect(countEntry).toContain('await step.count({');
    expect(countEntry).toContain("selector: '#items > li > span.title'");
    expect(countEntry).toContain("kinds: ['span.title']");

    // Empty plural read with no derived resolvedSelector cannot compile from recording.
    expect(
      entryFromRecording({
        binding: bindingFor(pluralStep),
        actions: [
          {
            action: 'read',
            multiple: true,
            containerRef: 'e8',
            exampleRefs: [],
            as: 'item_titles',
            description: 'Read empty list',
            targeting: { matchCount: 0 },
          },
        ],
        resolvedParameters: {},
      }),
    ).toBeUndefined();

    // End-to-end through LiveCompiler with a throwing AiClient: strictly 0 LLM calls.
    const completeSpy = vi.fn(async () => {
      throw new Error('LLM must not be invoked for fromRecording steps');
    });
    const throwingClient = { complete: completeSpy } as unknown as AiClient;
    const testFile = path.join(tempDir, 'shipments-reads.md');
    const stepsFile = path.join(tempDir, 'shipments-reads.steps.ts');
    const events: LiveCompileEvent[] = [];

    const compiler = new LiveCompiler({
      mode: 'steps',
      testFilePath: testFile,
      aiClient: throwingClient,
      contextContent: '',
      testName: 'shipments-reads.md',
      plan: [
        { text: singularStep, inScope: true, line: 4 },
        { text: pluralStep, inScope: true, line: 5 },
        { text: countStep, inScope: true, line: 6 },
      ],
      emit: (e) => events.push(e),
      note: () => {},
    });

    compiler.offer({
      index: 0,
      binding: bindingFor(singularStep, { file: stepsFile }),
      result: makeStepResult(
        [
          [
            {
              index: 1,
              action: singularAction,
              ...(singularAction.targeting && { targeting: singularAction.targeting }),
              durationMs: 10,
            },
          ],
        ],
        { index: 1, instruction: singularStep, outputs: { total_amount: '$60' } },
      ),
      resolvedParameters: {},
    });
    compiler.offer({
      index: 1,
      binding: bindingFor(pluralStep, { file: stepsFile }),
      result: makeStepResult(
        [
          [{ index: 1, action: expandAction, durationMs: 5 }],
          [
            {
              index: 2,
              action: pluralAction,
              ...(pluralAction.targeting && { targeting: pluralAction.targeting }),
              durationMs: 10,
            },
          ],
        ],
        { index: 2, instruction: pluralStep, outputs: { item_titles: '["Alpha","Bravo","Charlie"]' } },
      ),
      resolvedParameters: {},
    });
    compiler.offer({
      index: 2,
      binding: bindingFor(countStep, { file: stepsFile }),
      result: makeStepResult(
        [
          [
            {
              index: 1,
              action: countAction,
              ...(countAction.targeting && { targeting: countAction.targeting }),
              durationMs: 10,
            },
          ],
        ],
        { index: 3, instruction: countStep, outputs: { item_count: '3' } },
      ),
      resolvedParameters: {},
    });

    const outcome = await compiler.finish({ tokensUsed: 0 });
    expect(completeSpy).not.toHaveBeenCalled();

    const compiledFile = outcome.files[stepsFile] ?? '';
    expect(compiledFile).toContain('fromRecording: true');
    expect(compiledFile).toContain('#total-amount');
    expect(compiledFile).toContain('#items > li > span.title');
    expect(compiledFile).toContain("kinds: ['span.title']");
    expect(ephemeralRefInCodeComplaint(compiledFile)).toBeUndefined();

    const stepMessages = events
      .filter((e): e is Extract<LiveCompileEvent, { type: 'compile:step' }> => e.type === 'compile:step')
      .map((e) => e.message);
    expect(stepMessages.filter((m) => m === 'written from the recording, with no model call')).toHaveLength(3);
  });

  it('folds Case A ([click, wait change 90000] + [wait change] + [noop foundRef]) into [click, wait] and drops synthetic noop', () => {
    const result = makeStepResult([
      [
        {
          index: 1,
          action: { action: 'click', ref: 'e6', description: 'Click Continue' },
          targeting: {
            normalizedLocator: "getByRole('button', { name: 'Continue' })",
            normalizedBy: 'role',
            resolvedSelector: '#continue-btn',
            resolvedBy: 'attribute',
            matchCount: 1,
          },
          durationMs: 20,
        },
        {
          index: 2,
          action: {
            action: 'wait',
            waitType: 'change',
            timeout: 90_000,
            description: 'Wait up to 90s for verification code',
          },
          durationMs: 400,
        },
      ],
      [
        {
          index: 3,
          action: {
            action: 'wait',
            waitType: 'change',
            description: 'Still sending verification code',
          },
          durationMs: 400,
        },
      ],
      [
        {
          index: 4,
          action: {
            action: 'noop',
            foundRef: 'e12',
            description: 'Verification code field is visible',
          },
          targeting: {
            normalizedLocator: "getByLabel('Verification code')",
            normalizedBy: 'label',
            resolvedSelector: '#otp-code',
            resolvedBy: 'attribute',
            matchCount: 1,
          },
          durationMs: 5,
        },
      ],
    ]);

    const folded = actionsOf(result);
    expect(folded).toHaveLength(2);
    expect(folded[0]!.action).toBe('click');
    expect(folded[1]!.action).toBe('wait');
    expect(folded[1]!.waitType).toBe('change');
    expect(folded[1]!.timeout).toBe(90_000);
    expect(folded[1]!.resolvedWaitTarget).toEqual({
      normalizedLocator: "getByLabel('Verification code')",
      resolvedSelector: '#otp-code',
    });

    // Verify buildStepCodePrompt surfaces resolvedWaitTarget + ephemeral-ref guidance for the folded wait.
    const promptMsg = buildStepCodePrompt({
      rawStepText: 'Click Continue and wait up to 90 seconds for the verification code field',
      parameters: [],
      actions: folded,
      testInfoSection: 'Test: shipments',
    });
    const promptText = contentBlocksToText(promptMsg.content);
    expect(promptText).toContain('resolvedWaitTarget');
    expect(promptText).toContain("getByLabel('Verification code')");
    expect(promptText).toContain('NEVER write `aria-ref=`');
  });

  it('folds Case B ([wait change 60000] + [type ref e12]) by attaching resolvedWaitTarget onto wait while keeping both actions', () => {
    const result = makeStepResult([
      [
        {
          index: 1,
          action: {
            action: 'wait',
            waitType: 'change',
            timeout: 60_000,
            description: 'Wait for verification code field',
          },
          durationMs: 300,
        },
      ],
      [
        {
          index: 2,
          action: {
            action: 'type',
            ref: 'e12',
            value: '{{otp}}',
            description: 'Enter verification code',
          },
          targeting: {
            normalizedLocator: "getByLabel('Verification code')",
            normalizedBy: 'label',
            resolvedSelector: '#otp-code',
            resolvedBy: 'attribute',
            matchCount: 1,
          },
          durationMs: 15,
        },
      ],
    ]);

    const folded = actionsOf(result);
    expect(folded).toHaveLength(2);
    expect(folded[0]!.action).toBe('wait');
    expect(folded[0]!.timeout).toBe(60_000);
    expect(folded[0]!.resolvedWaitTarget).toEqual({
      normalizedLocator: "getByLabel('Verification code')",
      resolvedSelector: '#otp-code',
    });
    expect(folded[1]!.action).toBe('type');
    expect(folded[1]!.ref).toBe('e12');
    expect(folded[1]!.value).toBe('{{otp}}');
  });

  it('folds Case C (missing-foundRef backstop) by diffing stepContext.domBefore -> domAfter for a single new interactive ref', () => {
    const result = makeStepResult(
      [
        [
          {
            index: 1,
            action: {
              action: 'wait',
              waitType: 'change',
              timeout: 45_000,
              description: 'Wait for verification code input',
            },
            durationMs: 250,
          },
        ],
        [
          {
            index: 2,
            action: {
              action: 'noop',
              description: 'Field appeared',
            },
            durationMs: 2,
          },
        ],
      ],
      {
        stepContext: {
          domBefore: [
            '- main:',
            '  - button "Continue" [ref=e6]',
            '  - status: "Sending code..."',
          ].join('\n'),
          domAfter: [
            '- main:',
            '  - button "Continue" [ref=e6]',
            '  - textbox "Verification code" [ref=e12]',
          ].join('\n'),
        },
      },
    );

    const folded = actionsOf(result);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.action).toBe('wait');
    expect(folded[0]!.timeout).toBe(45_000);
    expect(folded[0]!.resolvedWaitTarget).toEqual({
      normalizedLocator: 'getByRole("textbox", { name: "Verification code" })',
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Hard Static Guards Across generate.ts, review.ts, and repair.ts (SPEC §7.3)
// ---------------------------------------------------------------------------

describe('Phase 3 hard static guards (SPEC §7.3)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('ephemeralRefInCodeComplaint rejects ephemeral ref spellings while allowing literal fill values and comments', () => {
    const rejected = [
      `{ source: 'Click Save', async run({ page }) { await page.locator('aria-ref=e15').click(); } }`,
      `{ source: 'Click Save', async run({ page }) { await page.getByRef('e15').click(); } }`,
      `{ source: 'Click Save', async run({ page }) { await page.locator('[data-steptix-ref="s1"]').click(); } }`,
      `{ source: 'Click Save', async run({ page }) { await page.locator('e15').click(); } }`,
      `{ source: 'Click Save', async run({ page }) { await page.locator('f1e4').click(); } }`,
      `{ source: 'Click Save', async run({ page }) { await page.locator('s2').click(); } }`,
      "{ source: 'Click Save', async run({ page }) { await page.locator(`aria-ref=f1e4`).click(); } }",
      "{ source: 'Click Save', async run({ page }) { await page.locator(`s2`).click(); } }",
      `{ source: 'Read', async run({ step }) { await step.read({ selector: 'e15', as: 'code' }); } }`,
    ];
    for (const code of rejected) {
      expect(ephemeralRefInCodeComplaint(code), code).toBeDefined();
    }

    const allowed = [
      `{ source: 'Type code', async run({ page }) { await page.getByLabel('Code').fill('e15'); } }`,
      `{ source: 'Type code', async run({ page }) { await page.getByLabel('Code').fill('s1'); } }`,
      `{ source: 'Type code', async run({ page }) { await page.getByLabel('Code').fill('f1e4'); } }`,
      `{ source: 'Click Save', async run({ page }) {\n  // Previously matched e15 (aria-ref=e15) or page.getByRef('e15') / data-steptix-ref\n  /* Also ignore s1 and f1e4 in block comments */\n  await page.getByRole('button', { name: 'Save' }).click();\n} }`,
      `{ source: 'Click id', async run({ page }) { await page.locator('#e15').click(); } }`,
      `{ source: 'Click class', async run({ page }) { await page.locator('.s1').click(); } }`,
      `{ source: 'Click custom', async run({ page }) { await page.locator('z2l9e43l3').click(); } }`,
    ];
    for (const code of allowed) {
      expect(ephemeralRefInCodeComplaint(code), code).toBeUndefined();
    }
  });

  it('generateStepEntry re-asks once on ephemeral ref, accepts a clean re-ask, and withholds if the 2nd reply still uses one', async () => {
    const stepText = 'Click Continue';
    const actions: RecordedAction[] = [
      {
        action: 'click',
        ref: 'e15',
        description: 'Click Continue',
        targeting: {
          normalizedLocator: "getByRole('button', { name: 'Continue' })",
          normalizedBy: 'role',
          resolvedSelector: '#continue-btn',
          resolvedBy: 'attribute',
          matchCount: 1,
        },
      },
    ];
    const badFirst = `{ source: ${JSON.stringify(stepText)}, async run({ page, step }) { await page.locator('aria-ref=e15').click(); await step.settle(); } }`;
    const badSecond = `{ source: ${JSON.stringify(stepText)}, async run({ page, step }) { await page.locator('[data-steptix-ref="s1"]').click(); await step.settle(); } }`;
    const clean = `{ source: ${JSON.stringify(stepText)}, async run({ page, step }) { await page.getByRole('button', { name: 'Continue' }).click(); await step.settle(); } }`;

    // Re-asks once and accepts clean second reply.
    const recoveredAi = scriptedAi(badFirst, clean);
    const recovered = await generateStepEntry({
      binding: bindingFor(stepText),
      actions,
      resolvedParameters: {},
      aiClient: recoveredAi.client,
      contextContent: '',
      testName: 'shipments',
    });
    expect(recovered).toEqual({ kind: 'entry', code: clean });
    expect(recoveredAi.prompts).toHaveLength(2);
    expect(recoveredAi.prompts[1]).toContain('ephemeral snapshot reference');

    // Re-asks once and withholds when the 2nd reply still contains an ephemeral ref.
    const withheldAi = scriptedAi(badFirst, badSecond);
    const withheld = await generateStepEntry({
      binding: bindingFor(stepText),
      actions,
      resolvedParameters: {},
      aiClient: withheldAi.client,
      contextContent: '',
      testName: 'shipments',
    });
    expect(withheldAi.prompts).toHaveLength(2);
    expect(withheld).toEqual({
      kind: 'error',
      message: EPHEMERAL_REF_WITHHELD,
      withheld: true,
    });
  });

  it('askCheckedRepair (repair.ts path) re-asks on ephemeral ref and withholds when the 2nd reply still uses one', async () => {
    const stepText = 'Click Continue';
    const actions: RecordedAction[] = [
      {
        action: 'click',
        ref: 'e15',
        description: 'Click Continue',
        targeting: {
          normalizedLocator: "getByRole('button', { name: 'Continue' })",
          normalizedBy: 'role',
          resolvedSelector: '#continue-btn',
          resolvedBy: 'attribute',
          matchCount: 1,
        },
      },
    ];
    const brokenOriginal = `{ source: ${JSON.stringify(stepText)}, async run({ page }) { await page.locator('#old-btn').click(); } }`;
    const badRepair1 = `{ source: ${JSON.stringify(stepText)}, async run({ page, step }) { await page.getByRef('e15').click(); await step.settle(); } }`;
    const badRepair2 = `{ source: ${JSON.stringify(stepText)}, async run({ page, step }) { await page.locator('f1e4').click(); await step.settle(); } }`;
    const goodRepair = `{ source: ${JSON.stringify(stepText)}, async run({ page, step }) { await page.getByRole('button', { name: 'Continue' }).click(); await step.settle(); } }`;

    const buildPrompt = (retry?: { previousEntry: string; complaint: string }): ChatMessage =>
      buildRepairPrompt({
        rawStepText: stepText,
        stepIndex: 2,
        entryCode: brokenOriginal,
        error: 'locator("#old-btn") timed out',
        parameters: [],
        actions,
        ...(retry && { retry }),
      });

    // Recovers when re-ask removes ephemeral ref.
    const fixedAi = scriptedAi(badRepair1, goodRepair);
    const fixed = await askCheckedRepair(
      fixedAi.client,
      '',
      buildPrompt,
      [],
      { binding: bindingFor(stepText), actions },
    );
    expect(fixed).toEqual({ kind: 'entry', code: goodRepair });
    expect(fixedAi.prompts).toHaveLength(2);
    expect(fixedAi.prompts[1]).toContain('ephemeral snapshot reference');

    // Withholds when 2nd repair answer still uses an ephemeral ref.
    const stillBadAi = scriptedAi(badRepair1, badRepair2);
    const withheld = await askCheckedRepair(
      stillBadAi.client,
      '',
      buildPrompt,
      [],
      { binding: bindingFor(stepText), actions },
    );
    expect(stillBadAi.prompts).toHaveLength(2);
    expect(withheld).toEqual({
      kind: 'error',
      message: EPHEMERAL_REF_WITHHELD,
      withheld: true,
    });
  });

  it('flags ephemeral-ref in entryFaults, conditionEntryComplaint, and rejects ephemeral refs introduced in reviewCandidate', async () => {
    const badRunEntry = `{ source: 'Click Continue', async run({ page }) { await page.locator('aria-ref=e15').click(); } }`;
    const faults = entryFaults(badRunEntry, { source: 'Click Continue' });
    expect(faults.some((f) => f.check === 'ephemeral-ref')).toBe(true);

    const badConditionEntry = `{ source: 'If the banner is visible', async condition({ page }) { return await page.locator('aria-ref=e15').isVisible(); } }`;
    expect(conditionEntryComplaint(badConditionEntry)).toContain('ephemeral snapshot reference');

    const cleanConditionEntry = `{ source: 'If the banner is visible', async condition({ page }) { return await page.getByRole('status').isVisible(); } }`;
    expect(conditionEntryComplaint(cleanConditionEntry)).toBeUndefined();

    // reviewCandidate rejects a reviewer revision that introduces an ephemeral ref.
    const stepsFile = path.join(tempDir, 'review-guard.steps.ts');
    const cleanFile = [
      "import { defineSteps } from 'steptix/codebehind';",
      'export default defineSteps([',
      '  {',
      "    source: 'Click Continue',",
      '    async run({ page, step }) {',
      "      await page.getByRole('button', { name: 'Continue' }).click();",
      '      await step.settle();',
      '    },',
      '  },',
      ']);',
      '',
    ].join('\n');
    const revisedWithRef = cleanFile.replace(
      "page.getByRole('button', { name: 'Continue' })",
      "page.locator('aria-ref=e15')",
    );

    const candidate = new Candidate();
    await candidate.replaceFile(stepsFile, cleanFile);
    const beforeContent = candidate.contentOf(stepsFile)!;

    const { client } = scriptedAi({ file: revisedWithRef });
    const emitted: string[] = [];
    await reviewCandidate(
      candidate,
      {
        markdownName: 'shipments.md',
        steps: ['Click Continue'],
        guarded: [],
        aiClient: client,
      },
      (msg) => emitted.push(msg),
    );

    expect(emitted.some((m) => m.includes('rejected:') && m.includes('ephemeral snapshot reference'))).toBe(true);
    expect(candidate.contentOf(stepsFile)).toBe(beforeContent);
  });

  it('recordedReadMismatch and buildRepairPrompt hold ref-based reads to targeting.resolvedSelector or targeting.normalizedLocator', () => {
    const readAction: RecordedAction = {
      action: 'read',
      multiple: true,
      containerRef: 'e8',
      exampleRefs: ['s1', 's2'],
      as: 'item_names',
      description: 'Read item names',
      targeting: {
        matchCount: 3,
        resolvedSelector: '#items span.name',
        resolvedBy: 'scoped',
        normalizedLocator: "locator('#items span.name')",
        kinds: ['span.name'],
      },
    };

    const wrongCode = `{ source: 'Read item names [store as: item_names]', async run({ page, step }) { step.setVar('item_names', JSON.stringify(await page.locator('#items').allTextContents())); } }`;
    const mismatch = recordedReadMismatch(wrongCode, [readAction], {
      source: 'Read item names [store as: item_names]',
      recordedCaptures: { item_names: '["Alpha","Bravo","Charlie"]' },
    });
    expect(mismatch).toBeDefined();
    expect(mismatch!.selector).toBe('#items span.name');
    expect(mismatch!.complaint).toContain('#items span.name');
    expect(mismatch!.complaint).toContain("locator('#items span.name')");

    const rightCssCode = `{ source: 'Read item names [store as: item_names]', async run({ page, step }) { step.setVar('item_names', JSON.stringify(await page.locator('#items span.name').allTextContents())); } }`;
    expect(
      recordedReadMismatch(rightCssCode, [readAction], {
        source: 'Read item names [store as: item_names]',
      }),
    ).toBeUndefined();

    // Also accepts semantic targeting.normalizedLocator with normalized quote/spacing style.
    const semanticReadAction: RecordedAction = {
      action: 'read',
      ref: 'e5',
      as: 'heading',
      description: 'Read heading',
      targeting: {
        matchCount: 1,
        resolvedSelector: '#shipment-heading',
        resolvedBy: 'attribute',
        normalizedLocator: "getByRole('heading', { name: 'Shipments' })",
        normalizedBy: 'role',
      },
    };
    const rightSemanticCode = `{ source: 'Read heading [store as: heading]', async run({ page, step }) { step.setVar('heading', (await page.getByRole("heading", {name: "Shipments"}).textContent()) ?? ''); } }`;
    expect(
      recordedReadMismatch(rightSemanticCode, [semanticReadAction], {
        source: 'Read heading [store as: heading]',
      }),
    ).toBeUndefined();

    const repairPrompt = buildRepairPrompt({
      rawStepText: 'Read item names [store as: item_names]',
      stepIndex: 4,
      entryCode: wrongCode,
      error: 'Unexpected list contents',
      parameters: [],
      actions: [readAction],
    });
    const repairText = contentBlocksToText(repairPrompt.content);
    expect(repairText).toContain('## What the run read with');
    expect(repairText).toContain('- read (every match) `#items span.name` → item_names');
  });

  it('waitTimeoutDroppedComplaint rejects dropped or too-small timeouts and accepts 90000 and 90_000', () => {
    const longWaitActions: RecordedAction[] = [
      {
        action: 'wait',
        waitType: 'change',
        timeout: 90_000,
        description: 'Wait up to 90s for verification code',
        resolvedWaitTarget: {
          normalizedLocator: "getByLabel('Code')",
        },
      },
    ];

    const missingTimeout = `{ source: 'Wait for Code', async run({ page }) { await page.getByLabel('Code').waitFor({ state: 'visible' }); } }`;
    const onlySettle = `{ source: 'Wait for Code', async run({ step }) { await step.settle(); } }`;
    const tooSmallTimeout = `{ source: 'Wait for Code', async run({ page }) { await page.getByLabel('Code').waitFor({ state: 'visible', timeout: 30_000 }); } }`;
    const timeoutOnlyInComment = `{ source: 'Wait for Code', async run({ page }) {\n  // Wait up to 90000ms\n  await page.getByLabel('Code').waitFor({ state: 'visible' });\n} }`;
    const okPlainNumber = `{ source: 'Wait for Code', async run({ page }) { await page.getByLabel('Code').waitFor({ state: 'visible', timeout: 90000 }); } }`;
    const okUnderscoreNumber = `{ source: 'Wait for Code', async run({ page }) { await page.getByLabel('Code').waitFor({ state: 'visible', timeout: 90_000 }); } }`;

    expect(waitTimeoutDroppedComplaint(missingTimeout, longWaitActions)).toContain('90000');
    expect(waitTimeoutDroppedComplaint(onlySettle, longWaitActions)).toContain('90000');
    expect(waitTimeoutDroppedComplaint(tooSmallTimeout, longWaitActions)).toContain('90000');
    expect(waitTimeoutDroppedComplaint(timeoutOnlyInComment, longWaitActions)).toContain('90000');

    expect(waitTimeoutDroppedComplaint(okPlainNumber, longWaitActions)).toBeUndefined();
    expect(waitTimeoutDroppedComplaint(okUnderscoreNumber, longWaitActions)).toBeUndefined();

    // Surfaced through entryFaults as 'wait-timeout-dropped'.
    const faults = entryFaults(missingTimeout, {
      source: 'Wait for Code',
      actions: longWaitActions,
    });
    expect(faults.some((f) => f.check === 'wait-timeout-dropped')).toBe(true);

    // Waits at or below the 10000ms default do not trigger the complaint.
    const shortWaitActions: RecordedAction[] = [
      { action: 'wait', waitType: 'change', timeout: 10_000, description: 'Short wait' },
    ];
    expect(waitTimeoutDroppedComplaint(missingTimeout, shortWaitActions)).toBeUndefined();
  });

  it('buildStepCodePrompt redacts secrets in targeting.elementContextHtml, targeting.normalizedLocator, and resolvedWaitTarget (B1.1)', () => {
    const secret = 'phase3-compile-test-secret';
    const actions: RecordedAction[] = [
      {
        action: 'click',
        ref: 'e17',
        description: 'Click Approve',
        targeting: {
          matchCount: 1,
          normalizedLocator: `getByRole('button', { name: '${secret}' })`,
          normalizedBy: 'role',
          resolvedSelector: `[data-token="${secret}"]`,
          resolvedBy: 'attribute',
          elementContextHtml: `<tr><td>${secret}</td><td><button>Approve</button></td></tr>`,
        },
      },
      {
        action: 'wait',
        waitType: 'change',
        timeout: 30_000,
        description: 'Wait for status',
        resolvedWaitTarget: {
          normalizedLocator: `getByRole('status', { name: '${secret}' })`,
          resolvedSelector: `[data-status="${secret}"]`,
        },
      },
    ];

    const promptMsg = buildStepCodePrompt({
      rawStepText: 'Click Approve and wait for confirmation',
      parameters: [],
      secrets: [secret],
      actions,
    });
    const promptText = contentBlocksToText(promptMsg.content);
    expect(promptText).not.toContain(secret);
    expect(promptText).toContain("getByRole('button', { name: '***' })");
    expect(promptText).toContain('<tr><td>***</td><td><button>Approve</button></td></tr>');
    expect(promptText).toContain("getByRole('status', { name: '***' })");
    expect(promptText).toContain('[data-status=\\"***\\"]');
    // Aria transcript legend says "snapshot below" rather than "DOM below" and drops unused `getByText(text)` mention.
    expect(promptText).toContain('snapshot below');
    expect(promptText).not.toContain('getByText(text)');
  });

  it('accountPlaceholders and generateStepEntry vouch for ref-targeted parameterized actions while still declining non-ref asserts (B2)', async () => {
    const stepText = 'Click Approve in the row for {{shipment_id}}';
    const refActions: RecordedAction[] = [
      {
        action: 'click',
        ref: 'e17',
        description: 'Click Approve',
        targeting: {
          normalizedLocator: "getByRole('button', { name: 'Approve' }).nth(0)",
          normalizedBy: 'positional',
          elementContextHtml: '<tr><td>SHP-101</td><td><button>Approve</button></td></tr>',
          matchCount: 1,
        },
      },
    ];

    const refAccounting = accountPlaceholders({
      binding: bindingFor(stepText),
      actions: refActions,
      resolvedParameters: { shipment_id: 'SHP-101' },
      recordingCarriesPlaceholders: true,
    });
    expect(refAccounting).toEqual({ recoveredByValue: [], preChangeFallback: false });

    const parameterizedEntry = `{ source: ${JSON.stringify(stepText)}, async run({ page, step }) { await page.getByRole('row').filter({ hasText: step.getVar('shipment_id')! }).getByRole('button', { name: 'Approve' }).click(); await step.settle(); } }`;
    const { client: okClient, prompts: okPrompts } = scriptedAi(parameterizedEntry);
    const compiled = await generateStepEntry({
      binding: bindingFor(stepText),
      actions: refActions,
      resolvedParameters: { shipment_id: 'SHP-101' },
      recordingCarriesPlaceholders: true,
      aiClient: okClient,
      contextContent: '',
      testName: 'shipments',
    });
    expect(okPrompts).toHaveLength(1);
    expect(compiled).toEqual({ kind: 'entry', code: parameterizedEntry });
    expect(compiled.kind === 'entry' ? compiled.code : '').toContain("step.getVar('shipment_id')");

    // findInlinedParameterValue still blocks hardcoding the shipment ID into generated code.
    const hardcodedEntry = `{ source: ${JSON.stringify(stepText)}, async run({ page, step }) { await page.getByRole('row').filter({ hasText: 'SHP-101' }).getByRole('button', { name: 'Approve' }).click(); await step.settle(); } }`;
    const { client: leakClient } = scriptedAi(hardcodedEntry);
    const refusedLeak = await generateStepEntry({
      binding: bindingFor(stepText),
      actions: refActions,
      resolvedParameters: { shipment_id: 'SHP-101' },
      recordingCarriesPlaceholders: true,
      aiClient: leakClient,
      contextContent: '',
      testName: 'shipments',
    });
    expect(refusedLeak.kind).toBe('error');
    expect(refusedLeak.kind === 'error' ? refusedLeak.message : '').toContain('{{shipment_id}}');

    // Assert-only steps with no ref-targeted action still decline as before.
    const assertStep = 'Verify {{outcome}}';
    const assertActions: RecordedAction[] = [
      {
        action: 'assert',
        condition: 'visible page heading',
        expected: 'Dashboard',
        description: 'Dashboard page is shown',
      },
    ];
    const assertAccounting = accountPlaceholders({
      binding: bindingFor(assertStep),
      actions: assertActions,
      resolvedParameters: { outcome: 'the Dashboard page is shown' },
      recordingCarriesPlaceholders: true,
    });
    expect(assertAccounting.decline).toBe('{{outcome}} appears in no recorded action');

    const { client: unusedClient, prompts: assertPrompts } = scriptedAi(parameterizedEntry);
    const declinedAssert = await generateStepEntry({
      binding: bindingFor(assertStep),
      actions: assertActions,
      resolvedParameters: { outcome: 'the Dashboard page is shown' },
      recordingCarriesPlaceholders: true,
      aiClient: unusedClient,
      contextContent: '',
      testName: 'shipments',
    });
    expect(assertPrompts).toHaveLength(0);
    expect(declinedAssert).toEqual({
      kind: 'declined',
      reason: '{{outcome}} appears in no recorded action',
    });
  });

  it('waitTimeoutDroppedComplaint rejects unrelated large numbers and parses timeout: / waitForTimeout expressions (B8)', () => {
    const longWaitActions: RecordedAction[] = [
      {
        action: 'wait',
        waitType: 'change',
        timeout: 90_000,
        description: 'Wait up to 90s for verification code',
        resolvedWaitTarget: {
          normalizedLocator: "getByLabel('Code')",
        },
      },
    ];

    const unrelatedOtpNumber = `{ source: 'Wait for Code', async run({ step }) { const pin = 123456; await step.settle(); } }`;
    const unrelatedOtpWithShortTimeout = `{ source: 'Wait for Code', async run({ page }) { const pin = 123456; await page.getByLabel('Code').waitFor({ state: 'visible', timeout: 30_000 }); } }`;
    const timeoutInString = `{ source: 'Wait for Code', async run({ step }) { const hint = 'timeout: 90000'; await step.settle(); } }`;
    const okProduct = `{ source: 'Wait for Code', async run({ page }) { await page.getByLabel('Code').waitFor({ state: 'visible', timeout: 90 * 1000 }); } }`;
    const okUnderscoreProduct = `{ source: 'Wait for Code', async run({ page }) { await page.getByLabel('Code').waitFor({ state: 'visible', timeout: 90 * 1_000 }); } }`;
    const okUnderscoreLiteral = `{ source: 'Wait for Code', async run({ page }) { await page.getByLabel('Code').waitFor({ state: 'visible', timeout: 90_000 }); } }`;
    const okWaitForTimeout = `{ source: 'Wait for Code', async run({ page }) { await page.waitForTimeout(90 * 1000); } }`;

    expect(waitTimeoutDroppedComplaint(unrelatedOtpNumber, longWaitActions)).toContain('90000');
    expect(waitTimeoutDroppedComplaint(unrelatedOtpWithShortTimeout, longWaitActions)).toContain('90000');
    expect(waitTimeoutDroppedComplaint(timeoutInString, longWaitActions)).toContain('90000');

    expect(waitTimeoutDroppedComplaint(okProduct, longWaitActions)).toBeUndefined();
    expect(waitTimeoutDroppedComplaint(okUnderscoreProduct, longWaitActions)).toBeUndefined();
    expect(waitTimeoutDroppedComplaint(okUnderscoreLiteral, longWaitActions)).toBeUndefined();
    expect(waitTimeoutDroppedComplaint(okWaitForTimeout, longWaitActions)).toBeUndefined();
  });

  it('covers reviewClosing in aria vs dom mode (B4.3), diffFallbackWaitTarget ref/role guards (B6.2), normalizedLocator-only reads (N1), and yaml fencing in buildRepairPrompt (N6)', () => {
    // B4.3: reviewClosing permits "expand" on "containerRef" in aria mode while keeping dom mode unchanged.
    const ariaReviewCont = contentBlocksToText(
      buildContinuationMessage(
        'Read every item',
        [],
        {},
        'https://app.test',
        '- main:\n  - list [ref=e8]',
        null,
        2,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ['list read warning'],
        true,
        0,
        'aria',
      ).content,
    );
    expect(ariaReviewCont).toContain('an "expand" on "containerRef"');

    const domReviewCont = contentBlocksToText(
      buildContinuationMessage(
        'Read every item',
        [],
        {},
        'https://app.test',
        '<ul><li>Alpha</li></ul>',
        null,
        2,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ['list read warning'],
        true,
        0,
        'dom',
      ).content,
    );
    expect(domReviewCont).toContain(
      'Answer with a read again of one or more of them, the same way, or — if they are right —',
    );
    expect(domReviewCont).not.toContain('an "expand" on "containerRef"');

    // B6.2: diffFallbackWaitTarget ignores iframe refs (f1e4), expanded refs (s2), and non-standard roles.
    for (const afterLine of [
      '  - button "Frame Ready" [ref=f1e4]',
      '  - button "Expanded Item" [ref=s2]',
      '  - paragraph "Notice" [ref=e20]',
    ]) {
      const res = makeStepResult(
        [
          [{ index: 1, action: { action: 'wait', waitType: 'change', timeout: 30_000, description: 'Wait' }, durationMs: 100 }],
          [{ index: 2, action: { action: 'noop', description: 'Done' }, durationMs: 5 }],
        ],
        {
          stepContext: {
            domBefore: '- main:\n  - button "Continue" [ref=e6]',
            domAfter: `- main:\n  - button "Continue" [ref=e6]\n${afterLine}`,
          },
        },
      );
      const folded = actionsOf(res);
      expect(folded[0]!.resolvedWaitTarget, afterLine).toBeUndefined();
    }

    // N1: normalizedLocator-only read (no selector, no resolvedSelector) is recognized across prompts, generate, and repair.
    const normOnlyRead: RecordedAction = {
      action: 'read',
      ref: 'e5',
      as: 'heading',
      description: 'Read heading',
      targeting: {
        matchCount: 1,
        normalizedLocator: "getByRole('heading', { name: 'Shipments' })",
        normalizedBy: 'role',
      },
    };
    const wrongHeadingCode = `{ source: 'Read heading [store as: heading]', async run({ page, step }) { step.setVar('heading', (await page.locator('h1').textContent()) ?? ''); } }`;
    const rightHeadingCode = `{ source: 'Read heading [store as: heading]', async run({ page, step }) { step.setVar('heading', (await page.getByRole('heading', { name: 'Shipments' }).textContent()) ?? ''); } }`;

    const mismatch = recordedReadMismatch(wrongHeadingCode, [normOnlyRead], {
      source: 'Read heading [store as: heading]',
    });
    expect(mismatch).toBeDefined();
    expect(mismatch!.selector).toBe("getByRole('heading', { name: 'Shipments' })");
    expect(mismatch!.complaint).not.toContain('or its verified normalizedLocator');
    expect(
      recordedReadMismatch(rightHeadingCode, [normOnlyRead], {
        source: 'Read heading [store as: heading]',
      }),
    ).toBeUndefined();

    const stepPromptText = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Read heading [store as: heading]',
        parameters: [],
        actions: [normOnlyRead],
      }).content,
    );
    expect(stepPromptText).toContain('await step.read(');

    // N1 + N6: buildRepairPrompt lists normalizedLocator-only read and fences ARIA YAML with ```yaml (and HTML with ```html).
    const ariaRepairText = contentBlocksToText(
      buildRepairPrompt({
        rawStepText: 'Read heading [store as: heading]',
        stepIndex: 2,
        entryCode: wrongHeadingCode,
        error: 'Timed out',
        dom: '- main:\n  - heading "Shipments" [ref=e5]',
        parameters: [],
        actions: [normOnlyRead],
      }).content,
    );
    expect(ariaRepairText).toContain('## What the run read with');
    expect(ariaRepairText).toContain("- read `getByRole('heading', { name: 'Shipments' })` → heading");
    expect(ariaRepairText).toContain('```yaml\n- main:\n  - heading "Shipments" [ref=e5]\n```');

    const htmlRepairText = contentBlocksToText(
      buildRepairPrompt({
        rawStepText: 'Read heading [store as: heading]',
        stepIndex: 2,
        entryCode: wrongHeadingCode,
        error: 'Timed out',
        dom: '<h1>Shipments</h1>',
        parameters: [],
      }).content,
    );
    expect(htmlRepairText).toContain('```html\n<h1>Shipments</h1>\n```');
  });
});
