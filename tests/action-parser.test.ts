import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseAIResponse,
  extractJson,
  resetEmittedMappingWarning,
} from '../src/ai/action-parser.js';
import { logger } from '../src/utils/logger.js';

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
    expect(extractJson(raw)).toBe('{"actions":[],"reasoning":"ok"}');
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
    expect(result.reevalUnstated).toBeUndefined();
  });

  // A bare action that says nothing about needs_reeval has not said the step
  // is done; the executor decides what to do about that (multi-turn.test.ts).
  it('flags a bare action object that leaves needs_reeval unstated', () => {
    const raw = JSON.stringify({
      action: 'upload',
      selector: '#statement-file',
      filePath: '/attachments/statement.pdf',
      description: 'Upload statement.pdf as the statement',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.action).toBe('upload');
    expect(result.needs_reeval).toBeUndefined();
    expect(result.reevalUnstated).toBe(true);
  });

  it.each([true, false])('does not flag a bare action object that sets needs_reeval: %s', (value) => {
    const raw = JSON.stringify({ action: 'click', selector: '#upload', description: 'Click Upload', needs_reeval: value });
    expect(parseAIResponse(raw).reevalUnstated).toBeUndefined();
  });

  it('flags a bare action whose needs_reeval is not a boolean', () => {
    const raw = JSON.stringify({ action: 'click', selector: '#upload', description: 'Click Upload', needs_reeval: 'false' });
    expect(parseAIResponse(raw).reevalUnstated).toBe(true);
  });

  // A bare array skipped the wrapper too, and has no place for the field.
  it('flags a bare array, which cannot carry needs_reeval', () => {
    const raw = JSON.stringify([{ action: 'click', selector: '#b', description: 'Click' }]);
    expect(parseAIResponse(raw).reevalUnstated).toBe(true);
  });

  // Rule 15 lets the wrapper omit needs_reeval to mean "done".
  it('does not flag a wrapped response that omits needs_reeval', () => {
    const raw = JSON.stringify({ actions: [{ action: 'click', selector: '#b', description: 'Click' }], reasoning: 'r' });
    expect(parseAIResponse(raw).reevalUnstated).toBeUndefined();
  });

  // Every field parseAction copies as it comes, one row each: a field the copy
  // does not name never reaches the executor, which then fails for want of
  // what the model DID send (a drag's target was lost that way). Fields with
  // rules of their own — direction, to, waitType, filePath(s), a drag's
  // target, the browser label, a table read's — have their own tests.
  it.each([
    ['click', 'selector', '#sign-in-btn'],
    ['type', 'value', 'user@example.com'],
    ['navigate', 'url', '/dashboard'],
    ['wait', 'condition', '#ready'],
    ['keyboard', 'key', 'Enter'],
    ['prompt', 'question', 'Which account should be used?'],
    ['scroll', 'amount', 300],
    ['wait', 'timeout', 90_000],
    ['api_call', 'method', 'POST'],
    ['api_call', 'body', { name: 'Ada' }],
    ['api_call', 'path', '/api/accounts'],
    ['api_call', 'apiMode', 'standalone'],
    ['api_call', 'apiHeaders', { 'X-Token': 'abc' }],
    ['extract_csrf', 'source', 'meta[name=csrf-token]'],
    ['read', 'as', 'balance'],
    ['read', 'attribute', 'href'],
    ['read', 'multiple', true],
    ['read', 'pattern', '(\\d{4})'],
    ['click', 'frame', '#payment'],
    ['switchPage', 'page', 'page:2'],
    ['openBrowser', 'engine', 'firefox'],
    ['openBrowser', 'channel', 'msedge'],
    ['openBrowser', 'headed', false],
  ] as const)('keeps a %s action\'s %s', (action, field, value) => {
    const label = action === 'openBrowser' ? { as: 'second' } : {};
    const raw = JSON.stringify({ actions: [{ action, description: 'd', ...label, [field]: value }], reasoning: 'r' });
    const parsed = parseAIResponse(raw).actions[0]!;
    expect(parsed.action).toBe(action);
    expect((parsed as unknown as Record<string, unknown>)[field]).toEqual(value);
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

  it('parses an assert with description, condition and expected', () => {
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
    expect(parseAIResponse(raw).actions[0]).toEqual({
      action: 'assert',
      description: 'Check balance',
      condition: 'visible balance text',
      expected: '$1,234.56',
    });
  });

  it('keeps an assert\'s poll config', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'assert',
          description: 'Toast eventually shows Saved',
          condition: 'toast text',
          expected: 'Saved',
          poll: { timeoutMs: 3000, intervalMs: 200 },
        },
      ],
      reasoning: 'polling assert',
    });
    expect(parseAIResponse(raw).actions[0]!.poll).toEqual({ timeoutMs: 3000, intervalMs: 200 });
  });

  it('keeps an assert\'s against mode', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'assert',
          description: 'API status is 200',
          condition: 'last api response status',
          expected: '200',
          against: 'api',
        },
      ],
      reasoning: 'api assert',
    });
    expect(parseAIResponse(raw).actions[0]!.against).toBe('api');
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

});

// Aliases ("press", "attach", "refresh", "open_tab"…) are pinned in
// unknown-action-type.test.ts: the spellings a model reaches for by hand, and
// that every entry of ACTION_TYPE_ALIASES folds to its own target.

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
    expect(result.actions[0]!.filePath).toBe('/attachments/logo.png');
  });

  // The repair is TRIED scoped-first on purpose: when only the path is broken,
  // a regex elsewhere in the same response must come through untouched.
  it('repairs the path without touching a valid escape elsewhere', () => {
    const raw = '{"actions":[{"action":"upload","selector":"#f","filePath":"'
      + '\\attachments\\logo.png","pattern":"(\\\\d{4})","description":"d"}]}';
    const action = parseAIResponse(raw).actions[0]!;
    expect(action.filePath).toBe('/attachments/logo.png');
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
    expect(action.filePath).toBe('/attachments/logo.png');
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

  it('keeps a rooted path rooted, for the resolver to read test-relative first', () => {
    const result = parseAIResponse(
      '{"actions":[{"action":"upload","selector":"#f","filePath":"/attachments/logo.png","description":"d"}]}',
    );
    expect(result.actions[0]!.filePath).toBe('/attachments/logo.png');
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
        .toThrow(/invalid "index"/);
    }
  });

  // "Present" means present-and-not-undefined: `null` is a value the model
  // wrote, not a field it left out. Read as absent, `"limit": null` ran an
  // unbounded read of a step that asked for a bounded one, `"mode": null` was
  // a phase-2 request waved through, and `"index": null` was a column naming
  // nothing — each of which produces a plausible wrong answer rather than a
  // refusal. All three refuse the same way now.
  it('rejects a null header, index, limit or mode rather than treating it as absent', () => {
    expect(() => parseAIResponse(readTable({ columns: [{ index: null, key: 'x' }] })))
      .toThrow(/column 1 has an invalid "index" null/);
    expect(() => parseAIResponse(readTable({ columns: [{ header: null, key: 'x' }] })))
      .toThrow(/column 1 has a blank "header" null/);
    // A null beside a real one is still the self-contradiction of naming both.
    expect(() => parseAIResponse(readTable({ columns: [{ header: 'Status', index: null, key: 's' }] })))
      .toThrow(/column 1 has both "header" and "index"/);
    expect(() => parseAIResponse(readTable({ limit: null })))
      .toThrow(/has an invalid "limit" null/);
    expect(() => parseAIResponse(readTable({ columns: [{ header: 'A', key: 'a', mode: null }] })))
      .toThrow(/uses mode null/);
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

/**
 * `mapping` is runtime-owned (docs/specs/SPEC-structured-table-reads.md
 * §6.1 / §7.10).
 *
 * The parser copies known fields one at a time, so an unknown one is already
 * dropped — and that is exactly why this needs a test. Nothing here fails if
 * someone later adds `if (obj['mapping']) action.mapping = …` to the list
 * beside `columns` and `limit`, which reads like the obvious omission it is
 * not: a mapping the model emitted has been validated against nothing, and
 * copied through it would pin the read to a table the model believes is there
 * and then be recorded on the step's transcript — the compile's input — as if
 * it had been proved.
 */
describe('parseAIResponse — mapping is never taken from the model', () => {
  beforeEach(() => { resetEmittedMappingWarning(); });

  function withMapping(mapping: unknown, actionType = 'readTable'): string {
    return JSON.stringify({
      actions: [
        {
          action: actionType,
          selector: '#legacy-payees',
          columns: [{ header: 'Payee', key: 'payee' }],
          as: 'payees',
          description: 'Read the payees table',
          mapping,
        },
      ],
      reasoning: '',
    });
  }

  it('strips a table mapping from a readTable the model emitted', () => {
    const action = parseAIResponse(
      withMapping({ kind: 'table', rows: '#legacy-payees', header: { selector: '#legacy-payees', bodyRow: 1 } }),
    ).actions[0]!;
    expect(action.action).toBe('readTable');
    // The rest of the action still parses — stripping one field is not a
    // rejection, because a plan is not wrong for carrying a field the model
    // was never shown.
    expect(action.columns).toEqual([{ header: 'Payee', key: 'payee' }]);
    expect((action as Record<string, unknown>)['mapping']).toBeUndefined();
  });

  it('strips a collection mapping too', () => {
    const action = parseAIResponse(
      withMapping({ kind: 'collection', item: '.account-card', fields: { balance: '.value' } }),
    ).actions[0]!;
    expect((action as Record<string, unknown>)['mapping']).toBeUndefined();
  });

  it('strips it from any action type, not just readTable', () => {
    const action = parseAIResponse(withMapping({ kind: 'table', rows: '#x' }, 'click')).actions[0]!;
    expect(action.action).toBe('click');
    expect((action as Record<string, unknown>)['mapping']).toBeUndefined();
  });

  it('warns once per process, not once per action', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      parseAIResponse(withMapping({ kind: 'table', rows: '#a' }));
      parseAIResponse(withMapping({ kind: 'table', rows: '#b' }));
      const mappingWarnings = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('"mapping"'));
      expect(mappingWarnings).toHaveLength(1);
      expect(mappingWarnings[0]).toContain('written by the runtime');
    } finally {
      warn.mockRestore();
    }
  });
});
