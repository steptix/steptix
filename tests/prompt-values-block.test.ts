import { describe, expect, it } from 'vitest';
import {
  buildContinuationMessage,
  buildStepCodePrompt,
  buildStepMessage,
  buildSystemPrompt,
  contentBlocksToText,
  formatParameterBlock,
  formatTestInfo,
} from '../src/ai/prompts.js';
import type { ChatMessage } from '../src/ai/types.js';
import { buildRepairPrompt } from '../src/codebehind/repair.js';
import { markLoopBindings } from '../src/utils/secrets.js';

/**
 * The prompt half of stories/placeholder-preserving-actions.md, phase 1: the
 * model reads the step as AUTHORED plus a `## Values` table saying what each
 * placeholder holds, and puts the placeholder — not the value — in the field
 * it filled from it.
 *
 * Two things are load-bearing here beyond "the block renders". A secret-named
 * value must never reach the table (decision 2), and a step that references
 * nothing must produce the prompt this function produced before the block
 * existed, byte for byte — that is what makes the change additive for every
 * test with no parameters.
 */

function textOf(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  const first = msg.content.find((b) => b.type === 'text');
  return first && first.type === 'text' ? first.text : '';
}

const DOM = '<html></html>';

describe('buildStepMessage — the ## Values block', () => {
  it('renders a referenced {{name}} with its value, between the step and the DOM', () => {
    const text = textOf(
      buildStepMessage('Enter the email {{email}}', DOM, null, [], undefined, undefined, undefined, {
        parameters: [{ name: 'email', value: 'demo@securebank.com' }],
      }),
    );

    expect(text).toContain('## Values');
    expect(text).toContain('- {{email}} resolved to "demo@securebank.com" on this run');
    // The step keeps its placeholder — that is the whole point of the table.
    expect(text).toContain('## Current Step\nEnter the email {{email}}');
    expect(text.indexOf('## Current Step')).toBeLessThan(text.indexOf('## Values'));
    expect(text.indexOf('## Values')).toBeLessThan(text.indexOf('## DOM Snapshot'));
  });

  it('masks a secret-named value — the model names the placeholder, the framework types the value', () => {
    const text = textOf(
      buildStepMessage('Enter the password {{password}}', DOM, null, [], undefined, undefined, undefined, {
        parameters: [{ name: 'password', value: 'hunter2-correct-horse' }],
      }),
    );

    expect(text).toContain('- {{password}} resolved to "***" on this run');
    expect(text).not.toContain('hunter2-correct-horse');
  });

  it('renders a ${…} reference in the envRefs shape, with the getVar name that reads it', () => {
    const text = textOf(
      buildStepMessage('Sign in as ${data.users.admin.email}', DOM, null, [], undefined, undefined, undefined, {
        parameters: [],
        envRefs: [{ ref: 'data.users.admin.email', value: 'admin@example.com' }],
      }),
    );

    expect(text).toContain(
      '- ${data.users.admin.email} resolved to "admin@example.com" on this run — read it with ' +
        'step.getVar("data.users.admin.email"); the value differs per environment',
    );
  });

  it('masks a ${…} reference by its PATH, not just its last segment', () => {
    const text = textOf(
      buildStepMessage('Use the host ${data.secrets.smtp.host}', DOM, null, [], undefined, undefined, undefined, {
        parameters: [],
        envRefs: [{ ref: 'data.secrets.smtp.host', value: 'smtp.internal.example' }],
      }),
    );

    // `host` is innocent; `secrets` on the way to it is not — the same rule
    // envDataSecretValues applies when it collects the values to mask.
    expect(text).toContain('- ${data.secrets.smtp.host} resolved to "***" on this run');
    expect(text).not.toContain('smtp.internal.example');
  });

  it('unmask exempts a name the test declared is not a secret', () => {
    const values = {
      parameters: [{ name: 'keyword', value: 'mortgage' }],
      unmask: new Set(['keyword']),
    };
    const text = textOf(buildStepMessage('Search for {{keyword}}', DOM, null, [], undefined, undefined, undefined, values));

    // isSecretName matches "keyword" via /key/i, and a term the model has to
    // find in the DOM is unusable as `***`.
    expect(text).toContain('- {{keyword}} resolved to "mortgage" on this run');
    expect(text).not.toContain('***');
  });

  it('renders NO block for a step that references nothing, and an empty one is the same as none', () => {
    const testInfo = formatTestInfo('Login flow', 'https://example.com', 1, 2);
    const history = ['Step 1: [✓ PASSED] Open the app'];
    const scroll = { scrollTop: 0, clientHeight: 800, scrollHeight: 1600 };

    const noValues = textOf(buildStepMessage('Click login', DOM, null, history, undefined, testInfo, scroll));
    const emptyValues = textOf(
      buildStepMessage('Click login', DOM, null, history, undefined, testInfo, scroll, {
        parameters: [],
        envRefs: [],
      }),
    );

    // Compared with each other rather than with a frozen copy of the whole
    // prompt: an empty values object must change nothing, and the wording of
    // Test Information, Prior Steps or the scroll line is not this block's.
    expect(emptyValues).toBe(noValues);
    expect(noValues).not.toContain('## Values');
  });
});

describe('buildContinuationMessage — the masked table replaces the whole parameter map', () => {
  const completed = [{ action: 'type', description: 'Enter the email' }];

  it('renders the table, scoped to what the step references, with secrets masked', () => {
    const text = textOf(
      buildContinuationMessage(
        'Sign in as {{email}} with {{password}}',
        completed,
        // The whole resolved map — what the block used to render, unmasked.
        { email: 'demo@securebank.com', password: 'hunter2-correct-horse', unreferenced_note: 'row-1' },
        'https://app.example.com/login',
        DOM,
        null,
        2,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          parameters: [
            { name: 'email', value: 'demo@securebank.com' },
            { name: 'password', value: 'hunter2-correct-horse' },
          ],
        },
      ),
    );

    expect(text).toContain('## Values');
    expect(text).toContain('- {{email}} resolved to "demo@securebank.com" on this run');
    expect(text).toContain('- {{password}} resolved to "***" on this run');
    expect(text).not.toContain('hunter2-correct-horse');
    // Scoped: a parameter the step never mentions is not in the turn's prompt.
    expect(text).not.toContain('unreferenced_note');
    expect(text).not.toContain('row-1');
    expect(text).not.toContain('Variables captured so far:');
  });

  it('echoes the authored instruction, placeholders intact, in both places', () => {
    const text = textOf(
      buildContinuationMessage(
        'Enter the email demo@securebank.com',
        completed,
        {},
        'https://app.example.com/login',
        DOM,
        null,
        2,
        undefined,
        undefined,
        undefined,
        undefined,
        { parameters: [{ name: 'email', value: 'demo@securebank.com' }] },
        'Enter the email {{email}}',
      ),
    );

    expect(text).toContain('Original instruction: "Enter the email {{email}}"');
    expect(text).toContain('complete the original instruction: "Enter the email {{email}}"?');
    expect(text).not.toContain('Enter the email demo@securebank.com');
  });

  it('keeps the pre-values block for a caller that has not been threaded yet', () => {
    const text = textOf(
      buildContinuationMessage(
        'check balance',
        completed,
        { account_balance: '$1,234.56' },
        'https://app.example.com/',
        DOM,
        null,
        2,
      ),
    );

    expect(text).toContain('Variables captured so far:');
    expect(text).toContain('account_balance = "$1,234.56"');
    expect(text).not.toContain('## Values');
  });
});

describe('formatParameterBlock — masking', () => {
  it('masks by name for {{…}} and by path for ${…}, and leaves everything else alone', () => {
    const block = formatParameterBlock(
      [
        { name: 'email', value: 'demo@securebank.com' },
        { name: 'password', value: 'hunter2-correct-horse' },
        { name: 'api_token', value: 'tok_live_9' },
      ],
      [
        { ref: 'data.url', value: 'https://uat.example/' },
        { ref: 'env.PASSWORD', value: 'env-secret' },
        { ref: 'data.secrets.smtp.host', value: 'smtp.internal.example' },
      ],
    );

    expect(block).toContain('- {{email}} resolved to "demo@securebank.com" on this run');
    expect(block).toContain('- {{password}} resolved to "***" on this run');
    expect(block).toContain('- {{api_token}} resolved to "***" on this run');
    expect(block).toContain('- ${data.url} resolved to "https://uat.example/" on this run');
    expect(block).toContain('- ${env.PASSWORD} resolved to "***" on this run');
    expect(block).toContain('- ${data.secrets.smtp.host} resolved to "***" on this run');
    for (const leaked of ['hunter2-correct-horse', 'tok_live_9', 'env-secret', 'smtp.internal.example']) {
      expect(block).not.toContain(leaked);
    }
  });

  it('masks a secret-named entry whose value is empty — the name is the rule', () => {
    const block = formatParameterBlock([{ name: 'password', value: '' }], []);
    expect(block).toBe('- {{password}} resolved to "***" on this run');
  });

  it('unmask exempts a name and a ref', () => {
    const block = formatParameterBlock(
      [{ name: 'keyword', value: 'mortgage' }],
      [{ ref: 'data.keys.public', value: 'pk_123' }],
      new Set(['keyword', 'data.keys.public']),
    );
    expect(block).toContain('- {{keyword}} resolved to "mortgage" on this run');
    expect(block).toContain('- ${data.keys.public} resolved to "pk_123" on this run');
  });

  it('decides a loop binding by its property, not by the substring rule on the whole name', () => {
    // A For each over table records leaves `row.<column>` in the map. The
    // property is page-derived, so it takes the record-column rule: `keyword`
    // is not `key`, `token` is. The root stays author-chosen: `secret.value`.
    const block = formatParameterBlock(
      [
        { name: 'row.keyword', value: 'mortgage' },
        { name: 'row.token', value: 'tok_live_9' },
        { name: 'secret.value', value: 's3cr3t-value' },
      ],
      [],
    );
    expect(block).toContain('- {{row.keyword}} resolved to "mortgage" on this run');
    expect(block).toContain('- {{row.token}} resolved to "***" on this run');
    expect(block).toContain('- {{secret.value}} resolved to "***" on this run');
    for (const leaked of ['tok_live_9', 's3cr3t-value']) expect(block).not.toContain(leaked);
  });

  it('still says so when the step uses nothing', () => {
    expect(formatParameterBlock([], [])).toBe('(this step uses no parameters)');
  });
});

/**
 * The name rule has nothing to catch on a `readTable` capture: the whole table
 * lives under one author-chosen name (`payments`) and one pass's record under
 * another (`payment`), so both rendered RAW — every column of every row,
 * password included, in the outbound prompt. Beside them, the DOM in the same
 * message is `redact(domSnapshot, …)`ed, so the same value was masked in one
 * half of the message and printed in the other.
 *
 * Two layers answer it, because either alone leaves a hole: `maskRecordSecrets`
 * is structural and catches a column however short or freshly-captured its
 * value is, and `redact` catches a secret that reached the value by some other
 * route than a secret-named column.
 */
describe('formatParameterBlock — a record capture is masked by its columns', () => {
  const PAYMENTS = JSON.stringify([
    { _row: '1', payee: 'Acme', password: 'hunter2-long' },
    { _row: '2', payee: 'Origin', password: 'correct-horse' },
  ]);
  const PAYMENT = JSON.stringify({ _row: '1', payee: 'Acme', password: 'hunter2-long' });

  it('masks the password column of a readTable capture and of one pass record', () => {
    const block = formatParameterBlock(
      [
        { name: 'payments', value: PAYMENTS },
        { name: 'payment', value: PAYMENT },
        { name: 'payment.payee', value: 'Acme' },
        { name: 'payment.password', value: 'hunter2-long' },
      ],
      [],
    );
    // The row survives as evidence — the model still has to find Acme in the
    // page — with the one cell blanked.
    expect(block).toContain('{{payments}} resolved to');
    expect(block).toContain('Acme');
    expect(block).toContain('Origin');
    expect(block).toContain('{{payment.payee}} resolved to "Acme" on this run');
    expect(block).toContain('{{payment.password}} resolved to "***" on this run');
    for (const leaked of ['hunter2-long', 'correct-horse']) {
      expect(block).not.toContain(leaked);
    }
  });

  it('also masks by value, for a secret that reached the entry some other way', () => {
    // `{{summary}}` is not secret-named and holds no records — but the run's
    // password is inside it, and every other surface that writes this value
    // masks it.
    const block = formatParameterBlock(
      [{ name: 'summary', value: 'signed in as octocat with hunter2-correct' }],
      [{ ref: 'data.note', value: 'the key is hunter2-correct' }],
      new Set<string>(),
      ['hunter2-correct'],
    );
    expect(block).toContain('signed in as octocat with ***');
    expect(block).toContain('the key is ***');
    expect(block).not.toContain('hunter2-correct');
  });

  it('leaves a record with no secret column exactly as it arrived', () => {
    const plain = JSON.stringify([{ _row: '1', payee: 'Acme', amount: '$1.00' }]);
    expect(formatParameterBlock([{ name: 'payments', value: plain }], []))
      .toBe(`- {{payments}} resolved to ${JSON.stringify(plain)} on this run`);
  });

  it('reaches the generation prompt too, which shares the formatter', () => {
    // `buildStepCodePrompt` passes no mask set — `compile.ts` has none to
    // give it — so the free-text layer is absent there. The structural one
    // is not: it needs nothing but the value, which is why it is the layer
    // that closes this on every prompt at once.
    const text = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Review {{payments}}',
        parameters: [{ name: 'payments', value: PAYMENTS }],
        actions: [],
      }).content,
    );
    expect(text).toContain('Acme');
    expect(text).not.toContain('hunter2-long');
  });

  it('keeps unmask meaning what it says — neither layer runs on an exempt name', () => {
    // The hatch exists because `isSecretName` matches `key` and the model must
    // be able to find the `keyword` column in the page. Masking it by value
    // here would take it away again through the other door.
    const block = formatParameterBlock(
      [{ name: 'keyword', value: 'mortgage' }],
      [],
      new Set(['keyword']),
      ['mortgage'],
    );
    expect(block).toBe('- {{keyword}} resolved to "mortgage" on this run');
  });
});

describe('system prompt — the placeholder rule and the rewritten predicate clause', () => {
  const flat = contentBlocksToText(buildSystemPrompt(''));

  it('carries the placeholder rule, scoped to the action JSON', () => {
    expect(flat).toContain('8a. PLACEHOLDERS — name the value you used, do not copy it.');
    expect(flat).toContain('A name listed under "## Values" is a placeholder');
    expect(flat).toContain('write the PLACEHOLDER in that field and not the value it holds');
    expect(flat).toContain('Never put a placeholder in "description"');
    expect(flat).toContain('A placeholder that follows "store as" or "save as" names a variable you are DEFINING');
    expect(flat).toContain('"***" is a mask over a secret value, never a value to type');
    expect(flat).toContain('Only the names listed under "## Values" are placeholders');
    expect(flat).toContain('a step that writes "\\{{count}}" means those characters literally');
  });

  it('shows one action that names a placeholder and one that must not', () => {
    expect(flat).toContain('"value": "{{email}}"');
    expect(flat).toContain('NOT "value": "demo@securebank.com"');
    expect(flat).toContain('Counter-example — step "Verify {{outcome}}"');
    expect(flat).toContain('A placeholder goes in a field only when that field is filled FROM its value.');
  });

  it('tells the model to leave a predicate condition as written', () => {
    expect(flat).toContain('Set "condition" to the predicate AS WRITTEN, placeholders included');
    expect(flat).toContain('the framework substitutes them before the check is generated');
    expect(flat).toContain('"condition": "{{order_count}} is at least 5"');
    // The pre-substitution premise is gone.
    expect(flat).not.toContain('the resolved English predicate verbatim');
    expect(flat).not.toContain('both sides of the comparison are already substituted');
  });
});

describe('code-generation prompt — a placeholder-bearing selector', () => {
  const base = {
    rawStepText: 'Click the {{plan}} tab',
    parameters: [{ name: 'plan', value: 'Premium' }],
  };

  it('is rebuilt from getVar whatever resolvedBy says', () => {
    const text = textOf(
      buildStepCodePrompt({
        ...base,
        actions: [
          {
            action: 'click',
            selector: 'text={{plan}}',
            description: 'Click the plan tab',
            targeting: {
              matchCount: 1,
              visibleMatchCount: 1,
              resolvedSelector: 'a[href="plans/premium.html"]',
              resolvedBy: 'attribute',
            },
          },
        ],
      }),
    );

    expect(text).toContain('A selector that CARRIES A PLACEHOLDER');
    expect(text).toContain("rebuild it from `step.getVar('plan')` whatever `resolvedBy` says");
    expect(text).toContain('advisory only here');
  });

  it('is not mentioned for a step whose selectors carry none', () => {
    const text = textOf(
      buildStepCodePrompt({
        ...base,
        rawStepText: 'Click the Premium tab',
        actions: [{ action: 'click', selector: '#premium', description: 'Click the Premium tab' }],
      }),
    );

    expect(text).not.toContain('CARRIES A PLACEHOLDER');
  });
});

/**
 * Review 5, finding 5: `formatParameterBlock` judged a dotted name with no map
 * to ask.
 *
 * With nothing to ask, `isSecretParameterName` answers with the BINDING rule —
 * root, then the narrow whole-word record rule on the property — which is right
 * for a `For each` pass's `row.keyword` and wrong for every dotted name a
 * person typed. A data file's own `user.apikey` heading is merged into the
 * variable map by `resolveParameters`, splits to `apikey`, matches neither
 * half, and rendered its credential into the compile's generation and repair
 * prompts in clear. The map is what says which is which (§7.6), and it has to
 * be the LIVE object: the loop-binding registry is by identity.
 */
describe('formatParameterBlock — whose name is it', () => {
  function liveMap(): Record<string, string> {
    const map = { 'user.apikey': 'uk_live_1234', 'row.keyword': 'AU' };
    markLoopBindings(map, ['row.keyword']);
    return map;
  }

  const params = [
    { name: 'user.apikey', value: 'uk_live_1234' },
    { name: 'row.keyword', value: 'AU' },
  ];

  it('masks the heading nobody bound and leaves the column a pass did', () => {
    const block = formatParameterBlock(params, [], new Set<string>(), [], liveMap());
    expect(block).toContain('- {{user.apikey}} resolved to "***" on this run');
    expect(block).toContain('- {{row.keyword}} resolved to "AU" on this run');
    expect(block).not.toContain('uk_live_1234');
  });

  it('without a map both take the binding rule — the behaviour this replaces', () => {
    // Kept as the statement of what the map buys: the same two names, asked
    // with nothing to ask, and the credential is in the block.
    const block = formatParameterBlock(params, []);
    expect(block).toContain('uk_live_1234');
  });

  it('the repair prompt asks it', () => {
    const text = textOf(
      buildRepairPrompt({
        rawStepText: 'Check the row for {{user.apikey}}',
        stepIndex: 1,
        entryCode: '{ source: "x", async run() {} }',
        error: 'timed out',
        parameters: params,
        parameterMap: liveMap(),
      }),
    );
    expect(text).toContain('- {{user.apikey}} resolved to "***" on this run');
    expect(text).toContain('- {{row.keyword}} resolved to "AU" on this run');
    expect(text).not.toContain('uk_live_1234');
  });

  it('the generation prompt asks it', () => {
    const text = textOf(
      buildStepCodePrompt({
        rawStepText: 'Check the row for {{user.apikey}}',
        parameters: params,
        parameterMap: liveMap(),
        actions: [],
      }),
    );
    expect(text).toContain('- {{user.apikey}} resolved to "***" on this run');
    expect(text).toContain('- {{row.keyword}} resolved to "AU" on this run');
    expect(text).not.toContain('uk_live_1234');
  });

  it('and so does the step prompt’s ## Values block, through StepValues.map', () => {
    const text = textOf(
      buildStepMessage('Check the row for {{user.apikey}}', DOM, null, [], undefined, undefined, undefined, {
        parameters: params,
        map: liveMap(),
      }),
    );
    expect(text).toContain('- {{user.apikey}} resolved to "***" on this run');
    expect(text).toContain('- {{row.keyword}} resolved to "AU" on this run');
    expect(text).not.toContain('uk_live_1234');
  });
});
