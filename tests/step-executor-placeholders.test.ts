import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { StepCache } from '../src/cache/step-cache.js';
import type { EnvDataContext } from '../src/parser/interpolate-env-data.js';
import type { StepGroup } from '../src/runner/step-grouper.js';

/**
 * The model names the value it used; the executor puts the value in
 * (stories/placeholder-preserving-actions.md).
 *
 * Built on the `tests/step-context-cache-hit.test.ts` harness — fake page, stub
 * client, the real `executeStep` — with `../src/browser/actions.js` mocked, so
 * every assertion here is about what actually reached `executeAction` versus
 * what the transcript kept. Those two diverging is the whole feature: the page
 * gets `demo@securebank.com`, the recording keeps `{{email}}`.
 */

const actions = vi.hoisted(() => ({ received: [] as AIAction[] }));

/** What the mocked `readTable` captures — see the mock below. Hoisted with it,
 *  because `vi.mock` factories run before the module body. */
const { RECORDS } = vi.hoisted(() => ({
  RECORDS: [
    { _row: '1', id: 'ORD-1001', customer: 'Alice Smith' },
    { _row: '2', id: 'ORD-1002', customer: 'Bob Jones' },
  ] as Array<Record<string, string>>,
}));

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) => {
      actions.received.push(action);
      // `read`/`count` write their capture into the live parameter map, which
      // is what makes the "captured later" and two-step cases exercisable.
      if (action.action === 'read' || action.action === 'count') {
        return { success: true, capturedValue: 'CAPTURED' };
      }
      // A structured capture, the shape `readTable` hands back (§7.1): one
      // flat object per visible data row, `_row` first.
      if (action.action === 'readTable') {
        return { success: true, capturedRecords: RECORDS };
      }
      return { success: true };
    }),
  };
});

const apiCalls = vi.hoisted(() => ({ received: [] as Array<Record<string, unknown>> }));

vi.mock('../src/api/client.js', () => {
  const record = async (opts: Record<string, unknown>) => {
    apiCalls.received.push(opts);
    return { status: 200, headers: {}, body: { ok: true }, durationMs: 1 };
  };
  return { callApiStandalone: vi.fn(record), callApiBrowserContext: vi.fn(record) };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: vi.fn(async () => '<html><body>dom</body></html>') };
});

// Page-state helpers all take a real Playwright page apart; the fake one has
// none of it, and none of what they do is under test here.
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

import { addLogCallback } from '../src/utils/logger.js';
import { executeStep, executeBranchedStep } from '../src/runner/step-executor.js';
import { runInteractiveRepl } from '../src/runner/interactive-repl.js';
import {
  checkTurnReferences,
  collectReferences,
  inlineStoreAsNames,
  substituteAction,
  walkActionStrings,
} from '../src/runner/placeholder-substitution.js';

function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'https://app.test/dashboard',
    context: () => ({ browser: () => ({}) }),
    // A string argument is generated assertion code; anything else is one of
    // the framework's own probes (scroll position), which are allowed to fail.
    evaluate: async (arg: unknown) => {
      if (typeof arg === 'string') return { pass: true, actual: 'ok' };
      throw new Error('no DOM in this test');
    },
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

/** An AI client that replays a scripted list of responses and records every
 *  request it was handed, so a test can assert on what the model was shown. */
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

/** Every scrap of text the model was sent, across every turn. */
function allRequestText(client: { requests: ChatMessage[][] }): string {
  return client.requests
    .flat()
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    )
    .join('\n');
}

interface RunOptions {
  parameters?: Record<string, string>;
  envData?: EnvDataContext;
  authored?: string;
  testSteps?: string[];
  stepCache?: StepCache;
  unmask?: ReadonlySet<string>;
}

async function runStep(instruction: string, responses: string[], opts: RunOptions = {}) {
  const client = scriptedClient(responses);
  const result = await executeStep(
    1,
    1,
    instruction,
    {
      page: fakePage(),
      config: CONFIG,
      aiClient: client,
      contextContent: '',
      testName: 'placeholders',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: opts.parameters ?? {},
      ...(opts.envData && { envData: opts.envData }),
      ...(opts.testSteps && { testSteps: opts.testSteps }),
      ...(opts.stepCache && { stepCache: opts.stepCache, cacheEnabled: true, cacheKey: 1 }),
      ...(opts.unmask && { unmask: opts.unmask }),
    },
    opts.authored,
  );
  return { result, client };
}

const ENV_DATA: EnvDataContext = {
  env: { BASE_URL: 'https://app.test' },
  data: { users: { admin: { email: 'admin@app.test' } } },
  envName: 'uat',
};

beforeEach(() => {
  actions.received = [];
  apiCalls.received = [];
});

// ── The bargain: placeholder in, value out, placeholder kept ────────────────

describe('the model names the value, the executor puts it in', () => {
  it('types the value while the recording keeps the placeholder', async () => {
    const { result } = await runStep(
      'Enter the email demo@securebank.com',
      [plan([{ action: 'type', selector: '#email', value: '{{email}}', description: 'Enter email' }])],
      { parameters: { email: 'demo@securebank.com' }, authored: 'Enter the email {{email}}' },
    );

    expect(result.status).toBe('passed');
    expect(actions.received[0]!.value).toBe('demo@securebank.com');
    // The transcript keeps what the model wrote — the copy is what ran.
    const recorded = result.turns[0]!.subActions[0]!.action;
    expect(recorded.value).toBe('{{email}}');
  });

  it('shows the model the AUTHORED step and a ## Values line, not the value', async () => {
    const { client } = await runStep(
      'Enter the email demo@securebank.com',
      [plan([{ action: 'type', selector: '#email', value: '{{email}}', description: 'Enter email' }])],
      { parameters: { email: 'demo@securebank.com' }, authored: 'Enter the email {{email}}' },
    );
    const text = allRequestText(client);
    expect(text).toContain('Enter the email {{email}}');
    expect(text).toContain('## Values');
    expect(text).toContain('- {{email}} resolved to "demo@securebank.com" on this run');
  });

  it('substitutes url, filePath, selector and key', async () => {
    await runStep(
      'Do the things',
      [
        plan([
          { action: 'navigate', url: '${env.BASE_URL}/{{page}}', description: 'Go' },
          { action: 'upload', selector: '#f', filePath: '{{doc}}', description: 'Upload' },
          { action: 'click', selector: 'text={{plan}}', description: 'Pick plan' },
          { action: 'keypress', key: '{{shortcut}}', description: 'Press' },
        ]),
      ],
      {
        parameters: {
          page: 'plans',
          doc: 'attachments/statement.pdf',
          plan: 'Premium',
          shortcut: 'Enter',
        },
        envData: ENV_DATA,
      },
    );

    expect(actions.received[0]!.url).toBe('https://app.test/plans');
    expect(actions.received[1]!.filePath).toBe('attachments/statement.pdf');
    expect(actions.received[2]!.selector).toBe('text=Premium');
    expect(actions.received[3]!.key).toBe('Enter');
  });

  it('substitutes an api_call\'s nested body and apiHeaders — the deep walk', async () => {
    await runStep(
      'Create the delegate',
      [
        plan([
          {
            action: 'api_call',
            method: 'POST',
            url: '${env.BASE_URL}/api/delegates',
            body: { user: { email: '{{email}}' }, tags: ['{{plan}}'] },
            apiHeaders: { 'x-tenant': '{{plan}}' },
            description: 'Call',
          },
        ]),
      ],
      {
        parameters: { email: 'demo@securebank.com', plan: 'Premium' },
        envData: ENV_DATA,
      },
    );

    expect(apiCalls.received[0]!['url']).toBe('https://app.test/api/delegates');
    expect(apiCalls.received[0]!['body']).toEqual({
      user: { email: 'demo@securebank.com' },
      tags: ['Premium'],
    });
    expect((apiCalls.received[0]!['headers'] as Record<string, string>)['x-tenant']).toBe('Premium');
  });

  it('substitutes filePaths, an array of them', async () => {
    await runStep(
      'Attach both receipts',
      [plan([{ action: 'upload', selector: '#f', filePaths: ['{{one}}', '{{two}}'], description: 'Upload' }])],
      { parameters: { one: 'a/1.png', two: 'a/2.png' } },
    );
    expect(actions.received[0]!.filePaths).toEqual(['a/1.png', 'a/2.png']);
  });

  it('substitutes `expected` for a wait, not just for an assert', async () => {
    await runStep(
      'Wait for the rows',
      [plan([{ action: 'wait', waitType: 'count', condition: 'tbody tr', expected: '{{rows}}', description: 'Wait' }])],
      { parameters: { rows: '5' } },
    );
    expect(actions.received[0]!.expected).toBe('5');
  });

  it('substitutes `expected` BEFORE the assertion code is generated', async () => {
    const { client } = await runStep(
      'Verify the heading',
      [
        plan([
          {
            action: 'assert',
            against: 'dom',
            condition: 'visible page heading',
            expected: '{{outcome_heading}}',
            description: 'Heading matches',
          },
        ]),
        JSON.stringify({ code: '(() => ({ pass: true, actual: "Dashboard" }))()' }),
      ],
      { parameters: { outcome_heading: 'Dashboard' } },
    );
    // The assertion-code prompt is the second AI call. It must carry the
    // resolved expectation, or the generated comparison checks for the
    // literal characters "{{outcome_heading}}".
    const codePrompt = allRequestText({ requests: [client.requests[1]!] });
    expect(codePrompt).toContain('- Expected: Dashboard');
    expect(codePrompt).not.toContain('{{outcome_heading}}');
  });

  it('never treats `as` as a reference — it names a variable being defined', async () => {
    const { result } = await runStep(
      'Read the balance [store as: balance]',
      [plan([{ action: 'read', selector: '#total', as: 'balance', description: 'Read the balance' }])],
      // A parameter of the same name exists: substituting `as` would rename
      // the capture to its own previous value.
      { parameters: { balance: '£1.00' } },
    );
    expect(result.status).toBe('passed');
    expect(actions.received[0]!.as).toBe('balance');
  });

  it('does not re-scan a value it just inserted', async () => {
    await runStep(
      'Type the template',
      [plan([{ action: 'type', selector: '#t', value: '{{tpl}}', description: 'Type' }])],
      { parameters: { tpl: 'Hello {{name}}', name: 'SHOULD NOT APPEAR' } },
    );
    expect(actions.received[0]!.value).toBe('Hello {{name}}');
  });

  it('renders a name nothing has captured yet as (not yet captured)', async () => {
    const { client } = await runStep(
      'Check the balance',
      [plan([{ action: 'assert', against: 'dom', condition: 'balance', expected: 'x', description: 'Check' }]),
       JSON.stringify({ code: '(() => ({ pass: true, actual: "x" }))()' })],
      { authored: 'Check the balance equals {{balance}}' },
    );
    expect(allRequestText(client)).toContain('- {{balance}} resolved to "(not yet captured)" on this run');
  });
});

// ── The structured capture (SPEC-structured-table-reads.md §12, item 13) ────

describe('a readTable capture is stored as JSON under its name', () => {
  it('JSON-encodes the records, _row first, into the live parameter map', async () => {
    const parameters: Record<string, string> = {};
    const { result } = await runStep(
      'Read the Order ID and Customer columns from every row in the Orders table',
      [plan([{
        action: 'readTable',
        selector: '#orders',
        columns: [{ header: 'Order ID', key: 'id' }, { header: 'Customer', key: 'customer' }],
        as: 'orders',
        description: 'Read the Orders table',
      } as AIAction])],
      { parameters },
    );
    expect(result.status).toBe('passed');
    // The map stays Record<string, string>, so nothing about the protocol or
    // the session storage has to change (§7.1) — and `For each` parses this
    // string straight back. Byte-for-byte, because `_row` and the column
    // order are the contract: a later pass finds its row BY `_row`, and a
    // record without it can only be matched by its values, which is exactly
    // what two rows sharing a payee make impossible.
    expect(parameters['orders']).toBe(
      '[{"_row":"1","id":"ORD-1001","customer":"Alice Smith"},'
      + '{"_row":"2","id":"ORD-1002","customer":"Bob Jones"}]',
    );
    expect(JSON.parse(parameters['orders']!).map((r: Record<string, string>) => r['_row']))
      .toEqual(['1', '2']);
  });

  it('logs the count under the variable name, not the rows', async () => {
    const lines: string[] = [];
    const stop = addLogCallback((_level, message) => { lines.push(message); });
    try {
      await runStep(
        'Read the Orders table',
        [plan([{
          action: 'readTable',
          selector: '#orders',
          columns: [{ header: 'Order ID', key: 'id' }],
          as: 'orders',
          description: 'Read the Orders table',
        } as AIAction])],
        { parameters: {} },
      );
    } finally {
      stop();
    }
    expect(lines).toContain('Stored 2 row records as "{{orders}}"');
    // Counts, not contents (§7.6): the captured cells belong in the variable
    // and the report, not in every console the run passes through.
    expect(lines.join('\n')).not.toContain('Alice Smith');
  });

  it('stores [] for an empty table, so For each runs zero passes rather than failing', async () => {
    const parameters: Record<string, string> = {};
    const empty = vi.mocked(await import('../src/browser/actions.js')).executeAction;
    empty.mockImplementationOnce(async (_page: unknown, action: AIAction) => {
      actions.received.push(action);
      return { success: true, capturedRecords: [] };
    });
    await runStep(
      'Read the Orders table',
      [plan([{
        action: 'readTable',
        selector: '#orders',
        columns: [{ header: 'Order ID', key: 'id' }],
        as: 'orders',
        description: 'Read the Orders table',
      } as AIAction])],
      { parameters },
    );
    // `[]`, not undefined and not a missing entry: the reference resolves and
    // the loop over it is empty (§4.8).
    expect(parameters['orders']).toBe('[]');
  });
});

// ── The refusal ─────────────────────────────────────────────────────────────

describe('an unknown reference fails the turn before any of its actions run', () => {
  it('runs none of three actions when the second one is bad', async () => {
    const { result } = await runStep(
      'Sign in',
      [
        plan([
          { action: 'type', selector: '#email', value: '{{email}}', description: 'Email' },
          { action: 'type', selector: '#pw', value: '{{emial}}', description: 'Password' },
          { action: 'click', selector: '#go', description: 'Sign in' },
        ]),
      ],
      { parameters: { email: 'a@b.c' } },
    );

    expect(result.status).toBe('failed');
    expect(actions.received).toHaveLength(0);
    expect(result.error).toContain('{{emial}}');
  });

  it('leaves turn 1 standing when turn 2 is the bad one', async () => {
    const { result } = await runStep(
      'Sign in',
      [
        plan([{ action: 'type', selector: '#email', value: '{{email}}', description: 'Email' }], true),
        plan([{ action: 'type', selector: '#pw', value: '{{nope}}', description: 'Password' }]),
      ],
      { parameters: { email: 'a@b.c' } },
    );

    expect(result.status).toBe('failed');
    expect(actions.received).toHaveLength(1);
    expect(actions.received[0]!.value).toBe('a@b.c');
  });

  it('refuses `{{ email }}` — spaces inside the braces — naming the right key', async () => {
    const { result } = await runStep(
      'Enter the email',
      [plan([{ action: 'type', selector: '#email', value: '{{ email }}', description: 'Email' }])],
      { parameters: { email: 'a@b.c' } },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('{{email}}');
    expect(actions.received).toHaveLength(0);
  });

  it('refuses `{{Email}}` — wrong case — naming the right key', async () => {
    const { result } = await runStep(
      'Enter the email',
      [plan([{ action: 'type', selector: '#email', value: '{{Email}}', description: 'Email' }])],
      { parameters: { email: 'a@b.c' } },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('did you mean `{{email}}`');
    expect(actions.received).toHaveLength(0);
  });

  it('says "captured later" for a name a later step defines', async () => {
    const { result } = await runStep(
      'Use the balance',
      [plan([{ action: 'type', selector: '#b', value: '{{balance}}', description: 'Type balance' }])],
      { testSteps: ['Use the balance {{balance}}', 'Read the total [store as: balance]'] },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('captured later in this test');
  });

  it('refuses a `${data.typo}` the model invented', async () => {
    const { result } = await runStep(
      'Open the admin page',
      [plan([{ action: 'navigate', url: '${data.typo}', description: 'Go' }])],
      { envData: ENV_DATA },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('${data.typo}');
    expect(actions.received).toHaveLength(0);
  });

  it('lets a resolvable `${…}` through', async () => {
    await runStep(
      'Sign in as the admin',
      [plan([{ action: 'type', selector: '#e', value: '${data.users.admin.email}', description: 'Email' }])],
      { envData: ENV_DATA },
    );
    expect(actions.received[0]!.value).toBe('admin@app.test');
  });

  it('refuses `***` typed as a value, with the mask message', async () => {
    const { result } = await runStep(
      'Enter the password',
      [plan([{ action: 'type', selector: '#pw', value: '***', description: 'Password' }])],
      { parameters: { password: 'hunter2' } },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('mask over a secret value');
    expect(actions.received).toHaveLength(0);
  });

  it('still allows `***` as something to ASSERT — a masked field is a real page', async () => {
    const { result } = await runStep(
      'Verify the password field is masked',
      [
        plan([{ action: 'assert', against: 'dom', condition: 'password field text', expected: '***', description: 'Masked' }]),
        JSON.stringify({ code: '(() => ({ pass: true, actual: "***" }))()' }),
      ],
      { parameters: { password: 'hunter2' } },
    );
    expect(result.status).toBe('passed');
  });
});

// ── The other callers ───────────────────────────────────────────────────────

describe('every path through the executor substitutes', () => {
  it('a cached turn', async () => {
    const cached: StepCache = {
      read: async () => [
        {
          rawResponse: plan([{ action: 'type', selector: '#email', value: '{{email}}', description: 'Email' }]),
          actions: [{ action: 'type', selector: '#email', value: '{{email}}', description: 'Email' }],
          reasoning: 'cached',
        },
      ],
      write: async () => {},
      invalidateStep: async () => {},
      readAssertion: async () => null,
    } as unknown as StepCache;

    const { result } = await runStep(
      'Enter the email',
      ['(the AI must not be called on a cache hit)'],
      { parameters: { email: 'demo@securebank.com' }, stepCache: cached },
    );
    expect(result.status).toBe('passed');
    expect(actions.received[0]!.value).toBe('demo@securebank.com');
  });

  it('a branched step — which used to type the placeholder literally', async () => {
    const group: StepGroup = {
      conditionalSteps: [{ index: 1, instruction: 'If asked for a code, enter {{otp}}' }],
      continuationStep: { index: 2, instruction: 'Wait for the dashboard' },
    };
    const client = scriptedClient([
      JSON.stringify({
        matched: 'A',
        actions: [{ action: 'type', selector: '#otp', value: '{{otp}}', description: 'Enter code' }],
        reasoning: 'the code box is showing',
      }),
      plan([{ action: 'type', selector: '#otp', value: '{{otp}}', description: 'Enter code' }]),
      plan([{ action: 'wait', waitType: 'load', condition: 'networkidle', description: 'Wait' }]),
    ]);

    const results = await executeBranchedStep(group, 2, {
      page: fakePage(),
      config: CONFIG,
      aiClient: client,
      contextContent: '',
      testName: 'branched',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: { otp: '123456' },
    });

    expect(results.some((r) => r.status === 'failed')).toBe(false);
    const typed = actions.received.find((a) => a.action === 'type');
    expect(typed?.value).toBe('123456');
    // And the step's own text resolved too — it never was, before.
    const matched = results.find((r) => r.index === 1)!;
    expect(matched.instruction).toBe('If asked for a code, enter 123456');
  });

  it('a line typed at the interactive REPL', async () => {
    const client = scriptedClient([
      plan([{ action: 'type', selector: '#email', value: '{{email}}', description: 'Email' }]),
    ]);
    const adHocResults: import('../src/report/types.js').StepResult[] = [];
    const lines = ['Enter the email {{email}}', '/continue'];
    let next = 0;

    await runInteractiveRepl({
      page: fakePage(),
      testSteps: ['Enter the email {{email}}'],
      currentStepIndex: 1,
      entryReason: 'planned',
      executorOptions: {
        page: fakePage(),
        config: CONFIG,
        aiClient: client,
        contextContent: '',
        testName: 'repl',
        conversationHistory: [],
        csrfTokens: {},
        resolvedParameters: { email: 'demo@securebank.com' },
      },
      adHocResults,
      reader: { question: async () => lines[next++] ?? '/continue', close: () => {} },
      write: () => {},
    });

    expect(adHocResults[0]!.status).toBe('passed');
    expect(actions.received[0]!.value).toBe('demo@securebank.com');
  });
});

// ── Secrecy ─────────────────────────────────────────────────────────────────

describe('a secret-named value never reaches the model', () => {
  it('is absent from every request of a two-step run', async () => {
    const PASSWORD = 'sup3rSecret!value';
    const history: string[] = [];
    const parameters = { email: 'demo@securebank.com', password: PASSWORD };
    const page = fakePage();

    const clients: Array<{ requests: ChatMessage[][] }> = [];
    for (const [index, step] of [
      'Enter the email {{email}}',
      'Enter the password {{password}} and sign in',
    ].entries()) {
      // Two turns on each step, so the continuation block — the widest of the
      // three surfaces the password used to reach — is exercised as well.
      const client = scriptedClient([
        plan([{ action: 'type', selector: '#f', value: '{{password}}', description: 'Type it' }], true),
        plan([{ action: 'click', selector: '#go', description: 'Continue' }]),
      ]);
      clients.push(client);
      const result = await executeStep(
        index + 1,
        2,
        step.replace('{{email}}', parameters.email).replace('{{password}}', PASSWORD),
        {
          page,
          config: CONFIG,
          aiClient: client,
          contextContent: '',
          testName: 'secrecy',
          // The history the runners build, masked as they now mask it.
          conversationHistory: [...history],
          csrfTokens: {},
          resolvedParameters: parameters,
        },
        step,
      );
      expect(result.status).toBe('passed');
      history.push(`Step ${index + 1}: [PASSED] ${result.instruction.split(PASSWORD).join('***')}`);
    }

    for (const client of clients) {
      expect(allRequestText(client)).not.toContain(PASSWORD);
    }
    // ...and the page still received the real thing.
    expect(actions.received.some((a) => a.value === PASSWORD)).toBe(true);
  });

  it('masks a secret value in the DOM snapshot before the snapshot is sent', async () => {
    const domCleaner = await import('../src/browser/dom-cleaner.js');
    vi.mocked(domCleaner.captureDomSnapshot).mockResolvedValueOnce(
      '<input id="pw" value="hunter2">',
    );
    const { client } = await runStep(
      'Sign in',
      [plan([{ action: 'click', selector: '#go', description: 'Sign in' }])],
      { parameters: { password: 'hunter2' } },
    );
    expect(allRequestText(client)).not.toContain('hunter2');
    expect(allRequestText(client)).toContain('<input id="pw" value="***">');
  });

  it('unmasks a name the test declared is not a secret', async () => {
    const { client } = await runStep(
      'Search for the keyword',
      [plan([{ action: 'type', selector: '#q', value: '{{keyword}}', description: 'Search' }])],
      {
        parameters: { keyword: 'debentures' },
        authored: 'Search for {{keyword}}',
        unmask: new Set(['keyword']),
      },
    );
    expect(allRequestText(client)).toContain('- {{keyword}} resolved to "debentures" on this run');
  });

  it('masks that same name without the hatch', async () => {
    const { client } = await runStep(
      'Search for the keyword',
      [plan([{ action: 'type', selector: '#q', value: '{{keyword}}', description: 'Search' }])],
      { parameters: { keyword: 'debentures' }, authored: 'Search for {{keyword}}' },
    );
    expect(allRequestText(client)).toContain('- {{keyword}} resolved to "***" on this run');
    // The page still gets the real value — masking is a prompt rule, not a run
    // rule.
    expect(actions.received[0]!.value).toBe('debentures');
  });
});

// ── The module's own rules, without a step around them ──────────────────────

describe('the walk and the copy', () => {
  it('skips the name-like fields entirely', () => {
    const seen: Array<[string, string]> = [];
    walkActionStrings(
      {
        action: 'read',
        selector: '#t',
        as: '{{name}}',
        pattern: '\{\{(\d+)\}\}',
        attribute: 'href',
        against: 'dom',
        description: 'Read',
      },
      (text, field) => seen.push([field, text]),
    );
    expect(seen.map(([field]) => field).sort()).toEqual(['description', 'selector']);
  });

  it('returns the action itself when nothing changed — the copy is not gratuitous', () => {
    const action = {
      action: 'api_call' as const,
      url: '/x',
      body: { a: ['b'] },
      description: 'Call',
    };
    expect(substituteAction(action, { parameters: { unused: '1' } })).toBe(action);
  });

  it('copies rather than mutates when something did change', () => {
    const action = { action: 'type' as const, value: '{{v}}', description: 'Type' };
    const out = substituteAction(action, { parameters: { v: 'X' } });
    expect(out).not.toBe(action);
    expect(action.value).toBe('{{v}}');
    expect(out.value).toBe('X');
  });

  it('sees `{{ email }}` and `{{Email}}`, which the substituter does not', () => {
    const { placeholders } = collectReferences('a {{email}} b {{ email }} c {{Email}}');
    expect(placeholders).toEqual([
      { name: 'email', raw: '{{email}}' },
      { name: 'email', raw: '{{ email }}' },
      { name: 'Email', raw: '{{Email}}' },
    ]);
  });

  it('treats `store as {{x}}` in prose as a definition, not a reference', () => {
    expect(inlineStoreAsNames('Read the balance and store it as {{balance}}')).toEqual(['balance']);
    expect(inlineStoreAsNames('Save as {{total}}')).toEqual(['total']);
    expect(inlineStoreAsNames('Enter the email {{email}}')).toEqual([]);
  });

  it('passes a clean turn', () => {
    expect(
      checkTurnReferences(
        [{ action: 'type', value: '{{email}}', description: 'Type' }],
        { known: new Set(['email']) },
      ),
    ).toBeUndefined();
  });

  it('does not check `${…}` when the run has no environment', () => {
    // Nothing resolved those references in the step text either, so refusing
    // here would fail a turn on text the model read off the page.
    expect(
      checkTurnReferences(
        [{ action: 'type', value: 'literally ${data.x}', description: 'Type' }],
        { known: new Set() },
      ),
    ).toBeUndefined();
  });
});
