/**
 * The computer-mode action parser
 * (docs/specs/SPEC-use-computer.md §5.4; acceptance §13.1, and §13 item 4:
 * "Page actions in computer mode are refused with a message; unknown action
 * types are refused, not run as no-ops").
 *
 * The refusal table is the important half. On the page surface an unrecognised
 * action is kept with a WARN and executed as a no-op that reports success —
 * the defect SPEC-browser-history §4.1 was written to close. Here the
 * alternative to doing nothing is a real click at a real coordinate, so every
 * refusal below is asserting that something did NOT become an action, and that
 * the model was told why in words it can act on.
 */
import { describe, it, expect } from 'vitest';
import { parseComputerActions } from '../src/desktop/action-parser.js';
import { COMPUTER_ACTION_TYPES } from '../src/desktop/actions.js';

/** One action, built by the parser. Fails loudly if it was refused instead. */
function one(json: string) {
  const parsed = parseComputerActions(json);
  expect(parsed.refused).toEqual([]);
  expect(parsed.actions).toHaveLength(1);
  return parsed.actions[0]!;
}

/** The refusal reason for a single action, or `undefined` if it was accepted. */
function refusal(json: string): string | undefined {
  const parsed = parseComputerActions(json);
  if (parsed.refused.length === 0) return undefined;
  return parsed.refused[0]!.reason;
}

describe('parseComputerActions — every §5.4 action', () => {
  it('click, with its defaults', () => {
    expect(one('{"action":"click","x":812,"y":544,"description":"Cancel"}')).toMatchObject({
      action: 'click',
      x: 812,
      y: 544,
      button: 'left',
      count: 1,
      description: 'Cancel',
    });
  });

  it('click, with an explicit button and count', () => {
    expect(one('{"action":"click","x":1,"y":2,"button":"right","count":2}')).toMatchObject({
      action: 'click',
      button: 'right',
      count: 2,
    });
  });

  it('drag', () => {
    expect(
      one('{"action":"drag","from":{"x":10,"y":20},"to":{"x":30,"y":40}}'),
    ).toMatchObject({ action: 'drag', from: { x: 10, y: 20 }, to: { x: 30, y: 40 } });
  });

  it('move', () => {
    expect(one('{"action":"move","x":5,"y":6}')).toMatchObject({ action: 'move', x: 5, y: 6 });
  });

  it('scroll, defaulting to 3 ticks (§5.4)', () => {
    expect(one('{"action":"scroll","x":7,"y":8,"direction":"down"}')).toMatchObject({
      action: 'scroll',
      direction: 'down',
      amount: 3,
    });
  });

  it('type', () => {
    expect(one('{"action":"type","text":"statement.pdf"}')).toMatchObject({
      action: 'type',
      text: 'statement.pdf',
    });
  });

  it('key', () => {
    expect(one('{"action":"key","key":"ctrl+s"}')).toMatchObject({ action: 'key', key: 'ctrl+s' });
  });

  it('wait', () => {
    expect(one('{"action":"wait","seconds":2}')).toMatchObject({ action: 'wait', seconds: 2 });
  });

  it('zoom', () => {
    expect(
      one('{"action":"zoom","region":{"x":900,"y":400,"width":420,"height":180}}'),
    ).toMatchObject({ action: 'zoom', region: { x: 900, y: 400, width: 420, height: 180 } });
  });

  it('focus_window', () => {
    expect(one('{"action":"focus_window","title":"Save As"}')).toMatchObject({
      action: 'focus_window',
      title: 'Save As',
    });
  });

  it('wait_window, defaulting to 15000ms (§5.4)', () => {
    expect(one('{"action":"wait_window","title":"Print","state":"open"}')).toMatchObject({
      action: 'wait_window',
      title: 'Print',
      state: 'open',
      timeoutMs: 15_000,
    });
  });

  it('wait_window clamps a timeout over 30 s, and remembers what was asked (A5)', () => {
    const action = one('{"action":"wait_window","title":"Print","state":"open","timeoutMs":120000}');
    expect(action).toMatchObject({ timeoutMs: 30_000, requestedTimeoutMs: 120_000 });
  });

  it('wait_window keeps a timeout within the cap as asked', () => {
    const action = one('{"action":"wait_window","title":"Print","state":"open","timeoutMs":30000}');
    expect(action).toMatchObject({ timeoutMs: 30_000 });
    expect(action).not.toHaveProperty('requestedTimeoutMs');
  });

  it('read', () => {
    expect(one('{"action":"read","as":"file_name","value":"statement.pdf"}')).toMatchObject({
      action: 'read',
      as: 'file_name',
      value: 'statement.pdf',
    });
  });

  it('assert', () => {
    expect(
      one('{"action":"assert","condition":"the dialog closed","holds":false,"evidence":"still open"}'),
    ).toMatchObject({ action: 'assert', holds: false, evidence: 'still open' });
  });

  it('noop', () => {
    expect(one('{"action":"noop","description":"already done"}')).toMatchObject({ action: 'noop' });
  });

  it('prompt', () => {
    expect(one('{"action":"prompt","question":"Which printer?"}')).toMatchObject({
      action: 'prompt',
      question: 'Which printer?',
    });
  });

  it('return', () => {
    expect(one('{"action":"return","description":"condition holds"}')).toMatchObject({
      action: 'return',
    });
  });

  it('fail, carrying the message', () => {
    expect(one('{"action":"fail","message":"did not save"}')).toMatchObject({
      action: 'fail',
      message: 'did not save',
    });
  });

  it('api_call keeps the model\'s own object for the run loop', () => {
    const action = one('{"action":"api_call","method":"GET","url":"/api/documents"}');
    expect(action.action).toBe('api_call');
    expect(action.raw).toMatchObject({ method: 'GET', url: '/api/documents' });
  });

  it('extract_value keeps the model\'s own object too', () => {
    const action = one('{"action":"extract_value","source":"last","path":"data.0.id","as":"id"}');
    expect(action.action).toBe('extract_value');
    expect(action.raw).toMatchObject({ path: 'data.0.id', as: 'id' });
  });

  it('covers every name in the vocabulary — the table above is complete', () => {
    // A new action added to §5.4 without a case here fails this, which is the
    // only thing that stops the table silently going out of date.
    const covered = new Set<string>();
    for (const json of [
      '{"action":"click","x":1,"y":1}',
      '{"action":"drag","from":{"x":1,"y":1},"to":{"x":2,"y":2}}',
      '{"action":"move","x":1,"y":1}',
      '{"action":"scroll","x":1,"y":1,"direction":"up"}',
      '{"action":"type","text":"x"}',
      '{"action":"key","key":"enter"}',
      '{"action":"wait","seconds":1}',
      '{"action":"zoom","region":{"x":0,"y":0,"width":2,"height":2}}',
      '{"action":"focus_window","title":"a"}',
      '{"action":"wait_window","title":"a","state":"gone"}',
      '{"action":"read","as":"a","value":"b"}',
      '{"action":"assert","condition":"a","holds":true}',
      '{"action":"noop"}',
      '{"action":"prompt","question":"a"}',
      '{"action":"return"}',
      '{"action":"fail"}',
      '{"action":"api_call"}',
      '{"action":"extract_value"}',
    ]) {
      covered.add(one(json).action);
    }
    expect([...covered].sort()).toEqual([...COMPUTER_ACTION_TYPES].sort());
  });
});

describe('parseComputerActions — aliases (§5.4)', () => {
  it('keyboard and keypress are key', () => {
    expect(one('{"action":"keyboard","key":"enter"}')).toMatchObject({ action: 'key' });
    expect(one('{"action":"keypress","key":"escape"}')).toMatchObject({ action: 'key' });
  });

  it('double_click is a click with count 2', () => {
    expect(one('{"action":"double_click","x":3,"y":4}')).toMatchObject({
      action: 'click',
      count: 2,
      button: 'left',
    });
  });

  it('right_click is a click with button right', () => {
    expect(one('{"action":"right_click","x":3,"y":4}')).toMatchObject({
      action: 'click',
      button: 'right',
      count: 1,
    });
  });

  it('left_click is a plain click', () => {
    expect(one('{"action":"left_click","x":3,"y":4}')).toMatchObject({
      action: 'click',
      button: 'left',
      count: 1,
    });
  });

  it('mouse_move is move', () => {
    expect(one('{"action":"mouse_move","x":3,"y":4}')).toMatchObject({ action: 'move' });
  });

  it.each(['screenshot', 'take_screenshot', 'captureScreen'])(
    '"%s" is refused, never a noop — a noop would pass the step (A1)',
    (name) => {
      const parsed = parseComputerActions(`{"action":"${name}"}`);
      expect(parsed.actions).toEqual([]);
      expect(parsed.refused[0]!.reason).toContain('There is no screenshot action');
      expect(parsed.refused[0]!.reason).toContain('every turn already carries a fresh screenshot');
    },
  );

  it('an explicit field beats the alias it came with', () => {
    // `double_click` implies count 2; a model that then says count 3 means 3.
    expect(one('{"action":"double_click","x":1,"y":1,"count":3}')).toMatchObject({ count: 3 });
  });

  it('spelling is folded: case, underscores and hyphens', () => {
    expect(one('{"action":"Focus_Window","title":"Save As"}')).toMatchObject({
      action: 'focus_window',
    });
    expect(one('{"action":"wait-window","title":"a","state":"open"}')).toMatchObject({
      action: 'wait_window',
    });
  });

  it('accepts the computer-use tools\' own coordinate shape', () => {
    // `{"coordinate": [x, y]}` is what Anthropic's and OpenAI's computer-use
    // tool definitions use, so a vision model reaches for it first.
    expect(one('{"action":"left_click","coordinate":[120,240]}')).toMatchObject({
      action: 'click',
      x: 120,
      y: 240,
    });
  });
});

describe('parseComputerActions — refusals (§5.4)', () => {
  it.each([
    'navigate', 'select', 'upload', 'hover', 'dismiss', 'switchFrame', 'switchPage',
    'closePage', 'openPage', 'openBrowser', 'switchBrowser', 'closeBrowser', 'back',
    'forward', 'find', 'expand', 'count', 'readTable', 'extract_csrf',
  ])('refuses the page action "%s"', (name) => {
    const reason = refusal(`{"action":"${name}","selector":"#x","x":1,"y":1}`);
    expect(reason).toContain(`"${name}" is a page action`);
    expect(reason).toContain('Valid actions:');
  });

  it('refuses goBack too — it is the same request in the page parser\'s own spelling', () => {
    expect(refusal('{"action":"goBack"}')).toContain('is a page action');
  });

  it('refuses an unknown type instead of keeping it as a no-op', () => {
    const parsed = parseComputerActions('{"action":"teleport","x":1,"y":1}');
    expect(parsed.actions).toEqual([]);
    expect(parsed.refused[0]!.reason).toContain('Unknown action "teleport"');
    expect(parsed.refused[0]!.reason).toContain('Valid actions:');
  });

  it('refuses a click with a selector', () => {
    expect(refusal('{"action":"click","selector":"#save","x":1,"y":1}')).toMatch(
      /targets a point on the screen, not an element/,
    );
  });

  it('refuses a type with a selector', () => {
    expect(refusal('{"action":"type","selector":"#name","text":"x"}')).toMatch(
      /types into whatever has OS focus/,
    );
  });

  it('refuses a click with no coordinates', () => {
    expect(refusal('{"action":"click","description":"the Save button"}')).toMatch(
      /needs finite, non-negative "x" and "y"/,
    );
  });

  it.each([
    ['a missing y', '{"action":"click","x":5}'],
    ['a string x', '{"action":"click","x":"5","y":5}'],
    ['a negative coordinate', '{"action":"click","x":-1,"y":5}'],
    ['a null coordinate', '{"action":"click","x":null,"y":5}'],
  ])('refuses a click with %s', (_label, json) => {
    expect(refusal(json)).toMatch(/needs finite, non-negative "x" and "y"/);
  });

  it('refuses an unknown key name, and lists the ones that work', () => {
    const reason = refusal('{"action":"key","key":"ctrl+squiggle"}');
    expect(reason).toContain('Unknown key name "squiggle"');
    expect(reason).toContain('pagedown');
  });

  it('refuses a scroll with no direction', () => {
    expect(refusal('{"action":"scroll","x":1,"y":1}')).toMatch(/needs a "direction"/);
  });

  it('refuses a zoom with no region', () => {
    expect(refusal('{"action":"zoom"}')).toMatch(/needs a "region"/);
  });

  it('refuses a zoom whose region has no area', () => {
    expect(refusal('{"action":"zoom","region":{"x":1,"y":1,"width":0,"height":5}}')).toMatch(
      /is not a rectangle inside the current image/,
    );
  });

  it('refuses a focus_window with no title', () => {
    expect(refusal('{"action":"focus_window"}')).toMatch(/needs a "title"/);
  });

  it('refuses a wait_window with no state', () => {
    expect(refusal('{"action":"wait_window","title":"Save As"}')).toMatch(/"open" or "gone"/);
  });

  it('refuses an assert with holds:false and no evidence', () => {
    // §5.4 makes `evidence` the failure's actual value; a blank one is the
    // report nobody can act on.
    expect(refusal('{"action":"assert","condition":"it closed","holds":false}')).toMatch(
      /needs "evidence"/,
    );
  });

  it('accepts an assert with holds:true and no evidence', () => {
    expect(one('{"action":"assert","condition":"it closed","holds":true}')).toMatchObject({
      holds: true,
      evidence: '',
    });
  });

  it('refuses an action with no "action" field', () => {
    // Inside the array, where the envelope has already been recognised. A
    // bare `{"x":1,"y":2}` is not an envelope at all and throws instead —
    // covered below, with the rest of the envelope.
    expect(refusal('{"actions":[{"x":1,"y":2}]}')).toMatch(/needs an "action" field/);
  });

  it('refuses an action that is not an object', () => {
    expect(refusal('{"actions":["click"]}')).toMatch(/must be a JSON object/);
  });

  it('keeps the offending object on the refusal, for the report', () => {
    const parsed = parseComputerActions('{"actions":[{"action":"hover","x":1,"y":2}]}');
    expect(parsed.refused[0]!.raw).toEqual({ action: 'hover', x: 1, y: 2 });
  });

  it('refuses only the bad one — the rest of the batch still parses', () => {
    const parsed = parseComputerActions(
      '{"actions":[{"action":"click","x":1,"y":2},{"action":"navigate","url":"/x"}]}',
    );
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.refused).toHaveLength(1);
  });
});

describe('parseComputerActions — clamps rather than refusing (§5.4)', () => {
  it('caps a wait above 10 seconds instead of spending a turn on it', () => {
    expect(one('{"action":"wait","seconds":30}')).toMatchObject({ seconds: 10 });
  });

  it('reads milliseconds as seconds when that is what the model gave', () => {
    expect(one('{"action":"wait","ms":2500}')).toMatchObject({ seconds: 2.5 });
  });

  it('refuses a wait with no duration at all', () => {
    expect(refusal('{"action":"wait"}')).toMatch(/needs a positive "seconds"/);
  });
});

describe('parseComputerActions — the envelope (mirrors the page parser)', () => {
  it('accepts the canonical { actions: [...] } form and the reasoning beside it', () => {
    const parsed = parseComputerActions(
      '{"reasoning":"The Cancel button is bottom-right.","actions":[{"action":"click","x":1,"y":2}]}',
    );
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.reasoning).toBe('The Cancel button is bottom-right.');
  });

  it('accepts a bare array', () => {
    expect(parseComputerActions('[{"action":"noop"}]').actions).toHaveLength(1);
  });

  it('accepts a single action object', () => {
    expect(parseComputerActions('{"action":"noop"}').actions).toHaveLength(1);
  });

  it('accepts a single action object under the PLURAL key', () => {
    expect(parseComputerActions('{"actions":{"action":"noop"}}').actions).toHaveLength(1);
  });

  it('strips a markdown code fence', () => {
    expect(
      parseComputerActions('```json\n{"action":"click","x":1,"y":2}\n```').actions,
    ).toHaveLength(1);
  });

  it('takes the FIRST JSON value when an indecisive model emits two', () => {
    const parsed = parseComputerActions(
      '{"action":"click","x":1,"y":2}\n{"actions":[{"action":"click","x":9,"y":9}]}',
    );
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toMatchObject({ x: 1, y: 2 });
  });

  it('ignores prose before the JSON', () => {
    expect(
      parseComputerActions('Sure — here you go:\n{"action":"noop"}').actions,
    ).toHaveLength(1);
  });

  it('defaults the reasoning when the model gave none', () => {
    expect(parseComputerActions('{"action":"noop"}').reasoning).toBe('No reasoning provided');
  });

  it('throws when the response holds no JSON at all', () => {
    expect(() => parseComputerActions('I cannot see the screen.')).toThrow(/No JSON object/);
  });

  it('throws when the JSON is malformed', () => {
    expect(() => parseComputerActions('{"action": }')).toThrow(/not valid JSON/);
  });

  it('throws when an object carries neither "action" nor "actions"', () => {
    expect(() => parseComputerActions('{"reasoning":"thinking"}')).toThrow(/"actions" array/);
  });
});
