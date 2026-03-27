import { describe, it, expect, beforeEach } from 'vitest';
import { ApiResponseStore } from '../src/api/response-store.js';
import type { StoredResponse } from '../src/api/types.js';

function makeResponse(overrides: Partial<StoredResponse> = {}): StoredResponse {
  return {
    stepNumber: 1,
    endpoint: '/api/delegates',
    method: 'GET',
    url: 'http://localhost:8787/api/delegates',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: [{ id: 'del-001', name: 'Alice', mobile: '0411111111' }],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('ApiResponseStore', () => {
  let store: ApiResponseStore;

  beforeEach(() => {
    store = new ApiResponseStore();
  });

  it('starts empty', () => {
    expect(store.hasResponses()).toBe(false);
    expect(store.getAll()).toHaveLength(0);
  });

  it('stores a response', () => {
    store.add(makeResponse());
    expect(store.hasResponses()).toBe(true);
    expect(store.getAll()).toHaveLength(1);
  });

  it('stores multiple responses', () => {
    store.add(makeResponse({ stepNumber: 1 }));
    store.add(makeResponse({ stepNumber: 2, endpoint: '/api/delegates/del-001', method: 'PUT' }));
    expect(store.getAll()).toHaveLength(2);
  });

  it('retrieves response by step number', () => {
    store.add(makeResponse({ stepNumber: 3 }));
    const found = store.getForStep(3);
    expect(found).toBeDefined();
    expect(found?.stepNumber).toBe(3);
  });

  it('returns undefined for missing step', () => {
    store.add(makeResponse({ stepNumber: 1 }));
    expect(store.getForStep(99)).toBeUndefined();
  });

  it('clears all responses', () => {
    store.add(makeResponse());
    store.add(makeResponse({ stepNumber: 2 }));
    store.clear();
    expect(store.hasResponses()).toBe(false);
    expect(store.getAll()).toHaveLength(0);
  });

  it('getAll returns a copy (not the internal array)', () => {
    store.add(makeResponse());
    const all = store.getAll();
    all.push(makeResponse({ stepNumber: 99 }));
    // Internal store should not be affected
    expect(store.getAll()).toHaveLength(1);
  });

  describe('formatForContext', () => {
    it('returns empty string when no responses', () => {
      expect(store.formatForContext()).toBe('');
    });

    it('includes step number, method, endpoint, and status', () => {
      store.add(makeResponse({ stepNumber: 2, method: 'GET', endpoint: '/api/delegates', status: 200 }));
      const context = store.formatForContext();
      expect(context).toContain('Step 2');
      expect(context).toContain('GET');
      expect(context).toContain('/api/delegates');
      expect(context).toContain('200');
    });

    it('includes request body when present', () => {
      store.add(makeResponse({
        stepNumber: 3,
        method: 'PUT',
        requestBody: { mobile: '0499999999' },
      }));
      const context = store.formatForContext();
      expect(context).toContain('0499999999');
    });

    it('includes multiple responses', () => {
      store.add(makeResponse({ stepNumber: 1 }));
      store.add(makeResponse({ stepNumber: 2, endpoint: '/api/delegates/del-001', status: 200 }));
      const context = store.formatForContext();
      expect(context).toContain('Step 1');
      expect(context).toContain('Step 2');
    });

    it('truncates long response bodies', () => {
      const largeBody = { data: 'x'.repeat(1000) };
      store.add(makeResponse({ body: largeBody }));
      const context = store.formatForContext();
      // Should not include the full 1000 chars
      expect(context.length).toBeLessThan(1000);
    });
  });
});
