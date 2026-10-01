/**
 * An action type the framework does not have FAILS the step, loudly, and the
 * retry tells the model what it may send instead — and what to answer when
 * nothing it may send does what the step asks.
 *
 * Before this, the parser warned and kept `{"action":"check"}`, and the
 * default of `executeAction`'s switch logged "Unknown action type" and returned
 * `success: true`. "Tick the I agree box" passed green with the box never
 * ticked, and the NEXT step failed on the wrong line. (issues/061 finding 2 is
 * the same defect reached another way: a misplaced `[use ai]` reaches the page
 * model, which invents an `ai` action.) Until now the hole was patched one
 * alias at a time.
 *
 * Layers, each against the real code:
 *
 *  - the parser folds case and separators ("Click", "read_table"), and keeps a
 *    type it still cannot resolve, so the transcript shows what the model sent;
 *  - the real step loop (`executeStep`, real Chromium, a scripted model)
 *    refuses the WHOLE turn before any of it runs, puts the ✗ on the unknown
 *    action, and retries with a prompt listing the types that act and
 *    offering rule 24's concession — so `check` then `click` passes with the
 *    box ticked, and `ai` then a concession fails with the page untouched;
 *  - the retry context names the refused action's selector in its failure
 *    line and keeps it out of "Failed selectors";
 *  - `executeAction` refuses an unknown type on a real page before touching
 *    anything, for any caller that is not the step loop;
 *  - every member of VALID_ACTION_TYPES has a route — `executeAction` runs it,
 *    or the step loop intercepts it first — proven per type. A new type that
 *    is not wired fails here instead of at runtime.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { ActionType, AIAction, ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

/** Every action type that reached `executeAction`, in order. */
const reached = vi.hoisted(() => ({ types: [] as string[] }));

// The REAL executeAction, recorded. Which types reached it is how the route
// table below tells "runs in executeAction" from "intercepted by the step loop
// first"; nothing about what it does is changed.
vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (...args: Parameters<typeof actual.executeAction>) => {
      reached.types.push(String(args[1].action));
      return actual.executeAction(...args);
    }),
  };
});

// Only the post-action settle, which is timing and nothing else: it waits up
// to 1.2 s for a page that is not going to change, after every mutating
// action, and nothing here asserts on it. Page diagnosis, page signals and the
// activity tracker stay real.
vi.mock('../src/browser/page-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser/page-state.js')>()),
  waitForPostActionSettle: async () => {},
}));

import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { executeAction } from '../src/browser/actions.js';
import {
  parseAIResponse,
  VALID_ACTION_TYPES,
  RETRY_ACTION_TYPES,
  ACTION_TYPE_ALIASES,
  canonicalActionType,
  foldActionName,
  isKnownActionType,
  unknownActionTypeError,
} from '../src/ai/action-parser.js';
import { buildRetryContext } from '../src/ai/prompts.js';
import { executeStep, concededStepError } from '../src/runner/step-executor.js';
import { logger } from '../src/utils/logger.js';

// ─── The pages ───────────────────────────────────────────────────────────────

const ORIGIN = 'http://unknown-action.test';

/**
 * The reproduction's page — Continue stays disabled until "I agree" is ticked
 * — plus one element for every action type the route table drives through
 * `executeAction`. A real origin rather than `setContent`, so `navigate`,
 * `reload` and `back` have somewhere to go.
 */
const TERMS = `<!doctype html><html><head><title>Terms</title></head><body>
<form id="terms" onsubmit="return false">
  <label for="name">Name</label> <input id="name" name="name">
  <label><input type="checkbox" id="agree"> I agree</label>
  <select id="plan"><option value="basic">Basic</option><option value="pro">Pro</option></select>
  <input type="file" id="file">
  <input type="hidden" name="csrf" value="tok-123">
  <button id="continue" type="button" disabled>Continue</button>
</form>
<p id="label">Terms and conditions</p>
<table id="t"><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Ada</td></tr></tbody></table>
<div id="card" draggable="true">Card</div><div id="bin" style="min-height:40px">Bin</div>
<button id="close-banner" type="button" onclick="this.remove()">Close</button>
<script>
  const agree = document.getElementById('agree');
  agree.addEventListener('change', () => {
    document.getElementById('continue').disabled = !agree.checked;
  });
</script>
</body></html>`;

/**
 * The review's half-changed page: every click on Add puts one more in the
 * cart, so a click that ran on the refused attempt AND on the retry shows up
 * as a count of 2 where the step asked for 1.
 */
const CART = `<!doctype html><html><head><title>Cart</title></head><body>
<button id="add" type="button">Add to cart</button> <span id="cart">0</span>
<label><input type="checkbox" id="gift"> Gift wrap</label>
<script>
  let n = 0;
  document.getElementById('add').addEventListener('click', () => {
    document.getElementById('cart').textContent = String(++n);
  });
</script>
</body></html>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});
beforeEach(() => {
  reached.types = [];
});

async function pageWith(body: string): Promise<Page> {
  const page = await browser.newPage();
  await page.route('**/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body }),
  );
  await page.goto(`${ORIGIN}/start`);
  return page;
}

const termsPage = (): Promise<Page> => pageWith(TERMS);

// ─── The scripted model and the step loop ───────────────────────────────────

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

function plan(...actions: Array<Record<string, unknown>>): string {
  return JSON.stringify({ actions, reasoning: 'scripted', needs_reeval: false });
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

function configWith(retries: number): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
    browser: { ...DEFAULT_CONFIG.browser, headed: false, captureScreenshotsPerAction: false },
    execution: { ...DEFAULT_CONFIG.execution, retries, maxTurns: 3, promptOnAmbiguity: false },
  };
}

/** The real `executeStep`, as the CLI, the Sessions API and errands call it. */
async function runStep(
  page: Page,
  instruction: string,
  responses: string[],
  opts: { retries?: number; index?: number; params?: Record<string, string> } = {},
): Promise<{ result: StepResult; requests: ChatMessage[][] }> {
  const { client, requests } = scriptedClient(responses);
  const result = await executeStep(opts.index ?? 1, 5, instruction, {
    page,
    config: configWith(opts.retries ?? 1),
    aiClient: client,
    contextContent: '',
    testName: 'unknown-action-type',
    conversationHistory: [],
    csrfTokens: {},
    nonInteractive: true,
    ...(opts.params !== undefined && { resolvedParameters: opts.params }),
  });
  return { result, requests };
}

/** Every error a step result carries: the step's own and each sub-action's. */
function errorsOf(result: StepResult): string[] {
  return [
    ...(result.error !== undefined ? [result.error] : []),
    ...result.turns.flatMap((t) => t.subActions.flatMap((s) => (s.error ? [s.error] : []))),
  ];
}

const CHECK = { action: 'check', selector: '#agree', description: 'Tick the I agree box' };
const CLICK = { action: 'click', selector: '#agree', description: 'Tick the I agree box' };

/**
 * Rule 24's concession as gpt-5.6-luna actually wrote it on the retry
 * (measured 2026-09-29): no description, no condition, no expected.
 */
const CONCEDE = {
  action: 'assert',
  holds: false,
  evidence: 'The step asks for an AI-generated first name, and no supported action can generate one.',
};

/** The types a retry lists, read back out of the prompt text. */
function listedTypes(text: string): string[] {
  const m = /The actions that act on the page are: ([^.]+)\. If one of them/.exec(text);
  return m ? m[1]!.split(', ') : [];
}

// ─── The parser ──────────────────────────────────────────────────────────────

describe('the parser keeps an unknown type, so the transcript can show it', () => {
  it('keeps check exactly as the model wrote it, and warns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const parsed = parseAIResponse(
        '{"actions":[{"action":"check","selector":"#agree","description":"Tick the I agree box"}],'
          + '"reasoning":"The checkbox is visible","needs_reeval":false}',
      );
      expect(parsed.actions).toEqual([CHECK]);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('Unknown action type "check" at index 0'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not throw, so one unknown action does not lose the rest of the reply', () => {
    const parsed = parseAIResponse(plan(
      { action: 'type', selector: '#name', value: 'Ada', description: 'Enter Ada' },
      CHECK,
    ));
    expect(parsed.actions.map((a) => a.action)).toEqual(['type', 'check']);
  });

  it('keeps a type named like an Object.prototype member as the string it is', () => {
    // A bare alias lookup walked the prototype: "toString" came back as a
    // FUNCTION, which JSON drops — the transcript lost the field that says
    // what the model sent, and the refusal quoted `function toString()`.
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const action = parseAIResponse(JSON.stringify({ action: name, description: 'x' })).actions[0]!;
      expect(action.action, name).toBe(name);
      expect(JSON.parse(JSON.stringify(action)).action, name).toBe(name);
      expect(isKnownActionType(action.action), name).toBe(false);
    }
  });

  it('still normalises the aliases — a convenience that now saves a retry', () => {
    for (const [raw, canonical] of [
      ['goBack', 'back'], ['refresh', 'reload'], ['dragAndDrop', 'drag'],
      ['api', 'api_call'], ['attachFile', 'upload'], ['switchTab', 'switchPage'],
    ] as const) {
      expect(parseAIResponse(JSON.stringify({ action: raw, description: 'x' })).actions[0]!.action, raw)
        .toBe(canonical);
    }
  });

  it('folds case and separators before it looks a name up, for types and aliases alike', () => {
    // Each of these was refused as unknown, costing a retry, until the parser
    // folded names the way the computer surface's parser always has.
    for (const [raw, canonical] of [
      ['Click', 'click'], ['CLICK', 'click'], ['SWITCH_PAGE', 'switchPage'],
      ['read_table', 'readTable'], ['Read Table', 'readTable'], ['open-browser', 'openBrowser'],
      ['API_CALL', 'api_call'], ['apiCall', 'api_call'], ['Extract-Value', 'extract_value'],
      ['Go_Back', 'back'], ['DRAG-AND-DROP', 'drag'], ['Switch Tab', 'switchPage'],
    ] as const) {
      expect(canonicalActionType(raw), raw).toBe(canonical);
    }
    for (const name of ['check', 'ai', 'toString', '__proto__', '', '  ']) {
      expect(canonicalActionType(name), name).toBeUndefined();
    }
  });

  it('parses a folded name into the canonical action, fields and all', () => {
    const parsed = parseAIResponse(plan(
      { action: 'Click', selector: '#agree', description: 'Tick the I agree box' },
      { action: 'read_table', selector: '#t', columns: [{ header: 'Name', key: 'name' }], as: 'rows',
        description: 'Read the names' },
      { action: 'SWITCH_PAGE', page: 'page:2', description: 'Go to the popup' },
    ));
    expect(parsed.actions.map((a) => a.action)).toEqual(['click', 'readTable', 'switchPage']);
    // Validated as the canonical type: the table read's own rules ran on it.
    expect(parsed.actions[1]).toMatchObject({ selector: '#t', as: 'rows' });
    expect(parsed.actions[2]).toMatchObject({ page: 'page:2' });
  });

  it('folding merges no two meanings: every type and every alias still resolves to its own target', () => {
    const owner = new Map<string, ActionType>();
    const entries: Array<[string, ActionType]> = [
      ...[...VALID_ACTION_TYPES].map((type): [string, ActionType] => [type, type]),
      ...Object.entries(ACTION_TYPE_ALIASES),
    ];
    for (const [name, target] of entries) {
      const key = foldActionName(name);
      const prior = owner.get(key);
      expect(prior === undefined || prior === target, `${name} folds to "${key}", already ${prior}`)
        .toBe(true);
      owner.set(key, target);
      expect(canonicalActionType(name), name).toBe(target);
    }
  });

  it('isKnownActionType answers from VALID_ACTION_TYPES and nothing else', () => {
    for (const type of VALID_ACTION_TYPES) expect(isKnownActionType(type), type).toBe(true);
    for (const type of ['check', 'Click', 'ai', '', 'goBack', 42, undefined, null]) {
      expect(isKnownActionType(type), String(type)).toBe(false);
    }
  });

  it('the refusal a person reads is one short sentence, with no list of action names', () => {
    expect(unknownActionTypeError('check')).toBe(
      'Unknown action type "check" — the framework has no such action, so nothing was done on the page',
    );
  });

  it('the retry offers every valid type except the eight that can end a step having done nothing', () => {
    const left = [...VALID_ACTION_TYPES].filter((type) => !RETRY_ACTION_TYPES.includes(type));
    expect([...left].sort()).toEqual(
      ['expand', 'extract_value', 'fail', 'find', 'noop', 'prompt', 'return', 'switchFrame'],
    );
    // In the parser's order, so the list reads the way the vocabulary does.
    expect(RETRY_ACTION_TYPES).toEqual([...VALID_ACTION_TYPES].filter((type) => !left.includes(type)));
  });
});

describe('the parser reads rule 24\'s concession: an assert with "holds": false', () => {
  it('accepts it bare, as the model writes it — no description, condition or expected', () => {
    // It used to throw 'missing required "description"', so the step failed
    // in the parser's words and the model's evidence never reached the report.
    const [action] = parseAIResponse(JSON.stringify({ actions: [CONCEDE] })).actions;
    expect(action).toEqual({
      action: 'assert',
      holds: false,
      evidence: CONCEDE.evidence,
      description: 'Report the step as unachievable',
    });
  });

  it('keeps the model\'s own description and condition when it gives them', () => {
    const [action] = parseAIResponse(JSON.stringify({
      ...CONCEDE, description: 'Cannot generate a name', condition: 'a page action can generate a name',
    })).actions;
    expect(action).toMatchObject({
      holds: false, description: 'Cannot generate a name', condition: 'a page action can generate a name',
    });
  });

  it('does not believe "holds": true — that assert is evaluated, so its usual fields are still required', () => {
    expect(() => parseAIResponse(JSON.stringify({
      action: 'assert', holds: true, evidence: 'It looks right', condition: 'the title', description: 'Title',
    }))).toThrow(/missing required "expected"/);
    const [action] = parseAIResponse(JSON.stringify({
      action: 'assert', holds: true, evidence: 'It looks right', condition: 'the title', expected: 'Terms',
      description: 'Title',
    })).actions;
    expect(action!.holds).toBeUndefined();
    expect(action!.evidence).toBeUndefined();
  });
});

// ─── The retry context ───────────────────────────────────────────────────────

describe('the retry context after a type refusal', () => {
  const refused = {
    selector: '#agree',
    typeRefused: true as const,
    error: unknownActionTypeError('check'),
    actionType: 'check',
  };

  it('names the refused action\'s selector in its failure line, and leaves it out of "Failed selectors"', () => {
    const text = buildRetryContext([refused]);
    expect(text).toContain(
      '- Action "check" with selector `#agree` failed: Unknown action type "check" — the framework has ' +
        'no such action, so nothing was done on the page',
    );
    expect(text).not.toContain('Failed selectors from prior attempt');
  });

  it('still lists a selector that DID fail beside it — that one only', () => {
    const text = buildRetryContext([
      { selector: '#missing', error: 'Timeout 5000ms exceeded', matchCount: 0, actionType: 'click' },
      refused,
    ]);
    expect(text).toContain(
      'Failed selectors from prior attempt: `#missing` — choose a different selector or approach.',
    );
    expect(text).toContain('- Action "check" with selector `#agree` failed: ');
  });

  it('tells the model what it may send, and how to fail honestly when none of it fits', () => {
    const text = buildRetryContext([refused]);
    expect(listedTypes(text)).toEqual([...RETRY_ACTION_TYPES]);
    expect(text).toContain('If one of them does what the step asks, answer with it.');
    expect(text).toContain(
      'If none of them does, do not put a different action in its place: nothing the step did not ask ' +
        'for may be typed, clicked, read or stored.',
    );
    expect(text).toContain('a single "assert" with "holds": false and an "evidence"');
    expect(text).toContain('never answer "noop"');
  });

  it('adds that only for an UNKNOWN type — a known one refused as a framework bug gets none', () => {
    const text = buildRetryContext([
      { selector: '', typeRefused: true, error: '"api_call" is run by the step loop', actionType: 'api_call' },
    ]);
    expect(text).not.toContain('The actions that act on the page are');
  });

  it('leaves an ordinary failure as it was', () => {
    const text = buildRetryContext([{ selector: '#go', error: 'Element is not visible', actionType: 'click' }]);
    expect(text).toContain('- Action "click" with selector `#go` failed: Element is not visible');
    expect(text).toContain('Failed selectors from prior attempt: `#go`');
    expect(text).not.toContain('The actions that act on the page are');
  });
});

// ─── executeAction ───────────────────────────────────────────────────────────

describe('executeAction refuses an unknown type', () => {
  it('check fails on a real page with the short refusal, and leaves the box unticked', async () => {
    const page = await termsPage();
    const result = await executeAction(page, { ...CHECK, action: 'check' as ActionType });

    expect(result.success).toBe(false);
    expect(result.error).toBe(unknownActionTypeError('check'));
    expect(result.typeRefused).toBe(true);
    // Retryable: a caller that retries can tell the model what to send.
    expect(result.retryable).toBeUndefined();
    // The selector was never tried, so nothing claims it failed.
    expect(result.failedSelector).toBeUndefined();
    expect(result.matchCount).toBeUndefined();
    expect(await page.isChecked('#agree')).toBe(false);
    expect(await page.isEnabled('#continue')).toBe(false);

    // The composition: the refusal is about the NAME. The same target through
    // a real action still works, on the same page, straight after.
    const click = await executeAction(page, CLICK as AIAction);
    expect(click.success).toBe(true);
    expect(await page.isChecked('#agree')).toBe(true);
    expect(await page.isEnabled('#continue')).toBe(true);
    await page.close();
  }, 30_000);

  it('refuses before anything touches the page', async () => {
    // Every property of this "page" throws. A selector with a space and a
    // frame would each send the old path to the browser (iframe promotion's
    // count, the frame check) before it ever reached the switch.
    const untouchable = new Proxy({}, {
      get: (_target, prop) => {
        throw new Error(`the refusal touched page.${String(prop)}`);
      },
    }) as Page;
    const result = await executeAction(untouchable, {
      action: 'ai' as ActionType,
      selector: 'form #agree',
      frame: 'iframe#terms',
      description: 'Generate a name',
    });
    expect(result).toMatchObject({ success: false, typeRefused: true });
    expect(result.error).toBe(unknownActionTypeError('ai'));
  });
});

// ─── The step loop ───────────────────────────────────────────────────────────

describe('the real step loop: the ✗ lands on the step, and the retry is told why', () => {
  it('turn 1 check is refused, the retry says what may be sent, turn 2 click passes with the box ticked', async () => {
    const page = await termsPage();
    const { result, requests } = await runStep(page, 'Tick the I agree box', [plan(CHECK), plan(CLICK)]);

    expect(result.status).toBe('passed');
    expect(result.retried).toBe(true);
    expect(await page.isChecked('#agree')).toBe(true);
    expect(await page.isEnabled('#continue')).toBe(true);

    // One model call per attempt, and nothing else.
    expect(requests).toHaveLength(2);
    expect(textOf(requests[0]!)).not.toContain('## Retry Attempt');
    const retry = textOf(requests[1]!);
    expect(retry).toContain('## Retry Attempt 2');
    // The target was right; only the action's name was wrong — so the line
    // names the selector, and nothing tells the model to choose another.
    expect(retry).toContain(`Action "check" with selector \`#agree\` failed: ${unknownActionTypeError('check')}`);
    expect(retry).not.toContain('Failed selectors from prior attempt');
    expect(listedTypes(retry)).toEqual([...RETRY_ACTION_TYPES]);

    // The transcript shows what the model actually returned, and where it failed.
    expect(result.turns.map((t) => t.attemptNumber)).toEqual([1, 2]);
    const [first, second] = result.turns;
    expect(first!.aiInteractions[0]!.response).toContain('"action":"check"');
    expect(first!.subActions).toHaveLength(1);
    expect(first!.subActions[0]!.action).toMatchObject({ action: 'check', selector: '#agree' });
    expect(first!.subActions[0]!.error).toBe(unknownActionTypeError('check'));
    expect(second!.subActions[0]!.action.action).toBe('click');
    expect(second!.subActions[0]!.error).toBeUndefined();
    await page.close();
  }, 30_000);

  it('a model that keeps answering check fails the step — this step, after both attempts', async () => {
    const page = await termsPage();
    const { result, requests } = await runStep(page, 'Tick the I agree box', [plan(CHECK)], { index: 3 });

    expect(result.status).toBe('failed');
    expect(result.index).toBe(3);
    // The person reads the short sentence, not the model's list — that is in
    // the retry prompt only.
    expect(result.error).toBe(unknownActionTypeError('check'));
    for (const text of errorsOf(result)) {
      expect(text).not.toContain('click, type');
      expect(text).not.toContain('holds');
    }
    expect(textOf(requests[1]!)).toContain('click, type');
    expect(requests).toHaveLength(2);
    expect(result.turns.map((t) => t.attemptNumber)).toEqual([1, 2]);
    for (const turn of result.turns) {
      expect(turn.subActions.map((s) => s.error)).toEqual([unknownActionTypeError('check')]);
    }
    expect(await page.isChecked('#agree')).toBe(false);
    expect(await page.isEnabled('#continue')).toBe(false);
    await page.close();
  }, 30_000);

  it('with retries off, the first unknown type fails the step at once (the minimum case)', async () => {
    const page = await termsPage();
    const { result, requests } = await runStep(page, 'Tick the I agree box', [plan(CHECK), plan(CLICK)], {
      retries: 0,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe(unknownActionTypeError('check'));
    expect(requests).toHaveLength(1);
    expect(await page.isChecked('#agree')).toBe(false);
    await page.close();
  }, 30_000);

  it('a valid action ahead of the unknown one does NOT run: the whole turn is refused', async () => {
    const page = await pageWith(CART);
    const add = { action: 'click', selector: '#add', description: 'Add the item to the cart' };
    const checkGift = { action: 'check', selector: '#gift', description: 'Tick gift wrap' };
    const clickGift = { action: 'click', selector: '#gift', description: 'Tick gift wrap' };
    const { result, requests } = await runStep(
      page,
      'Add the item to the cart and tick gift wrap',
      [plan(add, checkGift), plan(add, clickGift)],
    );

    expect(result.status).toBe('passed');
    // One item, not two: attempt 1's click never ran, so the retry started
    // from the page the step began on.
    expect(await page.textContent('#cart')).toBe('1');
    expect(await page.isChecked('#gift')).toBe(true);

    // The reply stays in the report, and the ✗ is on the unknown action — the
    // turn's only row, because nothing in it ran.
    const [first] = result.turns;
    expect(first!.aiInteractions[0]!.response).toContain('"action":"check"');
    expect(first!.subActions.map((s) => [s.action.action, s.error])).toEqual([
      ['check', unknownActionTypeError('check')],
    ]);
    expect(reached.types).toEqual(['click', 'click']);
    // So the retry does not claim the click happened.
    const retry = textOf(requests[1]!);
    expect(retry).not.toContain('SUCCEEDED before the failure');
    expect(retry).toContain('Action "check" with selector `#gift` failed: ');
    await page.close();
  }, 30_000);
});

// ─── The honest way out ──────────────────────────────────────────────────────

describe('rule 24\'s concession fails the step, leaves the page alone, and is not retried', () => {
  const AI = { action: 'ai', description: 'Generate a random first name', as: 'first' };
  const TYPE_NAME = { action: 'type', selector: '#name', value: 'Avery', description: 'Enter a first name' };

  it('ai, then the concession on the retry: failed with the model\'s evidence, Name empty, nothing stored', async () => {
    const page = await termsPage();
    const params: Record<string, string> = {};
    // Three attempts allowed, and the third reply types a name: a retry after
    // the concession would pass the step on an invented value.
    const { result, requests } = await runStep(
      page,
      'Generate a random first name [use ai] [store as: first]',
      [plan(AI), plan(CONCEDE), plan(TYPE_NAME)],
      { retries: 2, params },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe(concededStepError(CONCEDE.evidence));
    // Two model calls: the refused `ai` and the concession. No third attempt,
    // and no second model asked to write code for the "assertion".
    expect(requests).toHaveLength(2);
    expect(textOf(requests[1]!)).toContain('a single "assert" with "holds": false');
    expect(await page.inputValue('#name')).toBe('');
    expect(params).toEqual({});
    expect(reached.types).toEqual([]);

    const last = result.turns.at(-1)!;
    expect(last.subActions.map((s) => [s.action.action, s.error])).toEqual([
      ['assert', concededStepError(CONCEDE.evidence)],
    ]);
    expect(result.assertions ?? []).toEqual([]);
    await page.close();
  }, 30_000);

  it('a surface change answered on attempt 1 — rule 24\'s own case — fails there, without a retry', async () => {
    // Before the parser read "holds": false, this reply threw 'missing required
    // "description"', and the step was retried with nothing to go on.
    const page = await termsPage();
    const surface = { ...CONCEDE, evidence: 'The step asks to drive the desktop, which is a [use computer] line.' };
    const { result, requests } = await runStep(page, 'Switch to the desktop and open Calculator', [
      plan(surface),
      plan({ action: 'noop', description: 'done' }),
    ]);
    expect(result.status).toBe('failed');
    expect(result.error).toBe(concededStepError(surface.evidence));
    expect(requests).toHaveLength(1);
    await page.close();
  }, 30_000);

  it('masks a secret the evidence repeats', async () => {
    const page = await termsPage();
    const leaky = { ...CONCEDE, evidence: 'The step would type hunter2-secret into a PIN pad this page does not have.' };
    const { result } = await runStep(page, 'Enter {{password}} on the PIN pad', [plan(leaky)], {
      params: { password: 'hunter2-secret' },
    });
    expect(result.status).toBe('failed');
    expect(errorsOf(result).join('\n')).not.toContain('hunter2-secret');
    expect(result.error).toBe(
      concededStepError('The step would type *** into a PIN pad this page does not have.'),
    );
    await page.close();
  }, 30_000);
});

// ─── Every valid type has a route ────────────────────────────────────────────

type Route = 'executeAction' | 'step loop';

/**
 * Who runs each action type, and the smallest action that exercises it on the
 * page above.
 *
 * Adding a type to VALID_ACTION_TYPES fails the first test below until it has
 * a row here, and the row's route is then checked both ways: `executeAction`
 * runs it or refuses it as step-loop-only, and the real step loop hands it to
 * `executeAction` or keeps it. A type in neither place used to answer
 * `success: true` from `executeAction`'s default.
 */
const ROUTES: Record<ActionType, { route: Route; fields: Record<string, unknown> }> = {
  click: { route: 'executeAction', fields: { selector: '#agree' } },
  type: { route: 'executeAction', fields: { selector: '#name', value: 'Ada' } },
  select: { route: 'executeAction', fields: { selector: '#plan', value: 'pro' } },
  navigate: { route: 'executeAction', fields: { url: `${ORIGIN}/next` } },
  upload: { route: 'executeAction', fields: { selector: '#file', filePath: 'missing.txt' } },
  back: { route: 'executeAction', fields: {} },
  forward: { route: 'executeAction', fields: {} },
  reload: { route: 'executeAction', fields: {} },
  drag: { route: 'executeAction', fields: { selector: '#card', target: '#bin' } },
  hover: { route: 'executeAction', fields: { selector: '#agree' } },
  wait: { route: 'executeAction', fields: { waitType: 'selector', condition: '#agree' } },
  scroll: { route: 'executeAction', fields: { to: 'top' } },
  switchFrame: { route: 'executeAction', fields: {} },
  dismiss: { route: 'executeAction', fields: { selector: '#close-banner' } },
  keyboard: { route: 'executeAction', fields: { key: 'Tab' } },
  keypress: { route: 'executeAction', fields: { key: 'Tab' } },
  read: { route: 'executeAction', fields: { selector: '#label', as: 'label' } },
  readTable: {
    route: 'executeAction',
    fields: { selector: '#t', columns: [{ header: 'Name', key: 'name' }], as: 'rows' },
  },
  count: { route: 'executeAction', fields: { selector: 'input' } },
  noop: { route: 'executeAction', fields: {} },

  prompt: { route: 'step loop', fields: { question: 'Which plan?' } },
  return: { route: 'step loop', fields: {} },
  fail: { route: 'step loop', fields: {} },
  assert: { route: 'step loop', fields: { condition: 'the page title', expected: 'Terms' } },
  openPage: { route: 'step loop', fields: { url: `${ORIGIN}/tab` } },
  switchPage: { route: 'step loop', fields: { page: 'page:2' } },
  closePage: { route: 'step loop', fields: { page: 'page:2' } },
  openBrowser: { route: 'step loop', fields: { as: 'edge' } },
  switchBrowser: { route: 'step loop', fields: { to: 'edge' } },
  closeBrowser: { route: 'step loop', fields: { as: 'edge' } },
  api_call: { route: 'step loop', fields: {} },
  extract_csrf: { route: 'step loop', fields: { selector: 'input[name="csrf"]' } },
  extract_value: { route: 'step loop', fields: { path: 'data.id', as: 'id' } },
  find: { route: 'step loop', fields: { value: 'I agree' } },
  expand: { route: 'step loop', fields: { selector: '#terms' } },
};

const ROWS = Object.entries(ROUTES) as Array<[ActionType, (typeof ROUTES)[ActionType]]>;

function actionFor(type: ActionType): AIAction {
  return { action: type, description: `${type} for the route table`, ...ROUTES[type].fields } as AIAction;
}

/** A dispatch refusal of either kind, anywhere in a step's errors. */
const DISPATCH_REFUSAL = /Unknown action type|is run by the step loop/;

describe('every valid action type has a route, so none falls into the unknown-type refusal', () => {
  it('the table names every member of VALID_ACTION_TYPES, and nothing else', () => {
    expect(Object.keys(ROUTES).sort()).toEqual([...VALID_ACTION_TYPES].sort());
  });

  it.each(ROWS)('executeAction: %s', async (type, { route }) => {
    const page = await termsPage();
    try {
      const result = await executeAction(page, actionFor(type));
      if (route === 'executeAction') {
        // It may still fail for its own reason (`upload` names a file that is
        // not there, `back` may have no history), but never for its TYPE.
        expect(result.typeRefused, result.error).toBeUndefined();
      } else {
        expect(result).toMatchObject({ success: false, typeRefused: true, retryable: false });
        expect(result.error).toContain(`"${type}" is run by the step loop`);
        expect(result.error).not.toContain('Unknown action type');
      }
    } finally {
      await page.close();
    }
  }, 30_000);

  it.each(ROWS)('the step loop: %s', async (type, { route }) => {
    const page = await termsPage();
    try {
      // `assert` asks the model a second time, for its evaluation code; `find`
      // and `expand` force a second turn, answered with `noop`.
      const second = type === 'assert'
        ? JSON.stringify({ code: "({ pass: true, actual: 'Terms' })" })
        : plan({ action: 'noop', description: 'done' });
      const { result } = await runStep(page, `Exercise ${type}`, [plan(actionFor(type)), second], {
        retries: 0,
      });

      if (route === 'executeAction') {
        expect(reached.types).toContain(type);
      } else {
        expect(reached.types).not.toContain(type);
      }
      expect(errorsOf(result).filter((e) => DISPATCH_REFUSAL.test(e))).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
