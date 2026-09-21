import { describe, it, expect } from 'vitest';
import {
  parseAIResponse,
  extractJson,
} from '../src/ai/action-parser.js';

describe('extractJson', () => {
  it('returns a bare JSON object unchanged', () => {
    const json = '{"actions":[],"reasoning":"none"}';
    expect(extractJson(json)).toBe(json);
  });

  it('strips markdown ```json code fences', () => {
    const raw = '```json\n{"actions":[]}\n```';
    expect(extractJson(raw)).toBe('{"actions":[]}');
  });

  it('strips plain ``` code fences', () => {
    const raw = '```\n{"actions":[]}\n```';
    expect(extractJson(raw)).toBe('{"actions":[]}');
  });

  it('extracts JSON from surrounding prose', () => {
    const raw = 'Sure, here is the JSON: {"actions":[],"reasoning":"ok"} — hope that helps.';
    const result = extractJson(raw);
    expect(result).toContain('"actions"');
  });

  it('throws when no JSON found', () => {
    expect(() => extractJson('no json here at all')).toThrow('No JSON object or array found');
  });

  it('handles JSON array at top level', () => {
    const json = '[{"action":"click","description":"Click OK"}]';
    expect(extractJson(json)).toBe(json);
  });

  it('returns only the FIRST complete value when the model emits two JSON objects', () => {
    // Repro of a real gpt-5.4-mini failure: bare action object followed by the
    // wrapped { actions: [...] } form, both complete and concatenated.
    const raw = '{"action":"type","value":"x","description":"d"}\n{"actions":[{"action":"type","value":"x","description":"d"}],"reasoning":"r"}';
    const extracted = extractJson(raw);
    expect(JSON.parse(extracted)).toEqual({
      action: 'type',
      value: 'x',
      description: 'd',
    });
  });

  it('respects braces inside string literals', () => {
    const raw = '{"action":"type","value":"hello { world }","description":"d"} trailing junk';
    const extracted = extractJson(raw);
    expect(JSON.parse(extracted)).toEqual({
      action: 'type',
      value: 'hello { world }',
      description: 'd',
    });
  });
});

describe('parseAIResponse', () => {
  it('parses a valid response with actions array', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'click', description: 'Click the Sign In button', selector: '#sign-in-btn' },
      ],
      reasoning: 'The user wants to log in.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('click');
    expect(result.actions[0]?.selector).toBe('#sign-in-btn');
    expect(result.reasoning).toBe('The user wants to log in.');
  });

  it('accepts a single action object without an actions wrapper', () => {
    // Smaller models sometimes read "Return exactly ONE action per response" literally
    // and skip the actions array entirely. The parser should treat a bare action object
    // as a one-element list rather than failing.
    const raw = JSON.stringify({
      action: 'keyboard',
      key: 'Enter',
      description: 'Submit search',
      reasoning: 'Press Enter to run the query.',
      needs_reeval: true,
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('keyboard');
    expect(result.actions[0]?.key).toBe('Enter');
    expect(result.needs_reeval).toBe(true);
  });

  it('parses a type action with value', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'type', description: 'Type email', selector: '#email', value: 'user@example.com' },
      ],
      reasoning: 'Filling form.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.action).toBe('type');
    expect(result.actions[0]?.value).toBe('user@example.com');
  });

  it('parses a navigate action with url', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'navigate', description: 'Go to dashboard', url: '/dashboard' },
      ],
      reasoning: 'Navigating.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.action).toBe('navigate');
    expect(result.actions[0]?.url).toBe('/dashboard');
  });

  it('parses multiple actions', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'click', description: 'Click email field', selector: '#email' },
        { action: 'type', description: 'Type email', selector: '#email', value: 'test@test.com' },
        { action: 'click', description: 'Submit', selector: '#submit' },
      ],
      reasoning: 'Fill and submit form.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(3);
  });

  it('accepts a bare actions array', () => {
    const raw = JSON.stringify([
      { action: 'click', description: 'Click button' },
    ]);
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(1);
    expect(result.reasoning).toBe('No reasoning provided');
  });

  it('parses response wrapped in markdown code fence', () => {
    const raw = '```json\n' + JSON.stringify({
      actions: [{ action: 'hover', description: 'Hover menu' }],
      reasoning: 'Hover first.',
    }) + '\n```';
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.action).toBe('hover');
  });

  it('fills in default description when missing', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'click' }],
      reasoning: 'done',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.description).toBe('click action');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseAIResponse('not json at all ><')).toThrow();
  });

  it('throws when actions field is missing', () => {
    const raw = JSON.stringify({ reasoning: 'hmm', data: 42 });
    expect(() => parseAIResponse(raw)).toThrow('"actions" array');
  });

  it('parses scroll action with direction and amount', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'scroll', description: 'Scroll down', direction: 'down', amount: 300 },
      ],
      reasoning: 'Need to scroll.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.direction).toBe('down');
    expect(result.actions[0]?.amount).toBe(300);
  });

  it('passes an absolute scroll target through for both valid values', () => {
    for (const to of ['top', 'bottom'] as const) {
      const raw = JSON.stringify({
        actions: [{ action: 'scroll', description: `Scroll to the ${to}`, to }],
        reasoning: 'Absolute scroll.',
      });
      expect(parseAIResponse(raw).actions[0]?.to).toBe(to);
    }
  });

  it('drops an unrecognised scroll target without failing the action', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'scroll', description: 'Scroll to the middle', to: 'middle' }],
      reasoning: 'Invented target.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.to).toBeUndefined();
    // The action itself survives — it just falls through to its other fields.
    expect(result.actions[0]?.action).toBe('scroll');
  });

  it('keeps both "to" and "direction" when the AI sends them together', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'scroll',
          description: 'Scroll down to the bottom',
          to: 'bottom',
          direction: 'down',
          amount: 500,
        },
      ],
      reasoning: 'Redundant, not contradictory.',
    });
    const action = parseAIResponse(raw).actions[0]!;
    expect(action.to).toBe('bottom');
    expect(action.direction).toBe('down');
    expect(action.amount).toBe(500);
  });

  it('parses assert action with expected field', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'assert',
          description: 'Check balance',
          condition: 'visible balance text',
          expected: '$1,234.56',
        },
      ],
      reasoning: 'Verifying.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.action).toBe('assert');
    expect(result.actions[0]?.expected).toBe('$1,234.56');
  });

  // "Verify the Reference cell in row 2 … is empty" — the correct expectation
  // is the empty string, and a `.trim()` test on it rejected the model at the
  // parser exactly when it answered right, before any page was read. An empty
  // cell is a legitimate thing to assert (SPEC-structured-table-reads.md §8.3).
  it('accepts an empty-string "expected" in dom mode', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'assert',
          against: 'dom',
          description: 'Reference cell in row 2 is empty',
          condition: 'text of the Reference cell in row 2 of the Scheduled payments table',
          expected: '',
        },
      ],
      reasoning: 'The cell should hold nothing.',
    });
    const action = parseAIResponse(raw).actions[0]!;
    // Present and empty, not absent: "" has to reach the evaluator, since it
    // is what the DOM value is compared against.
    expect(action.expected).toBe('');
    expect(action.against).toBe('dom');
  });

  it('still rejects an assert whose "expected" is missing entirely', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'assert', description: 'Balance check', condition: 'visible balance text' },
      ],
      reasoning: '',
    });
    expect(() => parseAIResponse(raw)).toThrow(/missing required "expected" field/);
  });

  it('still rejects a non-string "expected" such as null', () => {
    for (const expected of [null, 0, false, [], {}]) {
      const raw = JSON.stringify({
        actions: [
          { action: 'assert', description: 'd', condition: 'c', expected },
        ],
        reasoning: '',
      });
      expect(() => parseAIResponse(raw), JSON.stringify(expected))
        .toThrow(/missing required "expected" field/);
    }
  });

  it('parses keyboard action with key', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'keyboard', description: 'Press Enter', key: 'Enter' },
      ],
      reasoning: 'Submit via keyboard.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.key).toBe('Enter');
  });

  it('normalises "press" alias to keyboard', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'press', description: 'Press Escape', key: 'Escape' },
      ],
      reasoning: 'Dismiss dialog.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.action).toBe('keyboard');
    expect(result.actions[0]?.key).toBe('Escape');
  });
});


// ─── Exploration action types (find/expand) ─────────────────────────────────

describe('parseAIResponse — find action', () => {
  it('parses a find action with value', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'find', value: 'ORD-789', description: 'Search for order ORD-789' }],
      reasoning: 'Need to locate the order row.',
      needs_reeval: true,
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('find');
    expect(result.actions[0]?.value).toBe('ORD-789');
    expect(result.needs_reeval).toBe(true);
  });
});

describe('parseAIResponse — expand action', () => {
  it('parses an expand action with selector', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'expand', selector: 'table[data-testid="orders"]', description: 'Expand the orders table' }],
      reasoning: 'Need to see all rows.',
      needs_reeval: true,
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('expand');
    expect(result.actions[0]?.selector).toBe('table[data-testid="orders"]');
    expect(result.needs_reeval).toBe(true);
  });
});

describe('parseAIResponse — wait timeout hint (issue 022)', () => {
  it('preserves a numeric timeout on a wait action', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'wait', waitType: 'url', condition: '**/newurl', timeout: 90000, description: 'Wait up to 90s for /newurl' }],
      reasoning: 'Slow navigation.',
      needs_reeval: false,
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.action).toBe('wait');
    expect(result.actions[0]?.timeout).toBe(90000);
  });

  it('drops a non-numeric timeout (e.g. a string)', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'wait', waitType: 'url', condition: '**/x', timeout: '90s', description: 'bad timeout' }],
      reasoning: 'r',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.timeout).toBeUndefined();
  });

  it('preserves the AI\'s explicit waitType (was silently dropped — issue 022)', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'wait', waitType: 'text', condition: 'Ready now', timeout: 50000, description: 'wait for text' }],
      reasoning: 'r',
      needs_reeval: false,
    });
    const result = parseAIResponse(raw);
    // Without this, executeWait falls back to inferWaitType(condition) and can
    // misclassify the wait (e.g. a text condition read as a selector/URL).
    expect(result.actions[0]?.waitType).toBe('text');
    expect(result.actions[0]?.condition).toBe('Ready now');
    expect(result.actions[0]?.timeout).toBe(50000);
  });

  it('drops an unknown waitType value rather than passing it through', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'wait', waitType: 'telepathy', condition: 'x', description: 'bogus' }],
      reasoning: 'r',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.waitType).toBeUndefined();
  });
});

describe('parseAIResponse — upload action (stories/upload-action.md §2)', () => {
  // A model copying a Windows path out of the step emits INVALID JSON: \a is
  // not an escape sequence, so the whole response is rejected and the turn is
  // lost. This is the single most likely first failure a user meets, which is
  // why the parser repairs it rather than relying on the prompt alone.
  it('repairs unescaped backslashes inside a filePath', () => {
    const raw = '{"actions":[{"action":"upload","selector":"#f","filePath":"'
      + '\\attachments\\logo.png","description":"d"}]}';
    const result = parseAIResponse(raw);
    expect(result.actions[0]!.filePath).toBe('attachments/logo.png');
  });

  // The repair is TRIED scoped-first on purpose: when only the path is broken,
  // a regex elsewhere in the same response must come through untouched.
  it('repairs the path without touching a valid escape elsewhere', () => {
    const raw = '{"actions":[{"action":"upload","selector":"#f","filePath":"'
      + '\\attachments\\logo.png","pattern":"(\\\\d{4})","description":"d"}]}';
    const action = parseAIResponse(raw).actions[0]!;
    expect(action.filePath).toBe('attachments/logo.png');
    // The regex survived: the scoped repair rewrote only the path value.
    expect(action.pattern).toBe('(\\d{4})');
  });

  // When the scoped repair is not enough — a model that echoed the path into
  // `description` too — the parser widens rather than losing the whole turn.
  // The trade-off was decided in stories/upload-action.md: the response is
  // already unparseable, so a broad repair can only improve on throwing it away.
  it('widens the repair when the path fix alone does not parse', () => {
    const raw = '{"actions":[{"action":"upload","selector":"#f","filePath":"'
      + '\\attachments\\logo.png","description":"Upload \\attachments\\logo.png"}]}';
    const action = parseAIResponse(raw).actions[0]!;
    expect(action.filePath).toBe('attachments/logo.png');
    expect(action.description).toBe('Upload /attachments/logo.png');
  });
  it('still refuses JSON that no escape repair can rescue', () => {
    expect(() => parseAIResponse('{"actions":[{"action":"upload",')).toThrow();
  });
  it('leaves a correctly escaped pattern alone', () => {
    const raw = '{"actions":[{"action":"read","selector":"#a","pattern":"('
      + '\\\\d{4})","as":"x","description":"d"}]}';
    expect(parseAIResponse(raw).actions[0]!.pattern).toBe('(\\d{4})');
  });

  it('normalises a path to relative, forward-slashed form', () => {
    const result = parseAIResponse(
      '{"actions":[{"action":"upload","selector":"#f","filePath":"/attachments/logo.png","description":"d"}]}',
    );
    expect(result.actions[0]!.filePath).toBe('attachments/logo.png');
  });

  it('parses filePaths as an array, dropping blanks and non-strings', () => {
    const result = parseAIResponse(
      '{"actions":[{"action":"upload","selector":"#f","filePaths":["a.png","",2,"b.png"],"description":"d"}]}',
    );
    expect(result.actions[0]!.filePaths).toEqual(['a.png', 'b.png']);
  });

  // The model will put a single path under the plural key. Dropping it would
  // cost a turn for a shape whose meaning is obvious.
  it('reads a lone string under the plural key as filePath', () => {
    const result = parseAIResponse(
      '{"actions":[{"action":"upload","selector":"#f","filePaths":"attachments/x.png","description":"d"}]}',
    );
    expect(result.actions[0]!.filePath).toBe('attachments/x.png');
    expect(result.actions[0]!.filePaths).toBeUndefined();
  });

  it('keeps filePaths and drops filePath when both are present', () => {
    const result = parseAIResponse(
      '{"actions":[{"action":"upload","selector":"#f","filePath":"a.png","filePaths":["b.png"],"description":"d"}]}',
    );
    expect(result.actions[0]!.filePaths).toEqual(['b.png']);
    expect(result.actions[0]!.filePath).toBeUndefined();
  });

  it('normalises the aliases a model reaches for', () => {
    for (const alias of ['attach', 'attach_file', 'file_upload', 'setInputFiles']) {
      const result = parseAIResponse(
        `{"actions":[{"action":"${alias}","selector":"#f","filePath":"a.png","description":"d"}]}`,
      );
      expect(result.actions[0]!.action, alias).toBe('upload');
    }
  });

  it('leaves a {{param}} placeholder intact for the executor to interpolate', () => {
    const result = parseAIResponse(
      '{"actions":[{"action":"upload","selector":"#f","filePath":"{{statement}}","description":"d"}]}',
    );
    expect(result.actions[0]!.filePath).toBe('{{statement}}');
  });
});

/**
 * readTable parsing (docs/specs/SPEC-structured-table-reads.md §6.2).
 *
 * Every case here rejects the WHOLE action rather than dropping a column and
 * running a partial read — a record missing a field the next step names is a
 * convincing lie, and worse than a step that failed and said why.
 */
describe('parseAIResponse — readTable', () => {
  /** One valid action, with `patch` merged over it. */
  function readTable(patch: Record<string, unknown> = {}): string {
    return JSON.stringify({
      actions: [
        {
          action: 'readTable',
          selector: 'table[aria-label="Orders"]',
          columns: [
            { header: 'Order ID', key: 'id' },
            { header: 'Customer', key: 'customer' },
          ],
          as: 'orders',
          description: 'Read the Orders table',
          ...patch,
        },
      ],
      reasoning: '',
    });
  }

  it('parses the canonical header-named action with its columns in order', () => {
    const action = parseAIResponse(readTable()).actions[0]!;
    expect(action.action).toBe('readTable');
    expect(action.selector).toBe('table[aria-label="Orders"]');
    expect(action.as).toBe('orders');
    expect(action.columns).toEqual([
      { header: 'Order ID', key: 'id' },
      { header: 'Customer', key: 'customer' },
    ]);
    expect(action.limit).toBeUndefined();
  });

  it('keeps positional and mixed columns exactly as written, with an explicit limit', () => {
    const action = parseAIResponse(readTable({
      columns: [
        { index: 1, key: 'payee' },
        { header: 'Status', key: 'status', mode: 'text' },
        { index: 5, key: 'amount' },
      ],
      limit: 10,
    })).actions[0]!;
    // Never an index turned into a header or back: the runtime resolves each
    // the way the author wrote it (§4.4).
    expect(action.columns).toEqual([
      { index: 1, key: 'payee' },
      { header: 'Status', key: 'status', mode: 'text' },
      { index: 5, key: 'amount' },
    ]);
    expect(action.limit).toBe(10);
  });

  it('rejects a missing or blank selector', () => {
    expect(() => parseAIResponse(readTable({ selector: undefined })))
      .toThrow(/missing required "selector" field/);
    expect(() => parseAIResponse(readTable({ selector: '   ' })))
      .toThrow(/missing required "selector" field/);
  });

  it('rejects a missing or invalid "as" name', () => {
    expect(() => parseAIResponse(readTable({ as: undefined })))
      .toThrow(/missing required "as" field/);
    expect(() => parseAIResponse(readTable({ as: '2orders' })))
      .toThrow(/invalid "as" name "2orders"/);
  });

  it('rejects absent, non-array and empty columns', () => {
    expect(() => parseAIResponse(readTable({ columns: undefined })))
      .toThrow(/missing required "columns" array/);
    expect(() => parseAIResponse(readTable({ columns: 'Order ID' })))
      .toThrow(/missing required "columns" array/);
    expect(() => parseAIResponse(readTable({ columns: [] })))
      .toThrow(/empty "columns" array/);
  });

  it('rejects a column that is not an object', () => {
    expect(() => parseAIResponse(readTable({ columns: ['Order ID'] })))
      .toThrow(/column 1 is not an object/);
    expect(() => parseAIResponse(readTable({ columns: [{ header: 'A', key: 'a' }, null] })))
      .toThrow(/column 2 is not an object/);
  });

  it('rejects a column with both header and index, or with neither', () => {
    expect(() => parseAIResponse(readTable({ columns: [{ header: 'Status', index: 5, key: 's' }] })))
      .toThrow(/column 1 has both "header" and "index"/);
    expect(() => parseAIResponse(readTable({ columns: [{ key: 's' }] })))
      .toThrow(/column 1 has neither "header" nor "index"/);
  });

  it('rejects a blank header', () => {
    expect(() => parseAIResponse(readTable({ columns: [{ header: '  ', key: 's' }] })))
      .toThrow(/column 1 has a blank "header"/);
  });

  it('rejects every non-integer, out-of-range or coercible index', () => {
    for (const index of [0, -1, 1.5, '1', 101, null]) {
      expect(() => parseAIResponse(readTable({ columns: [{ index, key: 'x' }] })), String(index))
        .toThrow(index === null ? /neither "header" nor "index"/ : /invalid "index"/);
    }
  });

  it('rejects an invalid, dangerous, duplicated or reserved key', () => {
    expect(() => parseAIResponse(readTable({ columns: [{ header: 'A', key: '2nd' }] })))
      .toThrow(/column 1 has an invalid "key" "2nd"/);
    expect(() => parseAIResponse(readTable({ columns: [{ header: 'A', key: 'a b' }] })))
      .toThrow(/invalid "key"/);
    expect(() => parseAIResponse(readTable({ columns: [{ header: 'A' }] })))
      .toThrow(/invalid "key"/);
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      expect(() => parseAIResponse(readTable({ columns: [{ header: 'A', key }] })), key)
        .toThrow(new RegExp(`reserved key "${key}"`));
    }
    expect(() => parseAIResponse(readTable({
      columns: [{ header: 'A', key: 'a' }, { header: 'B', key: 'a' }],
    }))).toThrow(/column 2 repeats the key "a"/);
  });

  it('rejects the reserved alias _row', () => {
    expect(() => parseAIResponse(readTable({ columns: [{ header: 'Row', key: '_row' }] })))
      .toThrow(/reserved key "_row" — the runtime writes the row number/);
  });

  // §6.2 lists a duplicated (header, key) / (index, key) pair separately; key
  // uniqueness already settles it, since a repeated pair repeats its key.
  it('rejects a duplicated (header, key) or (index, key) pair', () => {
    expect(() => parseAIResponse(readTable({
      columns: [{ header: 'Status', key: 'status' }, { header: 'Status', key: 'status' }],
    }))).toThrow(/column 2 repeats the key "status"/);
    expect(() => parseAIResponse(readTable({
      columns: [{ index: 3, key: 'amount' }, { index: 3, key: 'amount' }],
    }))).toThrow(/column 2 repeats the key "amount"/);
  });

  it('refuses a phase-2 mode by name', () => {
    for (const mode of ['checked', 'value', 'attribute']) {
      expect(() => parseAIResponse(readTable({ columns: [{ header: 'Auto-pay', key: 'autopay', mode }] })), mode)
        .toThrow(/which is phase 2 — phase 1 reads rendered text only/);
    }
  });

  it('rejects more than 20 columns', () => {
    const columns = Array.from({ length: 21 }, (_, i) => ({ header: `H${i}`, key: `k${i}` }));
    expect(() => parseAIResponse(readTable({ columns })))
      .toThrow(/requests 21 columns — the maximum is 20/);
    const twenty = columns.slice(0, 20);
    expect(parseAIResponse(readTable({ columns: twenty })).actions[0]!.columns).toHaveLength(20);
  });

  it('rejects every invalid limit without coercing or clamping it', () => {
    for (const limit of [0, -1, 2.5, '10', 501]) {
      expect(() => parseAIResponse(readTable({ limit })), String(limit))
        .toThrow(/invalid "limit"/);
    }
    expect(parseAIResponse(readTable({ limit: 500 })).actions[0]!.limit).toBe(500);
    expect(parseAIResponse(readTable({ limit: 1 })).actions[0]!.limit).toBe(1);
  });

  it('leaves a {{param}} placeholder in a header for the executor to interpolate', () => {
    const action = parseAIResponse(readTable({
      columns: [{ header: '{{status_column}}', key: 'status' }],
    })).actions[0]!;
    expect(action.columns?.[0]?.header).toBe('{{status_column}}');
  });
});
