/**
 * Tests for `withEnvDefaults` behavior inside the config loader —
 * specifically that INTERACTIVE_ON_FAILURE threads through to
 * execution.interactiveOnFailure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config/loader.js';

const ENV_KEYS = ['INTERACTIVE_ON_FAILURE'] as const;
const preserved: Record<string, string | undefined> = {};

describe('loadConfig — INTERACTIVE_ON_FAILURE env handling', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      preserved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (preserved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = preserved[key];
      }
    }
  });

  it('defaults to false when env var is absent', async () => {
    const config = await loadConfig();
    expect(config.execution.interactiveOnFailure).toBe(false);
  });

  it('sets execution.interactiveOnFailure=true when INTERACTIVE_ON_FAILURE=true', async () => {
    process.env['INTERACTIVE_ON_FAILURE'] = 'true';
    const config = await loadConfig();
    expect(config.execution.interactiveOnFailure).toBe(true);
  });

  it('sets execution.interactiveOnFailure=false when INTERACTIVE_ON_FAILURE=false', async () => {
    process.env['INTERACTIVE_ON_FAILURE'] = 'false';
    const config = await loadConfig();
    expect(config.execution.interactiveOnFailure).toBe(false);
  });

  it('accepts 1/yes/on as truthy', async () => {
    for (const value of ['1', 'yes', 'on']) {
      process.env['INTERACTIVE_ON_FAILURE'] = value;
      const config = await loadConfig();
      expect(config.execution.interactiveOnFailure).toBe(true);
    }
  });

  it('ignores garbage values and falls through to default', async () => {
    process.env['INTERACTIVE_ON_FAILURE'] = 'banana';
    const config = await loadConfig();
    expect(config.execution.interactiveOnFailure).toBe(false);
  });
});
