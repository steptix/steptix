import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  StepCache,
  computeStepsHash,
  sanitizeTestName,
  reverseInterpolate,
  forwardInterpolate,
} from '../src/cache/step-cache.js';
import type { AIAction } from '../src/ai/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step-cache-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Pure function tests ────────────────────────────────────────────────────

describe('computeStepsHash', () => {
  it('returns consistent hash for the same steps', () => {
    const steps = ['Navigate to login', 'Enter username'];
    expect(computeStepsHash(steps)).toBe(computeStepsHash(steps));
  });

  it('returns different hash when steps change', () => {
    const a = computeStepsHash(['Step 1', 'Step 2']);
    const b = computeStepsHash(['Step 1', 'Step 2 modified']);
    expect(a).not.toBe(b);
  });

  it('returns different hash when step order changes', () => {
    const a = computeStepsHash(['Step 1', 'Step 2']);
    const b = computeStepsHash(['Step 2', 'Step 1']);
    expect(a).not.toBe(b);
  });
});

describe('sanitizeTestName', () => {
  it('lowercases and replaces special characters', () => {
    expect(sanitizeTestName('My Test Name!')).toBe('my-test-name');
  });

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeTestName('--test--')).toBe('test');
  });

  it('truncates long names', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeTestName(long).length).toBeLessThanOrEqual(100);
  });
});

describe('reverseInterpolate', () => {
  it('replaces parameter values with placeholders in value fields', () => {
    const actions: AIAction[] = [
      { action: 'type', selector: '#email', value: 'alice@example.com', description: 'Type email' },
    ];
    const params = { email: 'alice@example.com' };

    const result = reverseInterpolate(actions, params);
    expect(result[0]!.value).toBe('{{email}}');
  });

  it('does not replace in selector fields', () => {
    const actions: AIAction[] = [
      { action: 'click', selector: '[data-user="alice"]', value: 'alice', description: 'Click user' },
    ];
    const params = { user: 'alice' };

    const result = reverseInterpolate(actions, params);
    expect(result[0]!.selector).toBe('[data-user="alice"]');
    expect(result[0]!.value).toBe('{{user}}');
  });

  it('handles multiple parameters with longest-first priority', () => {
    const actions: AIAction[] = [
      { action: 'type', selector: '#field', value: 'test@example.com', description: 'Type' },
    ];
    const params = { email: 'test@example.com', name: 'test' };

    const result = reverseInterpolate(actions, params);
    // Should match 'test@example.com' as {{email}}, not 'test' as {{name}}
    expect(result[0]!.value).toBe('{{email}}');
  });

  it('returns actions unchanged when no params', () => {
    const actions: AIAction[] = [
      { action: 'click', selector: '#btn', description: 'Click' },
    ];
    const result = reverseInterpolate(actions, {});
    expect(result).toBe(actions); // same reference
  });

  it('skips actions without value field', () => {
    const actions: AIAction[] = [
      { action: 'click', selector: '#btn', description: 'Click button' },
    ];
    const params = { btn: '#btn' };

    const result = reverseInterpolate(actions, params);
    expect(result[0]).toBe(actions[0]); // same reference — untouched
  });
});

describe('forwardInterpolate', () => {
  it('replaces placeholders with parameter values in value fields', () => {
    const actions: AIAction[] = [
      { action: 'type', selector: '#email', value: '{{email}}', description: 'Type email' },
    ];
    const params = { email: 'bob@test.com' };

    const result = forwardInterpolate(actions, params);
    expect(result[0]!.value).toBe('bob@test.com');
  });

  it('leaves unresolved placeholders intact', () => {
    const actions: AIAction[] = [
      { action: 'type', selector: '#field', value: '{{unknown}}', description: 'Type' },
    ];

    const result = forwardInterpolate(actions, {});
    expect(result[0]!.value).toBe('{{unknown}}');
  });

  it('does not replace in selector fields', () => {
    const actions: AIAction[] = [
      { action: 'click', selector: '{{email}}', value: '{{email}}', description: 'Click' },
    ];
    const params = { email: 'test@example.com' };

    const result = forwardInterpolate(actions, params);
    expect(result[0]!.selector).toBe('{{email}}');
    expect(result[0]!.value).toBe('test@example.com');
  });
});

// ── Integration tests (filesystem) ────────────────────────────────────────

describe('StepCache', () => {
  const testSteps = ['Navigate to login', 'Enter {{username}}', 'Click submit'];

  it('creates cache directory and meta.json on initialize', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    expect(cache).toBeDefined();

    const metaPath = path.join(tmpDir, 'my-test', 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    expect(meta.stepsHash).toBe(computeStepsHash(testSteps));
    expect(meta.schemaVersion).toBe(1);
  });

  it('returns null on cache miss', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    const result = await cache.read(1, {});
    expect(result).toBeNull();
  });

  it('roundtrips write then read', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[{"action":"click","selector":"#btn","description":"Click"}],"reasoning":"test"}';
    const parsed = {
      actions: [{ action: 'click' as const, selector: '#btn', description: 'Click' }],
      reasoning: 'test',
    };

    await cache.write(1, rawResponse, parsed, {});
    const result = await cache.read(1, {});

    expect(result).not.toBeNull();
    expect(result!.actions).toEqual(parsed.actions);
    expect(result!.reasoning).toBe('test');
  });

  it('handles parameter interpolation on write/read roundtrip', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[{"action":"type","selector":"#user","value":"alice","description":"Type username"}],"reasoning":"ok"}';
    const parsed = {
      actions: [{ action: 'type' as const, selector: '#user', value: 'alice', description: 'Type username' }],
      reasoning: 'ok',
    };

    // Write with alice's params
    await cache.write(1, rawResponse, parsed, { username: 'alice' });

    // Read with bob's params — should get bob's value
    const result = await cache.read(1, { username: 'bob' });
    expect(result).not.toBeNull();
    expect(result!.actions[0]!.value).toBe('bob');
  });

  it('invalidates step cache', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[],"reasoning":"test"}';
    await cache.write(1, rawResponse, { actions: [], reasoning: 'test' }, {});

    // Verify it's there
    expect(await cache.read(1, {})).not.toBeNull();

    // Invalidate
    await cache.invalidateStep(1);
    expect(await cache.read(1, {})).toBeNull();
  });

  it('invalidates entire cache when steps change', async () => {
    // First run — write step 1
    const cache1 = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    await cache1.write(1, '{"actions":[],"reasoning":"v1"}', { actions: [], reasoning: 'v1' }, {});
    expect(await cache1.read(1, {})).not.toBeNull();

    // Second run with different steps — cache should be cleared
    const newSteps = ['Navigate to login', 'Enter {{username}}', 'Click submit', 'Verify dashboard'];
    const cache2 = await StepCache.initialize(tmpDir, 'My Test', newSteps);
    expect(await cache2.read(1, {})).toBeNull();
  });

  it('preserves needs_reeval flag', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[],"reasoning":"multi","needs_reeval":true}';
    await cache.write(1, rawResponse, { actions: [], reasoning: 'multi', needs_reeval: true }, {});

    const result = await cache.read(1, {});
    expect(result!.needs_reeval).toBe(true);
  });
});
