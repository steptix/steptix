import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Ajv from 'ajv';
import { chromium, type Browser, type Page } from 'playwright';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { loadConfig } from '../src/config/loader.js';
import type { Config } from '../src/config/types.js';
import { parseAIResponse } from '../src/ai/action-parser.js';
import type { AiClient } from '../src/ai/client.js';
import {
  buildBranchedStepMessage,
  buildConditionJudgeMessage,
  buildContinuationMessage,
  buildStepMessage,
  buildSystemPrompt,
  contentBlocksToText,
} from '../src/ai/prompts.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import { actionSelector, classifyOutcome, classifySelectorForm } from '../src/stats/classify.js';
import { rulesFingerprint } from '../src/stats/fingerprint.js';
import { renderReport } from '../src/report/generator.js';
import type { StepResult, SubActionResult, TestReport } from '../src/report/types.js';
import { PageCaptureError } from '../src/browser/dom-cleaner.js';
import { executeAction } from '../src/browser/actions.js';
import { captureAriaPageSnapshot } from '../src/browser/aria-snapshot.js';
import { capturePageContent } from '../src/server/page-capture.js';
import { executeStep } from '../src/runner/step-executor.js';
import { listenFetchable } from './listen-fetchable.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../schema/steptix.config.schema.json');

function messageText(msg: ChatMessage): string {
  return contentBlocksToText(msg.content);
}

function allMessagesText(messages: readonly ChatMessage[]): string {
  return messages.map(messageText).join('\n');
}

function makeReport(steps: StepResult[]): TestReport {
  return {
    testName: 'Aria wiring report',
    filePath: 'tests/aria-wiring.md',
    tags: [],
    status: 'passed',
    steps,
    totalSteps: steps.length,
    passedSteps: steps.length,
    failedSteps: 0,
    totalSubActions: steps.reduce(
      (sum, step) => sum + step.turns.reduce((tSum, t) => tSum + t.subActions.length, 0),
      0,
    ),
    durationMs: 250,
    tokensUsed: 100,
    inputTokens: 80,
    outputTokens: 20,
    date: new Date('2026-11-23T10:00:00Z').toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1. Configuration & JSON Schema
// ---------------------------------------------------------------------------

describe('Phase 1 config & JSON schema (browser.snapshotMode)', () => {
  const ENV_KEYS = ['LOCALAPPDATA', 'XDG_CONFIG_HOME', 'STEPTIX_SNAPSHOT_MODE'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let userRootTmp: string;
  let projectRoot: string;

  beforeEach(async () => {
    userRootTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-aria-wiring-user-'));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-aria-wiring-proj-'));
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env['LOCALAPPDATA'] = userRootTmp;
    process.env['XDG_CONFIG_HOME'] = userRootTmp;
    delete process.env['STEPTIX_SNAPSHOT_MODE'];
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(userRootTmp, { recursive: true, force: true, maxRetries: 3 });
    await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  async function writeProjectConfig(configObj: Record<string, unknown>): Promise<string> {
    const configPath = path.join(projectRoot, 'steptix.config.json');
    await fs.writeFile(configPath, JSON.stringify(configObj, null, 2), 'utf8');
    return configPath;
  }

  it('defaults browser.snapshotMode to "dom"', async () => {
    expect(DEFAULT_CONFIG.browser.snapshotMode).toBe('dom');
    const loaded = await loadConfig(undefined, projectRoot);
    expect(loaded.browser.snapshotMode).toBe('dom');
  });

  it('reads browser.snapshotMode "aria" and "dom" from steptix.config.json', async () => {
    await writeProjectConfig({ browser: { snapshotMode: 'aria' } });
    const ariaConfig = await loadConfig(undefined, projectRoot);
    expect(ariaConfig.browser.snapshotMode).toBe('aria');
    expect(ariaConfig.browser.headed).toBe(DEFAULT_CONFIG.browser.headed);

    await writeProjectConfig({ browser: { snapshotMode: 'dom' } });
    const domConfig = await loadConfig(undefined, projectRoot);
    expect(domConfig.browser.snapshotMode).toBe('dom');
  });

  it('rejects invalid browser.snapshotMode values in steptix.config.json', async () => {
    await writeProjectConfig({ browser: { snapshotMode: 'html' } });
    await expect(loadConfig(undefined, projectRoot)).rejects.toThrow(/Invalid browser\.snapshotMode/);

    await writeProjectConfig({ browser: { snapshotMode: true } });
    await expect(loadConfig(undefined, projectRoot)).rejects.toThrow(/Invalid browser\.snapshotMode/);
  });

  it('applies STEPTIX_SNAPSHOT_MODE case-insensitively and rejects invalid values', async () => {
    await writeProjectConfig({ browser: { snapshotMode: 'dom' } });
    process.env['STEPTIX_SNAPSHOT_MODE'] = 'aria';
    expect((await loadConfig(undefined, projectRoot)).browser.snapshotMode).toBe('aria');

    await writeProjectConfig({ browser: { snapshotMode: 'aria' } });
    process.env['STEPTIX_SNAPSHOT_MODE'] = 'DOM';
    expect((await loadConfig(undefined, projectRoot)).browser.snapshotMode).toBe('dom');

    process.env['STEPTIX_SNAPSHOT_MODE'] = '  ArIa  ';
    expect((await loadConfig(undefined, projectRoot)).browser.snapshotMode).toBe('aria');

    process.env['STEPTIX_SNAPSHOT_MODE'] = '   ';
    expect((await loadConfig(undefined, projectRoot)).browser.snapshotMode).toBe('aria');

    process.env['STEPTIX_SNAPSHOT_MODE'] = 'bad';
    await expect(loadConfig(undefined, projectRoot)).rejects.toThrow(/Invalid STEPTIX_SNAPSHOT_MODE/);
  });

  it('validates browser.snapshotMode against schema/steptix.config.schema.json with Ajv', async () => {
    const rawSchema = await fs.readFile(SCHEMA_PATH, 'utf8');
    const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(rawSchema));

    expect(validate({ browser: { snapshotMode: 'aria' } })).toBe(true);
    expect(validate({ browser: { snapshotMode: 'dom' } })).toBe(true);
    expect(validate({ browser: { snapshotMode: 'nope' } })).toBe(false);
    expect(validate({ browser: { snapshotMode: true } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Action Parser (SPEC §5.1)
// ---------------------------------------------------------------------------

describe('Phase 1 action parser (SPEC §5.1)', () => {
  function parseOne(actionObj: Record<string, unknown>): AIAction {
    const parsed = parseAIResponse(
      JSON.stringify({
        actions: [actionObj],
        reasoning: 'unit test',
        needs_reeval: false,
      }),
    );
    expect(parsed.actions).toHaveLength(1);
    return parsed.actions[0]!;
  }

  it('parses canonical ref formats and strips optional aria-ref= prefix', () => {
    expect(parseOne({ action: 'click', ref: 'e15', description: 'Click e15' }).ref).toBe('e15');
    expect(parseOne({ action: 'click', ref: 'f1e4', description: 'Click f1e4' }).ref).toBe('f1e4');
    expect(parseOne({ action: 'upload', ref: 's1', filePath: 'doc.pdf', description: 'Upload' }).ref).toBe('s1');
    expect(parseOne({ action: 'click', ref: 'aria-ref=e15', description: 'Click prefixed' }).ref).toBe('e15');
    expect(parseOne({ action: 'click', ref: 'aria-ref=f2e9', description: 'Click frame prefixed' }).ref).toBe('f2e9');
    expect(parseOne({ action: 'click', ref: '#not-a-ref', description: 'Invalid ref' }).ref).toBeUndefined();
  });

  it('normalizes bare and prefixed refs in selector while keeping CSS selectors intact', () => {
    const bare = parseOne({ action: 'click', selector: 'e15', description: 'Bare ref in selector' });
    expect(bare.ref).toBe('e15');
    expect(bare.selector).toBeUndefined();

    const prefixed = parseOne({ action: 'click', selector: 'aria-ref=f2e3', description: 'Prefixed ref in selector' });
    expect(prefixed.ref).toBe('f2e3');
    expect(prefixed.selector).toBeUndefined();

    const supp = parseOne({ action: 'upload', selector: 's4', filePath: 'a.txt', description: 'Supp ref in selector' });
    expect(supp.ref).toBe('s4');
    expect(supp.selector).toBeUndefined();

    for (const css of ['#e15', '.s1', 'z2l9e43l3', '[id=e15]', 'div > span']) {
      const action = parseOne({ action: 'click', selector: css, description: `CSS ${css}` });
      expect(action.selector, css).toBe(css);
      expect(action.ref, css).toBeUndefined();
    }
  });

  it('parses drag source/target refs and normalizes ref-like target/to while keeping CSS targets', () => {
    const direct = parseOne({
      action: 'drag',
      ref: 'e1',
      targetRef: 'e2',
      description: 'Drag direct',
    });
    expect(direct.ref).toBe('e1');
    expect(direct.targetRef).toBe('e2');
    expect(direct.target).toBeUndefined();

    const dropAlias = parseOne({
      action: 'drag',
      sourceRef: 'e3',
      dropTargetRef: 'f1e4',
      description: 'Drag sourceRef/dropTargetRef',
    });
    expect(dropAlias.ref).toBe('e3');
    expect(dropAlias.targetRef).toBe('f1e4');

    const fromToAlias = parseOne({
      action: 'drag',
      fromRef: 'aria-ref=e5',
      toRef: 'aria-ref=s2',
      description: 'Drag fromRef/toRef',
    });
    expect(fromToAlias.ref).toBe('e5');
    expect(fromToAlias.targetRef).toBe('s2');

    const targetNormalized = parseOne({
      action: 'drag',
      ref: 'e10',
      target: 'e20',
      description: 'Drag target ref',
    });
    expect(targetNormalized.targetRef).toBe('e20');
    expect(targetNormalized.target).toBeUndefined();

    const toNormalized = parseOne({
      action: 'drag',
      ref: 'e10',
      to: 'f1e8',
      description: 'Drag to ref',
    });
    expect(toNormalized.targetRef).toBe('f1e8');
    expect(toNormalized.target).toBeUndefined();

    const cssTarget = parseOne({
      action: 'drag',
      ref: 'e10',
      target: '#lane-done',
      description: 'Drag to CSS lane',
    });
    expect(cssTarget.target).toBe('#lane-done');
    expect(cssTarget.targetRef).toBeUndefined();
  });

  it('parses containerRef, exampleRefs (including empty []), foundRef, and waitType "change"', () => {
    const listRead = parseOne({
      action: 'read',
      multiple: true,
      containerRef: 'e8',
      exampleRefs: ['e12', 'aria-ref=e15'],
      as: 'items',
      description: 'Read list items',
    });
    expect(listRead.containerRef).toBe('e8');
    expect(listRead.exampleRefs).toEqual(['e12', 'e15']);

    const emptyList = parseOne({
      action: 'count',
      containerRef: 'e8',
      exampleRefs: [],
      as: 'item_count',
      description: 'Count empty list',
    });
    expect(emptyList.containerRef).toBe('e8');
    expect(emptyList.exampleRefs).toEqual([]);

    const invalidExamples = parseOne({
      action: 'read',
      multiple: true,
      containerRef: 'e8',
      exampleRefs: ['#bad'],
      as: 'items',
      description: 'Invalid example refs',
    });
    expect(invalidExamples.exampleRefs).toBeUndefined();

    const done = parseOne({
      action: 'noop',
      foundRef: 'e9',
      description: 'Element appeared',
    });
    expect(done.foundRef).toBe('e9');

    const waitChange = parseOne({
      action: 'wait',
      waitType: 'change',
      timeout: 90_000,
      description: 'Wait for page change',
    });
    expect(waitChange.waitType).toBe('change');
    expect(waitChange.timeout).toBe(90_000);
  });

  it('accepts readTable with ref and rejects readTable missing both selector and ref', () => {
    const ok = parseOne({
      action: 'readTable',
      ref: 'e14',
      columns: [{ header: 'ID', key: 'id' }],
      as: 'rows',
      description: 'Read orders table',
    });
    expect(ok.ref).toBe('e14');
    expect(ok.selector).toBeUndefined();
    expect(ok.as).toBe('rows');
    expect(ok.columns).toEqual([{ header: 'ID', key: 'id' }]);

    expect(() =>
      parseOne({
        action: 'readTable',
        columns: [{ header: 'ID', key: 'id' }],
        as: 'rows',
        description: 'Missing target',
      }),
    ).toThrow(/missing required "selector" field \(or "ref"/);
  });
});

// ---------------------------------------------------------------------------
// 3. Scoreboard Classification & Fingerprinting
// ---------------------------------------------------------------------------

describe('Phase 1 scoreboard classification & fingerprinting', () => {
  it('classifies ref-targeted actions under the "ref" selector form', () => {
    const refActions: AIAction[] = [
      { action: 'click', ref: 'e15', description: 'Click' },
      { action: 'upload', ref: 's1', description: 'Upload' },
      { action: 'type', ref: 'f2e4', value: 'x', description: 'Type' },
      { action: 'read', multiple: true, containerRef: 'e8', as: 'items', description: 'Read list' },
      { action: 'wait', waitType: 'attribute', ref: 'e11', expected: 'aria-valuenow>=75', description: 'Wait' },
      { action: 'wait', waitType: 'hidden', ref: 'e3', description: 'Wait hidden' },
      { action: 'wait', waitType: 'hidden', condition: 'e3', description: 'Wait hidden cond' },
    ];

    for (const action of refActions) {
      const sel = actionSelector(action);
      expect(sel, action.description).toMatch(/^aria-ref=/);
      expect(classifySelectorForm(sel), action.description).toBe('ref');
    }
  });

  it('preserves explicit selector classification and returns undefined/null for waitType "change"', () => {
    const cssClick: AIAction = { action: 'click', selector: '#btn', description: 'Click by id' };
    expect(actionSelector(cssClick)).toBe('#btn');
    expect(classifySelectorForm(actionSelector(cssClick))).toBe('id');

    const waitChange: AIAction = {
      action: 'wait',
      waitType: 'change',
      timeout: 30_000,
      description: 'Wait for change',
    };
    expect(actionSelector(waitChange)).toBeUndefined();
    expect(classifySelectorForm(actionSelector(waitChange))).toBeNull();
  });

  it('classifies a timed-out Playwright error on a ref action without "resolved to" as "no-match"', () => {
    const sub: SubActionResult = {
      index: 1,
      action: { action: 'click', ref: 'e15', description: 'Click' },
      durationMs: 10_000,
      errorSource: 'playwright',
      error: [
        'locator.click: Timeout 10000ms exceeded.',
        'Call log:',
        "  - waiting for locator('aria-ref=e15')",
      ].join('\n'),
    };
    expect(classifyOutcome(sub)).toBe('no-match');

    const blockedSub: SubActionResult = {
      index: 2,
      action: { action: 'click', ref: 'e15', description: 'Click' },
      durationMs: 10_000,
      errorSource: 'playwright',
      error: [
        'locator.click: Timeout 10000ms exceeded.',
        'Call log:',
        "  - waiting for locator('aria-ref=e15')",
        '  - locator resolved to <button>Save</button>',
        '  - <div class="overlay"></div> intercepts pointer events',
      ].join('\n'),
    };
    expect(classifyOutcome(blockedSub)).toBe('blocked');
  });

  it('computes a distinct rulesFingerprint for snapshotMode "aria" vs "dom"', () => {
    const domDefault = rulesFingerprint();
    const domExplicit = rulesFingerprint({ snapshotMode: 'dom' });
    const domNoDismiss = rulesFingerprint({ dismissalGuidance: false });
    const aria = rulesFingerprint({ snapshotMode: 'aria' });

    expect(aria).toMatch(/^p-[0-9a-f]{6}$/);
    expect(domDefault).toMatch(/^p-[0-9a-f]{6}$/);
    expect(aria).not.toBe(domDefault);
    expect(domExplicit).toBe(domDefault);
    expect(domNoDismiss).toBe(domDefault);
  });
});

// ---------------------------------------------------------------------------
// 4. Prompts & HTML Report
// ---------------------------------------------------------------------------

describe('Phase 1 prompts & HTML report labels', () => {
  it('builds aria system prompt with ref targeting rules and keeps default identical to "dom"', () => {
    const ariaBlocks = buildSystemPrompt('', undefined, { snapshotMode: 'aria' });
    const ariaText = contentBlocksToText(ariaBlocks);
    expect(ariaText).toContain('ELEMENT TARGETING BY `ref`');
    expect(ariaText).toContain('"targetRef"');
    expect(ariaText).toContain('# File Inputs');
    expect(ariaText).toContain('# Iframes');
    expect(ariaText).toContain('f1e4');
    expect(ariaText).toContain('"containerRef"');
    expect(ariaText).toContain('"exampleRefs"');
    expect(ariaText).toContain('Shipments');
    expect(ariaText).toContain('set "ref" (if already in the snapshot) or set "condition" to a CSS selector');
    expect(ariaText).not.toContain('#orders');
    expect(ariaText).not.toContain('ORD-1234');
    expect(ariaText).not.toMatch(/"action":\s*"expand"[^}]*"needs_reeval"/);

    const defaultBlocks = buildSystemPrompt('');
    const domBlocks = buildSystemPrompt('', undefined, { snapshotMode: 'dom' });
    expect(defaultBlocks).toEqual(domBlocks);
    expect(contentBlocksToText(defaultBlocks)).toBe(contentBlocksToText(domBlocks));
  });

  it('formats Page Snapshot (yaml) in aria mode and DOM Snapshot (html) in dom mode across builders', () => {
    const ariaSnap = '- button "Save" [ref=e1]';
    const domSnap = '<body><button>Save</button></body>';

    const stepAria = messageText(
      buildStepMessage('Click Save', ariaSnap, null, [], undefined, undefined, undefined, undefined, 'aria'),
    );
    const stepDom = messageText(
      buildStepMessage('Click Save', domSnap, null, [], undefined, undefined, undefined, undefined, 'dom'),
    );
    expect(stepAria).toContain('## Page Snapshot\n```yaml\n' + ariaSnap);
    expect(stepAria).not.toContain('## DOM Snapshot');
    expect(stepDom).toContain('## DOM Snapshot\n```html\n' + domSnap);
    expect(stepDom).not.toContain('## Page Snapshot');

    const contAria = messageText(
      buildContinuationMessage(
        'Click Save',
        [],
        {},
        'http://127.0.0.1/page',
        ariaSnap,
        null,
        2,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        0,
        'aria',
      ),
    );
    const contDom = messageText(
      buildContinuationMessage(
        'Click Save',
        [],
        {},
        'http://127.0.0.1/page',
        domSnap,
        null,
        2,
      ),
    );
    expect(contAria).toContain('## Page Snapshot\n```yaml\n' + ariaSnap);
    expect(contDom).toContain('## DOM Snapshot\n```html\n' + domSnap);

    const outcomes = [
      { label: 'A', instruction: 'If modal appears, close it', isConditional: true },
      { label: 'B', instruction: 'Continue to checkout', isConditional: false },
    ];
    const branchAria = messageText(
      buildBranchedStepMessage(outcomes, ariaSnap, null, [], undefined, undefined, 'aria'),
    );
    const branchDom = messageText(
      buildBranchedStepMessage(outcomes, domSnap, null, []),
    );
    expect(branchAria).toContain('## Page Snapshot\n```yaml\n' + ariaSnap);
    expect(branchAria).toContain('(Page Snapshot and screenshot)');
    expect(branchDom).toContain('## DOM Snapshot\n```html\n' + domSnap);
    expect(branchDom).toContain('(DOM and screenshot)');

    const judgeAria = messageText(
      buildConditionJudgeMessage(['the dialog is open'], ariaSnap, null, [], undefined, undefined, undefined, 'aria'),
    );
    const judgeDom = messageText(
      buildConditionJudgeMessage(['the dialog is open'], domSnap, null, []),
    );
    expect(judgeAria).toContain('## Page Snapshot\n```yaml\n' + ariaSnap);
    expect(judgeDom).toContain('## DOM Snapshot\n```html\n' + domSnap);
  });

  it('labels aria snapshots as Page Snapshot and HTML snapshots as DOM Snapshot in HTML reports', () => {
    const ariaStep: StepResult = {
      index: 1,
      instruction: 'Click Save',
      status: 'passed',
      domSnapshot: '- button "Save" [ref=e1]',
      durationMs: 100,
      retried: false,
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: '2026-11-23T10:00:00Z',
          aiInteractions: [],
          subActions: [
            {
              index: 1,
              action: { action: 'click', ref: 'e1', description: 'Click Save' },
              domSnapshot: '- status "Saved" [ref=e2]',
              durationMs: 50,
            },
          ],
        },
      ],
    };

    const ariaHtml = renderReport(makeReport([ariaStep]));
    expect(ariaHtml).toContain('<summary>Page Snapshot<button');
    expect(ariaHtml).toContain('<summary>Page snapshot after action<button');
    expect(ariaHtml).not.toContain('<summary>DOM Snapshot<button');
    expect(ariaHtml).not.toContain('<summary>DOM after action<button');

    const domStep: StepResult = {
      index: 1,
      instruction: 'Click Save',
      status: 'passed',
      domSnapshot: '<body><button>Save</button></body>',
      durationMs: 100,
      retried: false,
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: '2026-11-23T10:00:00Z',
          aiInteractions: [],
          subActions: [
            {
              index: 1,
              action: { action: 'click', selector: 'button', description: 'Click Save' },
              domSnapshot: '<body><div role="status">Saved</div></body>',
              durationMs: 50,
            },
          ],
        },
      ],
    };

    const domHtml = renderReport(makeReport([domStep]));
    expect(domHtml).toContain('<summary>DOM Snapshot<button');
    expect(domHtml).toContain('<summary>DOM after action<button');
    expect(domHtml).not.toContain('<summary>Page Snapshot<button');
    expect(domHtml).not.toContain('<summary>Page snapshot after action<button');

    const ariaEdgeStep: StepResult = {
      index: 1,
      instruction: 'Capture edge snapshot',
      status: 'passed',
      domSnapshot: '<error>Page snapshot capture failed: target closed</error>',
      durationMs: 50,
      retried: false,
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: '2026-11-23T10:00:00Z',
          aiInteractions: [],
          subActions: [
            {
              index: 1,
              action: { action: 'click', ref: 'e1', description: 'Click Save' },
              domSnapshot: '# Iframes\n- iframe [frame="#checkout"]',
              durationMs: 20,
            },
          ],
        },
      ],
    };
    const ariaEdgeHtml = renderReport(makeReport([ariaEdgeStep]));
    expect(ariaEdgeHtml).toContain('<summary>Page Snapshot<button');
    expect(ariaEdgeHtml).toContain('<summary>Page snapshot after action<button');
    expect(ariaEdgeHtml).not.toContain('<summary>DOM Snapshot<button');
    expect(ariaEdgeHtml).not.toContain('<summary>DOM after action<button');

    const domErrorStep: StepResult = {
      index: 1,
      instruction: 'Capture DOM error',
      status: 'passed',
      domSnapshot: '<error>DOM capture timed out: evaluate timed out after 10000ms</error>',
      durationMs: 50,
      retried: false,
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: '2026-11-23T10:00:00Z',
          aiInteractions: [],
          subActions: [
            {
              index: 1,
              action: { action: 'click', selector: '#save', description: 'Click Save' },
              domSnapshot: '<error>Failed to capture DOM: context destroyed</error>',
              durationMs: 20,
            },
          ],
        },
      ],
    };
    const domErrorHtml = renderReport(makeReport([domErrorStep]));
    expect(domErrorHtml).toContain('<summary>DOM Snapshot<button');
    expect(domErrorHtml).toContain('<summary>DOM after action<button');
    expect(domErrorHtml).not.toContain('<summary>Page Snapshot<button');
    expect(domErrorHtml).not.toContain('<summary>Page snapshot after action<button');
  });
});

// ---------------------------------------------------------------------------
// 5. Server capturePageContent (format: 'aria') & Runner executeStep in aria mode
// ---------------------------------------------------------------------------

describe('Phase 1 server capturePageContent & runner executeStep in snapshotMode: "aria"', () => {
  let browser: Browser;
  let server: http.Server;
  let baseUrl: string;

  const FIXTURE_SECRET = 'wiring-test-secret-val';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const reqUrl = req.url ?? '/';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (reqUrl === '/page-capture') {
        res.end(`<!doctype html>
<html>
  <head><title>Capture Fixture</title></head>
  <body>
    <header><button id="outside-btn">Outside Action</button></header>
    <section id="panel" aria-label="Details Panel">
      <h2>Panel Heading</h2>
      <button id="panel-btn">Panel Action</button>
    </section>
  </body>
</html>`);
        return;
      }

      if (reqUrl === '/iframe-host') {
        res.end(`<!doctype html>
<html>
  <head><title>Iframe Host</title></head>
  <body>
    <main>
      <label for="vault-secret">Vault Password</label>
      <input id="vault-secret" type="password" value="${FIXTURE_SECRET}" />
      <section id="order-card" aria-label="Order Card">
        <span class="order-code">ORD-42</span>
        <span class="order-total">$19.99</span>
      </section>
      <iframe id="child-frame" title="Child Frame" src="/iframe-child" width="420" height="180"></iframe>
    </main>
  </body>
</html>`);
        return;
      }

      if (reqUrl === '/iframe-child') {
        res.end(`<!doctype html>
<html>
  <head><title>Iframe Child</title></head>
  <body>
    <button id="frame-confirm-btn" type="button" onclick="document.getElementById('frame-status').textContent = 'Frame Clicked'">Confirm Frame Action</button>
    <div id="frame-status" role="status">Idle</div>
  </body>
</html>`);
        return;
      }

      if (reqUrl === '/assert-page') {
        res.end(`<!doctype html>
<html>
  <head><title>Assert Fixture</title></head>
  <body>
    <div id="status-banner" role="status">Confirmed</div>
  </body>
</html>`);
        return;
      }

      if (reqUrl === '/scoped-aria-secret') {
        res.end(`<!doctype html>
<html>
  <head><title>Scoped Secret Fixture</title></head>
  <body>
    <header><button id="hdr-btn">Header Action</button></header>
    <section id="login-panel" aria-label="Sign in panel">
      <label for="scoped-pw">Account password</label>
      <input id="scoped-pw" type="password" value="wiring-scoped-aria-secret" />
      <button id="scoped-submit" type="button">Sign in</button>
    </section>
  </body>
</html>`);
        return;
      }

      if (reqUrl === '/expand-then-act') {
        res.end(`<!doctype html>
<html>
  <head><title>Expand Then Act Fixture</title></head>
  <body>
    <main>
      <label for="hidden-file">Attach receipt</label>
      <input id="hidden-file" type="file" style="display: none" />
      <article id="shipment-card" aria-label="Shipment Card">
        <h2>Shipment Card</h2>
        <p>Code: <span class="shipment-code">SHP-808</span></p>
      </article>
    </main>
  </body>
</html>`);
        return;
      }

      if (reqUrl === '/iframe-csrf-find') {
        res.end(`<!doctype html>
<html>
  <head><title>Iframe CSRF &amp; Find Fixture</title></head>
  <body>
    <main>
      <label for="shared-token">Main token</label>
      <input id="shared-token" type="text" value="WRONG-MAIN-TOKEN" />
      <div id="shared-box"><p>Main Box</p></div>
      <iframe id="pay-frame" title="Pay Frame" src="/iframe-csrf-child" width="500" height="220"></iframe>
    </main>
  </body>
</html>`);
        return;
      }

      if (reqUrl === '/iframe-csrf-child') {
        res.end(`<!doctype html>
<html>
  <head><title>Iframe CSRF Child</title></head>
  <body>
    <label for="shared-token">Frame token</label>
    <input id="shared-token" type="text" value="IFRAME-CSRF-777" />
    <article id="shared-box" aria-label="Frame Box">
      <p>Frame Detail: <span class="detail">IFRAME-DETAIL</span></p>
    </article>
  </body>
</html>`);
        return;
      }

      res.end('<!doctype html><html><body>Empty</body></html>');
    });

    const port = await listenFetchable(server, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* noop */ }
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  function ariaConfig(): Config {
    return {
      ...DEFAULT_CONFIG,
      ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
      browser: {
        ...DEFAULT_CONFIG.browser,
        headed: false,
        snapshotMode: 'aria',
        captureScreenshotsPerAction: false,
      },
      execution: {
        ...DEFAULT_CONFIG.execution,
        retries: 0,
        maxTurns: 4,
        promptOnAmbiguity: false,
      },
      reports: {
        ...DEFAULT_CONFIG.reports,
        includeDomSnapshots: true,
        includeScreenshots: false,
      },
    };
  }

  it('capturePageContent(format: "aria") captures full page, scoped subtree, and reports selector errors', async () => {
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/page-capture`, { waitUntil: 'load' });

      const full = await capturePageContent(page, DEFAULT_CONFIG.browser, {
        format: 'aria',
        maxChars: 20_000,
      });
      expect(full.format).toBe('aria');
      expect(full.truncated).toBe(false);
      expect(full.selector).toBeNull();
      expect(full.content).toMatch(/\[ref=e\d+\]/);
      expect(full.content).toContain('Outside Action');
      expect(full.content).toContain('Panel Action');

      const panel = await capturePageContent(page, DEFAULT_CONFIG.browser, {
        format: 'aria',
        selector: '#panel',
        maxChars: 20_000,
      });
      expect(panel.format).toBe('aria');
      expect(panel.truncated).toBe(false);
      expect(panel.selector).toBe('#panel');
      expect(panel.content).toContain('Panel Heading');
      expect(panel.content).toContain('Panel Action');
      expect(panel.content).not.toContain('Outside Action');

      const truncated = await capturePageContent(page, DEFAULT_CONFIG.browser, {
        format: 'aria',
        maxChars: 20,
      });
      expect(truncated.format).toBe('aria');
      expect(truncated.truncated).toBe(true);
      expect(truncated.returnedChars).toBeLessThanOrEqual(20);
      expect(truncated.availableChars).toBeGreaterThan(20);

      await expect(
        capturePageContent(page, DEFAULT_CONFIG.browser, {
          format: 'aria',
          selector: '#missing',
          maxChars: 20_000,
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof PageCaptureError && err.kind === 'selector-miss');

      await expect(
        capturePageContent(page, DEFAULT_CONFIG.browser, {
          format: 'aria',
          selector: '[[[',
          maxChars: 20_000,
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof PageCaptureError && err.kind === 'bad-selector');
    } finally {
      await page.close();
    }
  });

  it('executeStep in aria mode redacts password fields, handles expand -> sN refs, clicks iframe f1eN ref, and stores aria domAfter', async () => {
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/iframe-host`, { waitUntil: 'load' });
      await page.frameLocator('#child-frame').locator('#frame-confirm-btn').waitFor({ state: 'visible' });

      const requests: ChatMessage[][] = [];
      let turnIndex = 0;

      const aiClient = {
        complete: async (messages: ChatMessage[]) => {
          requests.push(messages);
          const turn = ++turnIndex;
          const userText = messageText(messages[messages.length - 1]!);

          if (turn === 1) {
            expect(messageText(messages[0]!)).toContain('ELEMENT TARGETING BY `ref`');
            expect(userText).toContain('## Page Snapshot\n```yaml');
            expect(userText).toContain('Vault Password');
            expect(userText).toContain('***');
            expect(allMessagesText(messages)).not.toContain(FIXTURE_SECRET);

            const cardMatch = /region "Order Card" \[ref=(e\d+)\]/.exec(userText);
            expect(cardMatch, `Order Card ref not found in Turn 1 snapshot:\n${userText}`).not.toBeNull();
            const cardRef = cardMatch![1]!;

            return {
              text: JSON.stringify({
                actions: [{ action: 'expand', ref: cardRef, description: 'Expand card' }],
                reasoning: 'Zoom in',
                needs_reeval: true,
              }),
              model: 'stub-aria',
            };
          }

          if (turn === 2) {
            expect(userText).toContain('### expand');
            expect(userText).toMatch(/data-steptix-ref="s\d+"/);
            expect(userText).toContain('## Page Snapshot\n```yaml');
            expect(allMessagesText(messages)).not.toContain(FIXTURE_SECRET);

            const frameBtnMatch = /button "Confirm Frame Action" \[ref=(f\d+e\d+)\]/.exec(userText);
            expect(frameBtnMatch, `Iframe button ref not found in Turn 2 snapshot:\n${userText}`).not.toBeNull();
            const frameBtnRef = frameBtnMatch![1]!;

            return {
              text: JSON.stringify({
                actions: [
                  {
                    action: 'click',
                    ref: frameBtnRef,
                    description: 'Click Confirm Frame Action inside child frame',
                  },
                ],
                reasoning: 'Click confirm inside child frame',
                needs_reeval: false,
              }),
              model: 'stub-aria',
            };
          }

          throw new Error(`Unexpected AI turn ${turn}`);
        },
      } as unknown as AiClient;

      const result = await executeStep(1, 1, 'Inspect the Order Card and confirm in the child frame', {
        page,
        config: ariaConfig(),
        aiClient,
        contextContent: '',
        testName: 'aria-expand-and-iframe',
        baseUrl,
        conversationHistory: [],
        csrfTokens: {},
        resolvedParameters: {},
        captureStepContext: true,
      });

      expect(result.status).toBe('passed');
      expect(requests).toHaveLength(2);
      expect(result.turns).toHaveLength(2);

      const frameClickSub = result.turns[1]!.subActions[0]!;
      expect(frameClickSub.action.frame).toBe('#child-frame');
      expect(frameClickSub.targeting?.resolvedSelector).toBe('#frame-confirm-btn');

      const frameStatus = await page.frameLocator('#child-frame').locator('#frame-status').textContent();
      expect(frameStatus?.trim()).toBe('Frame Clicked');

      expect(result.stepContext?.domBefore).toBeDefined();
      expect(result.stepContext!.domBefore).toMatch(/\[ref=e\d+\]/);
      expect(result.stepContext!.domBefore).not.toContain(FIXTURE_SECRET);

      expect(result.stepContext?.domAfter).toBeDefined();
      expect(result.stepContext!.domAfter!.trimStart().startsWith('<')).toBe(false);
      expect(result.stepContext!.domAfter).toMatch(/\[ref=e\d+\]/);
      expect(result.stepContext!.domAfter).toContain('Frame Clicked');
      expect(result.stepContext!.domAfter).not.toContain(FIXTURE_SECRET);
    } finally {
      await page.close();
    }
  });

  it('evaluateAssertion Stage 2 still receives HTML DOM in snapshotMode: "aria" so document.querySelector passes', async () => {
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/assert-page`, { waitUntil: 'load' });

      const requests: ChatMessage[][] = [];
      let callIndex = 0;

      const aiClient = {
        complete: async (messages: ChatMessage[]) => {
          requests.push(messages);
          const call = ++callIndex;
          const userText = messageText(messages[messages.length - 1]!);

          if (call === 1) {
            expect(userText).toContain('## Page Snapshot\n```yaml');
            return {
              text: JSON.stringify({
                actions: [
                  {
                    action: 'assert',
                    against: 'dom',
                    condition: 'visible status banner text',
                    expected: 'Confirmed',
                    description: 'Status banner says Confirmed',
                  },
                ],
                reasoning: 'Verify status banner',
                needs_reeval: false,
              }),
              model: 'stub-aria',
            };
          }

          if (call === 2) {
            expect(messageText(messages[0]!)).not.toContain('ELEMENT TARGETING BY `ref`');
            expect(userText).toContain('## Current Page DOM');
            expect(userText).toContain('```html');
            expect(userText).toContain('id="status-banner"');
            expect(userText).not.toContain('## Page Snapshot');
            return {
              text: JSON.stringify({
                code: "(() => { const el = document.querySelector('#status-banner'); const actual = el ? el.textContent.trim() : ''; return { pass: actual === 'Confirmed', actual }; })()",
              }),
              model: 'stub-aria',
            };
          }

          throw new Error(`Unexpected AI call ${call}`);
        },
      } as unknown as AiClient;

      const result = await executeStep(1, 1, 'Verify the status banner says "Confirmed"', {
        page,
        config: ariaConfig(),
        aiClient,
        contextContent: '',
        testName: 'aria-assert-stage2',
        baseUrl,
        conversationHistory: [],
        csrfTokens: {},
        resolvedParameters: {},
      });

      expect(result.status).toBe('passed');
      expect(requests).toHaveLength(2);
      expect(result.assertions).toHaveLength(1);
      expect(result.assertions![0]!.pass).toBe(true);
      expect(result.assertions![0]!.actual).toBe('Confirmed');
    } finally {
      await page.close();
    }
  });

  it('capturePageContent(format: "aria", selector: "#login-panel") masks password fields in the scoped subtree', async () => {
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/scoped-aria-secret`, { waitUntil: 'load' });

      const scoped = await capturePageContent(page, DEFAULT_CONFIG.browser, {
        format: 'aria',
        selector: '#login-panel',
        maxChars: 20_000,
      });
      expect(scoped.format).toBe('aria');
      expect(scoped.selector).toBe('#login-panel');
      expect(scoped.content).toContain('Account password');
      expect(scoped.content).toContain('***');
      expect(scoped.content).not.toContain('wiring-scoped-aria-secret');
      expect(scoped.content).not.toContain('Header Action');
    } finally {
      await page.close();
    }
  });

  it('populates targeting.matchCount: 0 on StaleRefError so classifyOutcome returns "no-match"', async () => {
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/assert-page`, { waitUntil: 'load' });
      await captureAriaPageSnapshot(page);

      const action: AIAction = {
        action: 'click',
        ref: 'e999',
        description: 'Click stale ref',
      };
      const result = await executeAction(page, action);
      expect(result.success).toBe(false);
      expect(result.targeting?.matchCount).toBe(0);

      const sub: SubActionResult = {
        index: 1,
        action,
        durationMs: 5,
        errorSource: 'playwright',
        ...(result.error !== undefined && { error: result.error }),
        ...(result.targeting !== undefined && { targeting: result.targeting }),
      };
      expect(classifyOutcome(sub)).toBe('no-match');
    } finally {
      await page.close();
    }
  });

  it('executeStep Turn 1 expand -> Turn 2 reads the sN ref from ### expand even alongside hidden file inputs', async () => {
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/expand-then-act`, { waitUntil: 'load' });

      const resolvedParameters: Record<string, string> = {};
      let turnIndex = 0;

      const aiClient = {
        complete: async (messages: ChatMessage[]) => {
          const turn = ++turnIndex;
          const userText = messageText(messages[messages.length - 1]!);

          if (turn === 1) {
            const cardMatch = /article "Shipment Card" \[ref=(e\d+)\]/.exec(userText);
            expect(cardMatch, `Shipment Card ref not found in Turn 1 snapshot:\n${userText}`).not.toBeNull();
            return {
              text: JSON.stringify({
                actions: [{ action: 'expand', ref: cardMatch![1]!, description: 'Expand Shipment Card' }],
                reasoning: 'Inspect inner span markup',
                needs_reeval: true,
              }),
              model: 'stub-aria',
            };
          }

          if (turn === 2) {
            expect(userText).toContain('## Exploration Results');
            expect(userText).toContain('### expand');
            const spanMatch = /<span[^>]*data-steptix-ref="(s\d+)"[^>]*>\s*SHP-808/.exec(userText);
            expect(spanMatch, `Expanded span sN ref not found in Turn 2 prompt:\n${userText}`).not.toBeNull();
            const spanSRef = spanMatch![1]!;

            const fileMatch = /file-input "Attach receipt" \[ref=(s\d+)\]/.exec(userText);
            expect(fileMatch, `File input sN ref not found in Turn 2 prompt:\n${userText}`).not.toBeNull();
            expect(fileMatch![1]!).not.toBe(spanSRef);

            return {
              text: JSON.stringify({
                actions: [
                  {
                    action: 'read',
                    ref: spanSRef,
                    as: 'shipment_code',
                    description: 'Read shipment code from expanded card',
                  },
                ],
                reasoning: 'Read inner span by expanded sN ref',
                needs_reeval: false,
              }),
              model: 'stub-aria',
            };
          }

          throw new Error(`Unexpected AI turn ${turn}`);
        },
      } as unknown as AiClient;

      const result = await executeStep(1, 1, 'Read the shipment code from the Shipment Card [store as: shipment_code]', {
        page,
        config: ariaConfig(),
        aiClient,
        contextContent: '',
        testName: 'aria-expand-then-read-sref',
        baseUrl,
        conversationHistory: [],
        csrfTokens: {},
        resolvedParameters,
      });

      expect(result.status).toBe('passed');
      expect(result.turns).toHaveLength(2);
      expect(resolvedParameters['shipment_code']).toBe('SHP-808');
    } finally {
      await page.close();
    }
  });

  it('executeStep handles extract_csrf and find targeting an iframe ref without querying the main frame', async () => {
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/iframe-csrf-find`, { waitUntil: 'load' });
      await page.frameLocator('#pay-frame').locator('#shared-box').waitFor({ state: 'visible' });

      const csrfTokens: Record<string, string> = {};
      let turnIndex = 0;

      const aiClient = {
        complete: async (messages: ChatMessage[]) => {
          const turn = ++turnIndex;
          const userText = messageText(messages[messages.length - 1]!);

          if (turn === 1) {
            const tokenMatch = /textbox "Frame token" \[ref=(f\d+e\d+)\]/.exec(userText);
            expect(tokenMatch, `Frame token ref not found in Turn 1 snapshot:\n${userText}`).not.toBeNull();
            return {
              text: JSON.stringify({
                actions: [
                  {
                    action: 'extract_csrf',
                    ref: tokenMatch![1]!,
                    description: 'Extract CSRF token from iframe input',
                  },
                ],
                reasoning: 'Read CSRF token from iframe ref',
                needs_reeval: true,
              }),
              model: 'stub-aria',
            };
          }

          if (turn === 2) {
            expect(csrfTokens['__latest__']).toBe('IFRAME-CSRF-777');
            const boxMatch = /article "Frame Box" \[ref=(f\d+e\d+)\]/.exec(userText);
            expect(boxMatch, `Frame Box ref not found in Turn 2 snapshot:\n${userText}`).not.toBeNull();
            return {
              text: JSON.stringify({
                actions: [
                  {
                    action: 'find',
                    value: 'IFRAME-DETAIL',
                    ref: boxMatch![1]!,
                    description: 'Find detail inside iframe box',
                  },
                ],
                reasoning: 'Search inside iframe container ref',
                needs_reeval: true,
              }),
              model: 'stub-aria',
            };
          }

          if (turn === 3) {
            const exploreIdx = userText.indexOf('## Exploration Results');
            const snapIdx = userText.indexOf('## Page Snapshot');
            expect(exploreIdx).toBeGreaterThanOrEqual(0);
            expect(snapIdx).toBeGreaterThan(exploreIdx);
            const explorationSection = userText.slice(exploreIdx, snapIdx);
            expect(explorationSection).toContain('### find "IFRAME-DETAIL"');
            expect(explorationSection).toContain('### expand');
            expect(explorationSection).toContain('IFRAME-DETAIL');
            expect(explorationSection).not.toContain('Main Box');

            return {
              text: JSON.stringify({
                actions: [{ action: 'noop', description: 'Confirmed iframe detail' }],
                reasoning: 'Done',
                needs_reeval: false,
              }),
              model: 'stub-aria',
            };
          }

          throw new Error(`Unexpected AI turn ${turn}`);
        },
      } as unknown as AiClient;

      const result = await executeStep(1, 1, 'Extract the iframe token and inspect the iframe box', {
        page,
        config: ariaConfig(),
        aiClient,
        contextContent: '',
        testName: 'aria-iframe-csrf-and-find',
        baseUrl,
        conversationHistory: [],
        csrfTokens,
        resolvedParameters: {},
      });

      expect(result.status).toBe('passed');
      expect(result.turns).toHaveLength(3);
      expect(csrfTokens['__latest__']).toBe('IFRAME-CSRF-777');
    } finally {
      await page.close();
    }
  });
});
