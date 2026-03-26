import { describe, it, expect } from 'vitest';
import {
  parseAIResponse,
  parseAssertionEvaluation,
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

  it('parses assert action with expected field', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'assert', description: 'Check balance', expected: '$1,234.56' },
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
});

describe('parseAssertionEvaluation', () => {
  it('parses a passing assertion', () => {
    const raw = JSON.stringify({
      pass: true,
      actual: '$1,234.56',
      explanation: 'The balance displayed matches the expected value.',
    });
    const result = parseAssertionEvaluation(raw);
    expect(result.pass).toBe(true);
    expect(result.actual).toBe('$1,234.56');
    expect(result.explanation).toContain('balance');
  });

  it('parses a failing assertion', () => {
    const raw = JSON.stringify({
      pass: false,
      actual: '$999.00',
      explanation: 'The displayed balance does not match.',
    });
    const result = parseAssertionEvaluation(raw);
    expect(result.pass).toBe(false);
    expect(result.actual).toBe('$999.00');
  });

  it('provides default explanation when missing', () => {
    const raw = JSON.stringify({ pass: true, actual: 'ok' });
    const result = parseAssertionEvaluation(raw);
    expect(result.explanation).toBe('No explanation provided');
  });

  it('coerces non-string actual to string', () => {
    const raw = JSON.stringify({ pass: false, actual: 42, explanation: 'wrong' });
    const result = parseAssertionEvaluation(raw);
    expect(result.actual).toBe('42');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseAssertionEvaluation('{ bad json }')).toThrow();
  });

  it('throws when response is not an object', () => {
    expect(() => parseAssertionEvaluation('"just a string"')).toThrow('JSON object');
  });

  it('parses from markdown code fence', () => {
    const raw = '```json\n' + JSON.stringify({ pass: true, actual: 'logged in', explanation: 'ok' }) + '\n```';
    const result = parseAssertionEvaluation(raw);
    expect(result.pass).toBe(true);
  });
});
