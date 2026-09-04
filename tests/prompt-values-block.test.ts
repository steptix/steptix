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

  it('renders NO block for a step that references nothing, and the prompt is byte-identical to today\'s', () => {
    const testInfo = formatTestInfo('Login flow', 'https://example.com', 1, 2);
    const history = ['Step 1: [✓ PASSED] Open the app'];
    const scroll = { scrollTop: 0, clientHeight: 800, scrollHeight: 1600 };

    // Captured from the function as it stood before the ## Values block existed.
    const BEFORE = [
      '## Test Information',
      '- Test: Login flow',
      '- Base URL: https://example.com',
      '- Current Step: 1 of 2',
      '',
      '## Prior Steps',
      'Step 1: [✓ PASSED] Open the app',
      '',
      '## Current Step',
      'Click login',
      '',
      'Scroll position: 0–800 of 1600px (at top)',
      '',
      '## DOM Snapshot',
      '```html',
      '<html></html>',
      '```',
    ].join('\n');

    const noValues = textOf(buildStepMessage('Click login', DOM, null, history, undefined, testInfo, scroll));
    const emptyValues = textOf(
      buildStepMessage('Click login', DOM, null, history, undefined, testInfo, scroll, {
        parameters: [],
        envRefs: [],
      }),
    );

    expect(noValues).toBe(BEFORE);
    expect(emptyValues).toBe(BEFORE);
    expect(noValues).not.toContain('## Values');
    expect(emptyValues).not.toContain('## Values');
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

  it('still says so when the step uses nothing', () => {
    expect(formatParameterBlock([], [])).toBe('(this step uses no parameters)');
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
