import { describe, it, expect } from 'vitest';
import { parseAIResponse } from '../src/ai/action-parser.js';

// ── Parser: structured assert action ────────────────────────────────────────

describe('parseAIResponse — assert action shape', () => {
  it('accepts an assert action with description, condition, expected', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'assert',
          description: 'Modal title equals Done',
          condition: 'visible modal title text',
          expected: 'Done',
        },
      ],
      reasoning: 'verify modal title',
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.action).toBe('assert');
    expect(result.actions[0]!.description).toBe('Modal title equals Done');
    expect(result.actions[0]!.condition).toBe('visible modal title text');
    expect(result.actions[0]!.expected).toBe('Done');
  });

  it('rejects an assert action missing condition', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'assert', description: 'no condition', expected: 'x' }],
      reasoning: 'bad assert',
    });
    expect(() => parseAIResponse(raw)).toThrow(/condition/i);
  });

  it('rejects an assert action missing expected', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'assert', description: 'no expected', condition: 'x' }],
      reasoning: 'bad assert',
    });
    expect(() => parseAIResponse(raw)).toThrow(/expected/i);
  });

  it('rejects an assert action missing description', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'assert', condition: 'x', expected: 'y' }],
      reasoning: 'bad assert',
    });
    expect(() => parseAIResponse(raw)).toThrow(/description/i);
  });

  it('preserves optional poll config', () => {
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
    const result = parseAIResponse(raw);
    expect(result.actions[0]!.poll).toEqual({ timeoutMs: 3000, intervalMs: 200 });
  });

  it('preserves optional against mode', () => {
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
    const result = parseAIResponse(raw);
    expect(result.actions[0]!.against).toBe('api');
  });

  it('allows multiple assert actions in one response', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'assert', description: 'A', condition: 'a', expected: '1' },
        { action: 'assert', description: 'B', condition: 'b', expected: '2' },
      ],
      reasoning: 'two asserts',
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(2);
    expect(result.actions.every((a) => a.action === 'assert')).toBe(true);
  });

  it('allows mixing click and assert actions', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'click', selector: '#submit', description: 'Click submit' },
        {
          action: 'assert',
          description: 'Banner shows',
          condition: 'success banner visible',
          expected: 'Saved',
        },
      ],
      reasoning: 'click then verify',
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]!.action).toBe('click');
    expect(result.actions[1]!.action).toBe('assert');
  });
});
