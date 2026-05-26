import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { StepCache } from '../src/cache/step-cache.js';
import { fingerprintAssertion } from '../src/cache/step-cache.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'assertion-action-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

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

// ── Cache: per-assertion code map ───────────────────────────────────────────

describe('StepCache — per-assertion code map', () => {
  const testSteps = ['Navigate', 'Verify x is y'];

  it('returns null on assertion cache miss', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    const result = await cache.readAssertion(2, 0, 'fp-abc', {});
    expect(result).toBeNull();
  });

  it('roundtrips write then read keyed by assertIndex + fingerprint', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    const code = '(() => ({ pass: true, actual: "x" }))()';

    await cache.writeAssertion(2, 0, 'fp-abc', code, {});
    const result = await cache.readAssertion(2, 0, 'fp-abc', {});

    expect(result).toBe(code);
  });

  it('returns null when fingerprint differs (assertion changed)', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    await cache.writeAssertion(2, 0, 'fp-old', 'old code', {});

    const result = await cache.readAssertion(2, 0, 'fp-new', {});
    expect(result).toBeNull();
  });

  it('keeps separate entries for different assertIndex values in the same step', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    await cache.writeAssertion(2, 0, 'fp-a', 'code A', {});
    await cache.writeAssertion(2, 1, 'fp-b', 'code B', {});

    expect(await cache.readAssertion(2, 0, 'fp-a', {})).toBe('code A');
    expect(await cache.readAssertion(2, 1, 'fp-b', {})).toBe('code B');
  });

  it('invalidates a single assertion entry without affecting siblings', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    await cache.writeAssertion(2, 0, 'fp-a', 'code A', {});
    await cache.writeAssertion(2, 1, 'fp-b', 'code B', {});

    await cache.invalidateAssertion(2, 0);

    expect(await cache.readAssertion(2, 0, 'fp-a', {})).toBeNull();
    expect(await cache.readAssertion(2, 1, 'fp-b', {})).toBe('code B');
  });

  it('parameter interpolation roundtrips on assertion code', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    const code = '(() => ({ pass: document.title === "alice", actual: document.title }))()';

    await cache.writeAssertion(2, 0, 'fp-abc', code, { username: 'alice' });
    const result = await cache.readAssertion(2, 0, 'fp-abc', { username: 'bob' });

    expect(result).toContain('"bob"');
  });

  it('bumps schema version to 4 (clears legacy v3 line-keyed caches)', async () => {
    // Pre-populate a v3 meta file (the previous, line-keyed scheme — its
    // entries may be poisoned by the skill-collision bug, so they must clear).
    const testDir = path.join(tmpDir, 'my-test');
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(
      path.join(testDir, 'meta.json'),
      JSON.stringify({ stepsHash: 'old', schemaVersion: 3 }, null, 2),
    );
    await fs.writeFile(path.join(testDir, 'step-1.json'), JSON.stringify({ turns: [] }));

    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    expect(cache).toBeDefined();

    const meta = JSON.parse(await fs.readFile(path.join(testDir, 'meta.json'), 'utf-8'));
    expect(meta.schemaVersion).toBe(4);

    // Old step file should be cleared
    await expect(fs.readFile(path.join(testDir, 'step-1.json'), 'utf-8')).rejects.toThrow();
  });
});

// ── Fingerprint: stable hash of condition + expected ────────────────────────

describe('fingerprintAssertion', () => {
  it('returns the same fingerprint for the same condition + expected + index', () => {
    const a = fingerprintAssertion('counts to 3', '3', 0);
    const b = fingerprintAssertion('counts to 3', '3', 0);
    expect(a).toBe(b);
  });

  it('returns a different fingerprint when condition changes', () => {
    const a = fingerprintAssertion('counts to 3', '3', 0);
    const b = fingerprintAssertion('counts to 4', '3', 0);
    expect(a).not.toBe(b);
  });

  it('returns a different fingerprint when expected changes', () => {
    const a = fingerprintAssertion('counts to 3', '3', 0);
    const b = fingerprintAssertion('counts to 3', '4', 0);
    expect(a).not.toBe(b);
  });

  it('returns a different fingerprint when assertIndex changes', () => {
    const a = fingerprintAssertion('counts to 3', '3', 0);
    const b = fingerprintAssertion('counts to 3', '3', 1);
    expect(a).not.toBe(b);
  });
});
