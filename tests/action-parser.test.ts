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
