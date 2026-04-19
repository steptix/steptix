import { describe, it, expect } from 'vitest';
import { parseBranchedResponse } from '../src/ai/action-parser.js';

describe('parseBranchedResponse', () => {
  it('parses a matched conditional response with actions', () => {
    const raw = JSON.stringify({
      matched: 'A',
      actions: [
        { action: 'type', selector: '#mfa-code', value: '123456', description: 'Enter MFA code' },
        { action: 'click', selector: '#verify-btn', description: 'Click Verify' },
      ],
      reasoning: 'The MFA prompt is visible with a code input field',
    });

    const result = parseBranchedResponse(raw);
    expect(result.matched).toBe('A');
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]!.action).toBe('type');
    expect(result.reasoning).toContain('MFA prompt');
  });

  it('parses a "waiting" response', () => {
    const raw = JSON.stringify({
      matched: 'waiting',
      reasoning: 'The page shows a loading spinner',
    });

    const result = parseBranchedResponse(raw);
    expect(result.matched).toBe('waiting');
    expect(result.actions).toHaveLength(0);
    expect(result.reasoning).toContain('loading spinner');
  });

  it('handles "waiting" with explicit empty actions array', () => {
    const raw = JSON.stringify({
      matched: 'waiting',
      actions: [],
      reasoning: 'Still loading',
    });

    const result = parseBranchedResponse(raw);
    expect(result.matched).toBe('waiting');
    expect(result.actions).toHaveLength(0);
  });

  it('parses continuation (non-conditional) match', () => {
    const raw = JSON.stringify({
      matched: 'B',
      actions: [],
      reasoning: 'The dashboard is already loaded',
    });

    const result = parseBranchedResponse(raw);
    expect(result.matched).toBe('B');
    expect(result.actions).toHaveLength(0);
  });

  it('throws when matched field is missing', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'click', selector: '#btn', description: 'Click' }],
      reasoning: 'test',
    });

    expect(() => parseBranchedResponse(raw)).toThrow('missing required "matched" field');
  });

  it('throws for non-object response', () => {
    const raw = '["not", "an", "object"]';
    expect(() => parseBranchedResponse(raw)).toThrow('must be a JSON object');
  });

  it('handles markdown-wrapped JSON', () => {
    const raw = '```json\n{"matched":"A","actions":[],"reasoning":"test"}\n```';
    const result = parseBranchedResponse(raw);
    expect(result.matched).toBe('A');
  });

  it('handles case-insensitive "Waiting"', () => {
    const raw = JSON.stringify({
      matched: 'Waiting',
      reasoning: 'Page transitioning',
    });

    const result = parseBranchedResponse(raw);
    expect(result.matched).toBe('waiting');
    expect(result.actions).toHaveLength(0);
  });
});
