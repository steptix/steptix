import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  StepCache,
  computeStepsHash,
  sanitizeTestName,
  frameScopedStepKey,
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

describe('frameScopedStepKey (issue 016)', () => {
  it('returns the bare line for an inline (frameless) step', () => {
    expect(frameScopedStepKey('', 17)).toBe(17);
    expect(frameScopedStepKey(undefined, 12)).toBe(12);
  });

  it('qualifies a skill-body step with its frame', () => {
    expect(frameScopedStepKey('f1', 17)).toBe('f1-17');
  });

  it('distinguishes two invocations of one skill on the same source line', () => {
    expect(frameScopedStepKey('f1', 17)).not.toBe(frameScopedStepKey('f2', 17));
  });

  it('distinguishes a skill-body step from a test step on the same line', () => {
    expect(frameScopedStepKey('f1', 17)).not.toBe(frameScopedStepKey(undefined, 17));
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
    expect(meta.schemaVersion).toBe(4);
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

    await cache.write(1, [{ rawResponse, ...parsed }], {});
    const result = await cache.read(1, {});

    expect(result).not.toBeNull();
    expect(result![0]!.actions).toEqual(parsed.actions);
    expect(result![0]!.reasoning).toBe('test');
  });

  it('handles parameter interpolation on write/read roundtrip', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[{"action":"type","selector":"#user","value":"alice","description":"Type username"}],"reasoning":"ok"}';
    const parsed = {
      actions: [{ action: 'type' as const, selector: '#user', value: 'alice', description: 'Type username' }],
      reasoning: 'ok',
    };

    // Write with alice's params
    await cache.write(1, [{ rawResponse, ...parsed }], { username: 'alice' });

    // Read with bob's params — should get bob's value
    const result = await cache.read(1, { username: 'bob' });
    expect(result).not.toBeNull();
    expect(result![0]!.actions[0]!.value).toBe('bob');
  });

  it('invalidates step cache', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[],"reasoning":"test"}';
    await cache.write(1, [{ rawResponse, actions: [], reasoning: 'test' }], {});

    // Verify it's there
    expect(await cache.read(1, {})).not.toBeNull();

    // Invalidate
    await cache.invalidateStep(1);
    expect(await cache.read(1, {})).toBeNull();
  });

  it('invalidates entire cache when steps change', async () => {
    // First run — write step 1
    const cache1 = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    await cache1.write(1, [{ rawResponse: '{"actions":[],"reasoning":"v1"}', actions: [], reasoning: 'v1' }], {});
    expect(await cache1.read(1, {})).not.toBeNull();

    // Second run with different steps — cache should be cleared
    const newSteps = ['Navigate to login', 'Enter {{username}}', 'Click submit', 'Verify dashboard'];
    const cache2 = await StepCache.initialize(tmpDir, 'My Test', newSteps);
    expect(await cache2.read(1, {})).toBeNull();
  });

  it('preserves needs_reeval flag', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[],"reasoning":"multi","needs_reeval":true}';
    await cache.write(1, [{ rawResponse, actions: [], reasoning: 'multi', needs_reeval: true }], {});

    const result = await cache.read(1, {});
    expect(result![0]!.needs_reeval).toBe(true);
  });
});

// ── Frame-scoped keys: skill collision prevention (issue 016) ─────────────

describe('StepCache frame-scoped keys (issue 016)', () => {
  const steps = ['a', 'b', 'c'];

  it('keeps two invocations of one skill (same source line) in separate files', async () => {
    const cache = await StepCache.initialize(tmpDir, 'Skill Test', steps);
    // Both invocations expand to skill line 17 but get distinct frames (f1/f2).
    await cache.write(
      'f1-17',
      [{ rawResponse: '{}', actions: [{ action: 'type', selector: '#q', value: 'cats', description: 'type cats' }], reasoning: 'cats' }],
      {},
    );
    await cache.write(
      'f2-17',
      [{ rawResponse: '{}', actions: [{ action: 'type', selector: '#q', value: 'dogs', description: 'type dogs' }], reasoning: 'dogs' }],
      {},
    );

    // Second invocation must NOT replay the first's actions (the old collision).
    expect((await cache.read('f1-17', {}))![0]!.actions[0]!.value).toBe('cats');
    expect((await cache.read('f2-17', {}))![0]!.actions[0]!.value).toBe('dogs');
  });

  it('keeps a skill-body step and a test step on the same line independent', async () => {
    const cache = await StepCache.initialize(tmpDir, 'Mixed Test', steps);
    await cache.write(17, [{ rawResponse: '{}', actions: [], reasoning: 'test-step' }], {});
    await cache.write('f1-17', [{ rawResponse: '{}', actions: [], reasoning: 'skill-step' }], {});

    expect((await cache.read(17, {}))![0]!.reasoning).toBe('test-step');
    expect((await cache.read('f1-17', {}))![0]!.reasoning).toBe('skill-step');
  });

  it('writes one file per frame-scoped key', async () => {
    const cache = await StepCache.initialize(tmpDir, 'Files Test', steps);
    await cache.write('f1-17', [{ rawResponse: '{}', actions: [], reasoning: 'x' }], {});
    await cache.write('f2-17', [{ rawResponse: '{}', actions: [], reasoning: 'y' }], {});

    const dir = path.join(tmpDir, 'files-test');
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('step-')).sort();
    expect(files).toEqual(['step-f1-17.json', 'step-f2-17.json']);
  });

  it('scopes assertion code by frame too', async () => {
    const cache = await StepCache.initialize(tmpDir, 'Assert Test', steps);
    const fp = 'fingerprint-1';
    await cache.writeAssertion('f1-17', 0, fp, 'return { pass: true, actual: "x" };', {});

    expect(await cache.readAssertion('f1-17', 0, fp, {})).toContain('pass: true');
    // A different invocation's frame must not see it.
    expect(await cache.readAssertion('f2-17', 0, fp, {})).toBeNull();
  });
});

// ── issue 018: cache invalidation must track the RESOLVED hash source ──────
//
// The user report: "stop a test, edit a data .json file, save, re-run — the
// change isn't picked up." Root cause: session-manager fed the cache the RAW
// step text (${data.*} / ${source.*} placeholders intact), so a data-VALUE
// edit left the steps-hash — and every positional per-step key — unchanged,
// and a cache HIT replayed the frozen action with the stale value.
//
// StepCache itself is a dumb string-hasher: given identical step strings it
// (correctly) keeps the cache; given different ones it clears. So the FIX
// lives one layer up — session-manager now interpolates env/data into the
// hash source before StepCache.initialize (session-manager.ts ~1355). These
// seam tests pin the StepCache contract the fix relies on; the end-to-end
// guard that session-manager actually interpolates lives in
// session-manager.test.ts ("issue 018").
//
// Models the user's named-dataSource fixture (search-engine.json →
// ${search-engine.query}); the built-in ${data.url} namespace is identical.
describe('cache invalidation tracks the resolved hash source (issue 018)', () => {
  const STEP_KEY = frameScopedStepKey(undefined, 12); // inline step, source line 12

  it('clears the stale entry when the RESOLVED step text changed (the fix lever)', async () => {
    // The pre-fix hash source was the raw placeholder `Search for
    // ${search-engine.query}` — byte-identical no matter what value sits behind
    // it, so the hash could never tell one data value from another (the bug).
    // session-manager now feeds the env/data-INTERPOLATED steps, so a data-value
    // edit changes the resolved text, the hash flips, and initialize() wipes the
    // prior entry — no stale replay.

    // ── Run 1: search-engine.json query = "laptops" → resolved step text. ──
    const run1 = await StepCache.initialize(tmpDir, 'data demo', ['Search for laptops']);
    await run1.write(
      STEP_KEY,
      [{ rawResponse: '{}', actions: [{ action: 'type', selector: '#q', value: 'laptops', description: 'Search' }], reasoning: 'r' }],
      {},
    );
    expect(await run1.read(STEP_KEY, {})).not.toBeNull(); // cached

    // ── User edits the data file: query → "phones", re-runs. session-manager
    // re-inits with the new resolved text → different hash → cache cleared. ──
    const run2 = await StepCache.initialize(tmpDir, 'data demo', ['Search for phones']);
    expect(await run2.read(STEP_KEY, {})).toBeNull(); // stale entry gone → AI re-runs with "phones"
  });

  it('contrast: a {{parameter}} edit rides the cache (params stay placeholders in the hash)', async () => {
    // interpolateEnvData leaves {{params}} intact, so the hash source is
    // identical across param values → cache survives → read-time interpolation
    // fills the new value. Params ride the cache; data busts it.
    const paramSteps = ['Search for {{query}}']; // unchanged across runs (param not resolved into the hash)
    const run1 = await StepCache.initialize(tmpDir, 'param demo', paramSteps);
    await run1.write(
      STEP_KEY,
      [{ rawResponse: '{}', actions: [{ action: 'type', selector: '#q', value: 'laptops', description: 'Search' }], reasoning: 'r' }],
      { query: 'laptops' }, // stored as {{query}}
    );

    const run2 = await StepCache.initialize(tmpDir, 'param demo', paramSteps);
    const hit = await run2.read(STEP_KEY, { query: 'phones' }); // cache survives; new param value
    expect(hit![0]!.actions[0]!.value).toBe('phones');
  });
});
