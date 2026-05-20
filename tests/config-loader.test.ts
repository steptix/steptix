/**
 * Tests for `withEnvDefaults` behavior inside the config loader —
 * specifically that INTERACTIVE_ON_FAILURE threads through to
 * execution.interactiveOnFailure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { loadConfig } from '../src/config/loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

describe('loadConfig — aiui.config.json loading + deep merge', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-config-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(obj: unknown): Promise<string> {
    const file = path.join(tmpDir, 'aiui.config.json');
    await fs.writeFile(file, JSON.stringify(obj), 'utf8');
    return file;
  }

  it('loads JSON and merges over defaults (omitted keys keep defaults)', async () => {
    const file = await writeConfig({
      server: { port: 4242 },
      tests: { skillsDir: './my-skills' },
    });
    const config = await loadConfig(file);
    expect(config.server.port).toBe(4242);
    expect(config.tests.skillsDir).toBe('./my-skills');
    // Untouched keys keep their defaults.
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.tests.pattern).toBe('**/*.md');
  });

  it('deep-merges a partial nested object, keeping sibling defaults', async () => {
    const file = await writeConfig({ browser: { viewport: { width: 800 } } });
    const config = await loadConfig(file);
    // width overridden, height inherited from DEFAULT_CONFIG (the regression
    // the recursive merge fixes — the old 2-level merge dropped height).
    expect(config.browser.viewport.width).toBe(800);
    expect(config.browser.viewport.height).toBeGreaterThan(0);
  });

  it('deep-merges a single domNoiseReduction flag, keeping the other six', async () => {
    const file = await writeConfig({
      browser: { domNoiseReduction: { dropUnstableIds: true } },
    });
    const config = await loadConfig(file);
    const dnr = config.browser.domNoiseReduction!;
    expect(dnr.dropUnstableIds).toBe(true);
    // Siblings preserved from defaults rather than dropped to undefined.
    expect(dnr.collapseRepetitiveDom).toBe(true);
    expect(dnr.compactSvg).toBe(true);
    expect(dnr.hideHiddenInputs).toBe(true);
  });

  it('replaces arrays wholesale (does not concatenate)', async () => {
    const file = await writeConfig({
      execution: { defaultHooks: { beforeEach: ['[skill: only_this]'] } },
    });
    const config = await loadConfig(file);
    expect(config.execution.defaultHooks?.beforeEach).toEqual(['[skill: only_this]']);
  });

  it('throws when an explicit --config path does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.json');
    await expect(loadConfig(missing)).rejects.toThrow(missing);
  });

  it('throws when an explicit --config path is not a .json file', async () => {
    await expect(loadConfig(path.join(tmpDir, 'aiui.config.ts'))).rejects.toThrow(
      /\.json/,
    );
  });

  it('does not leak mutations back into shared defaults across loads', async () => {
    // Load with no override on `server`, then mutate the returned subtree the
    // way serve.ts does. A second load must still see the pristine default.
    const fileA = await writeConfig({ tests: { skillsDir: './a' } });
    const first = await loadConfig(fileA);
    first.server.port = 65000;

    const fileB = await writeConfig({ tests: { skillsDir: './b' } });
    const second = await loadConfig(fileB);
    expect(second.server.port).toBe(3100);
  });

  it('throws with the file path on malformed JSON', async () => {
    const file = path.join(tmpDir, 'aiui.config.json');
    await fs.writeFile(file, '{ "server": { "port": 3100, }', 'utf8'); // trailing comma
    await expect(loadConfig(file)).rejects.toThrow(file);
  });

  it('ignores a top-level $schema key', async () => {
    const file = await writeConfig({
      $schema: 'https://example.com/aiui.config.schema.json',
      server: { port: 5000 },
    });
    const config = await loadConfig(file);
    expect(config.server.port).toBe(5000);
    expect((config as unknown as Record<string, unknown>)['$schema']).toBeUndefined();
  });

  it('auto-discovers only aiui.config.json — a legacy .ts is ignored', async () => {
    // Only a .ts config exists in the dir, no .json. Auto-discovery (no
    // explicit path) must NOT pick it up — the project is treated as
    // unconfigured and falls back to defaults.
    await fs.writeFile(
      path.join(tmpDir, 'aiui.config.ts'),
      'export default { server: { port: 9999 } };',
      'utf8',
    );
    const cwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const config = await loadConfig();
      expect(config.server.port).toBe(3100); // default, not 9999
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('aiui.config.schema.json validates configs', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let validate: any;

  beforeEach(async () => {
    const schemaText = await fs.readFile(
      path.resolve(__dirname, '../schema/aiui.config.schema.json'),
      'utf8',
    );
    const ajv = new Ajv({ strict: false, allErrors: true });
    validate = ajv.compile(JSON.parse(schemaText));
  });

  it('accepts a minimal config with $schema', () => {
    const ok = validate({
      $schema: 'https://example.com/schema.json',
      tests: { skillsDir: './skills', toolsDir: './tools/src' },
      browser: { headed: true },
    });
    expect(ok).toBe(true);
  });

  it('accepts a partial nested object (viewport width only)', () => {
    expect(validate({ browser: { viewport: { width: 800 } } })).toBe(true);
  });

  it('rejects an out-of-enum browser engine', () => {
    expect(validate({ browser: { browser: 'firefx' } })).toBe(false);
  });

  it('rejects a wrong-typed port', () => {
    expect(validate({ server: { port: '3100' } })).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(validate({ reprts: {} })).toBe(false);
  });
});
