/**
 * Tests for `withEnvDefaults` behavior inside the config loader —
 * specifically that INTERACTIVE_ON_FAILURE threads through to
 * execution.interactiveOnFailure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { loadConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENV_KEYS = ['INTERACTIVE_ON_FAILURE'] as const;
const preserved: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// Hermetic user root
//
// `loadConfig` now ends in the machine-AI floor, which reads the user root's
// `.env` off the real machine. Every test in this file redirects that root
// into a per-test tmp dir — without this, whatever AI_MODEL the developer has
// in their real %LOCALAPPDATA%\steptix\.env would leak into assertions here.
// ---------------------------------------------------------------------------

let userRootTmp: string;
const preservedUserRoot: Record<string, string | undefined> = {};

beforeEach(async () => {
  userRootTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-user-root-'));
  for (const key of ['LOCALAPPDATA', 'XDG_CONFIG_HOME'] as const) {
    preservedUserRoot[key] = process.env[key];
    process.env[key] = userRootTmp;
  }
});

afterEach(async () => {
  for (const [key, value] of Object.entries(preservedUserRoot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(userRootTmp, { recursive: true, force: true });
});

async function writeUserRootEnv(content: string): Promise<void> {
  const dir = path.join(userRootTmp, 'steptix');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.env'), content, 'utf8');
}

describe('loadConfig — INTERACTIVE_ON_FAILURE env handling', () => {
  // The project root is an empty tmp dir, not the cwd: auto-discovery from the
  // cwd would read this repo's own steptix.config.json, and a setting added
  // there would change these answers. Which strings count as true or false is
  // parseBoolEnv's vocabulary, tested in env-loader.test.ts; what is tested
  // here is only that the loader applies its answer.
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-iof-'));
    for (const key of ENV_KEYS) {
      preserved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (preserved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = preserved[key];
      }
    }
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('defaults to false when env var is absent', async () => {
    const config = await loadConfig(undefined, projectRoot);
    expect(config.execution.interactiveOnFailure).toBe(false);
  });

  it('sets execution.interactiveOnFailure=true when INTERACTIVE_ON_FAILURE=true', async () => {
    process.env['INTERACTIVE_ON_FAILURE'] = 'true';
    const config = await loadConfig(undefined, projectRoot);
    expect(config.execution.interactiveOnFailure).toBe(true);
  });

  it('INTERACTIVE_ON_FAILURE=false beats a config file that set it true', async () => {
    // The default is already false, so only a `true` underneath can tell
    // "the loader read false" from "the loader ignored the variable".
    await fs.writeFile(
      path.join(projectRoot, 'steptix.config.json'),
      JSON.stringify({ execution: { interactiveOnFailure: true } }),
      'utf8',
    );
    expect((await loadConfig(undefined, projectRoot)).execution.interactiveOnFailure).toBe(true);

    process.env['INTERACTIVE_ON_FAILURE'] = 'false';
    const config = await loadConfig(undefined, projectRoot);
    expect(config.execution.interactiveOnFailure).toBe(false);
  });
});

describe('loadConfig — steptix.config.json loading + deep merge', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-config-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(obj: unknown): Promise<string> {
    const file = path.join(tmpDir, 'steptix.config.json');
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

  it("tables.structure defaults to 'ask' and merges to 'strict'", async () => {
    // SPEC-structured-table-reads.md §7.10. The default has to be a REAL value
    // and not an absence: the executor reads it on every failed table read,
    // and "undefined means ask" would make a project that set 'strict'
    // indistinguishable from one that set nothing the moment a merge dropped
    // the section.
    expect((await loadConfig(await writeConfig({}))).tables.structure).toBe('ask');
    const file = await writeConfig({ tables: { structure: 'strict' } });
    expect((await loadConfig(file)).tables.structure).toBe('strict');
  });

  it('browser.cdp.hideAutomation defaults to false and merges when set', async () => {
    expect((await loadConfig(await writeConfig({}))).browser.cdp?.hideAutomation).toBe(false);
    const file = await writeConfig({ browser: { cdp: { hideAutomation: true } } });
    const config = await loadConfig(file);
    expect(config.browser.cdp?.hideAutomation).toBe(true);
    // Siblings under browser are untouched by the nested merge.
    expect(config.browser.headed).toBe(true);
  });

  it("browser.ambiguousTarget defaults to 'first' and merges when set", async () => {
    // The default has to be the string, not absence: the whole point of
    // 'first' is that it names today's behaviour rather than leaving a reader
    // to infer it from an undefined (stories/codebehind-selector-ambiguity.md).
    expect((await loadConfig(await writeConfig({}))).browser.ambiguousTarget).toBe('first');
    const file = await writeConfig({ browser: { ambiguousTarget: 'fail' } });
    const config = await loadConfig(file);
    expect(config.browser.ambiguousTarget).toBe('fail');
    // Siblings under browser are untouched by the merge.
    expect(config.browser.headed).toBe(true);
    expect(config.browser.domNoiseReduction?.collapseRepetitiveDom).toBe(true);
  });

  it('drops a leftover top-level `cache` section and warns once per file', async () => {
    // The step cache is gone. A project that still carries the section keeps
    // loading — refusing it would break a working project over a key that
    // changes nothing — but it is told, once, rather than left believing the
    // setting does something.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const file = await writeConfig({ cache: { enabled: true, dir: '.cache' }, server: { port: 4242 } });

      const config = await loadConfig(file);
      expect('cache' in config).toBe(false);
      // The rest of the file still merges.
      expect(config.server.port).toBe(4242);
      const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('"cache"'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(file);
      expect(said[0]).toContain('step cache was removed');

      // A second read of the same file — a server re-reading after an edit —
      // drops it again and says nothing more.
      warn.mockClear();
      expect('cache' in (await loadConfig(file))).toBe(false);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('"cache"'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('replaces arrays wholesale (does not concatenate)', async () => {
    const file = await writeConfig({
      execution: { defaultHooks: { beforeEach: ['[skill: only_this]'] } },
    });
    const config = await loadConfig(file);
    expect(config.execution.defaultHooks?.beforeEach).toEqual(['[skill: only_this]']);
  });

  // docs/specs/SPEC-use-computer.md §4.4 — a hook runs on the page surface, so
  // it may not switch surface. At LOAD, beside the flow-control rule and for
  // the same reason: `defaultHooks` merges into every test in the project, and
  // a hook that changed the surface would change it for the step it wraps and
  // for every step after it.
  it.each(['[use computer]', '[use browser]'])(
    'refuses %s in execution.defaultHooks',
    async (line) => {
      const file = await writeConfig({ execution: { defaultHooks: { beforeEach: [line] } } });

      await expect(loadConfig(file)).rejects.toThrow(/hook runs on the page surface/);
      await expect(loadConfig(file)).rejects.toThrow(/defaultHooks\.beforeEach/);
    },
  );

  it('throws when an explicit --config path does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.json');
    await expect(loadConfig(missing)).rejects.toThrow(missing);
  });

  it('throws when an explicit --config path is not a .json file', async () => {
    await expect(loadConfig(path.join(tmpDir, 'steptix.config.ts'))).rejects.toThrow(
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
    const file = path.join(tmpDir, 'steptix.config.json');
    await fs.writeFile(file, '{ "server": { "port": 3100, }', 'utf8'); // trailing comma
    await expect(loadConfig(file)).rejects.toThrow(file);
  });

  it('ignores a top-level $schema key', async () => {
    const file = await writeConfig({
      $schema: 'https://example.com/steptix.config.schema.json',
      server: { port: 5000 },
    });
    const config = await loadConfig(file);
    expect(config.server.port).toBe(5000);
    expect((config as unknown as Record<string, unknown>)['$schema']).toBeUndefined();
  });

  it('auto-discovers only steptix.config.json — a legacy .ts is ignored', async () => {
    // Only a .ts config exists in the dir, no .json. Auto-discovery (no
    // explicit path) must NOT pick it up — the project is treated as
    // unconfigured and falls back to defaults.
    await fs.writeFile(
      path.join(tmpDir, 'steptix.config.ts'),
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

describe('loadConfig — machine AI floor (stories/machine-key.md)', () => {
  let tmpDir: string;
  const AI_KEYS = ['AI_API_KEY', 'AI_MODEL', 'AI_EFFORT', 'AI_GATEWAY_URL'] as const;
  const preservedAi: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-floor-'));
    for (const key of AI_KEYS) {
      preservedAi[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of AI_KEYS) {
      if (preservedAi[key] === undefined) delete process.env[key];
      else process.env[key] = preservedAi[key];
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(obj: unknown): Promise<string> {
    const file = path.join(tmpDir, 'steptix.config.json');
    await fs.writeFile(file, JSON.stringify(obj), 'utf8');
    return file;
  }

  it('fills ai.apiKey and ai.model when nothing else set them', async () => {
    await writeUserRootEnv('AI_API_KEY=machine-ai-key\nAI_MODEL=machine/model\n');
    const config = await loadConfig(await writeConfig({}));

    expect(config.ai.apiKey).toBe('machine-ai-key');
    expect(config.ai.model).toBe('machine/model');
  });

  it('is a floor, never an override: the project config file wins', async () => {
    // Verification rule (9) — this is the case a naive process.env preload
    // gets backwards, because env AI_MODEL overrides the config file.
    await writeUserRootEnv('AI_API_KEY=machine-ai-key\nAI_MODEL=machine/model\n');
    const config = await loadConfig(
      await writeConfig({ ai: { apiKey: 'project-ai-key', model: 'project/model' } }),
    );

    expect(config.ai.apiKey).toBe('project-ai-key');
    expect(config.ai.model).toBe('project/model');
  });

  it('the environment also beats the machine value', async () => {
    await writeUserRootEnv('AI_API_KEY=machine-ai-key\nAI_MODEL=machine/model\n');
    process.env['AI_API_KEY'] = 'env-ai-key';
    process.env['AI_MODEL'] = 'env/model';

    const config = await loadConfig(await writeConfig({}));

    expect(config.ai.apiKey).toBe('env-ai-key');
    expect(config.ai.model).toBe('env/model');
  });

  it('AI_EFFORT lands on ai.effort', async () => {
    process.env['AI_EFFORT'] = 'high';

    const config = await loadConfig(await writeConfig({}));

    expect(config.ai.effort).toBe('high');
  });

  it('an absent AI_EFFORT leaves ai.effort unset', async () => {
    const config = await loadConfig(await writeConfig({}));

    // Unset is what keeps every existing run — and its prompt-cache prefix —
    // byte-for-byte what it is today.
    expect(config.ai.effort).toBeUndefined();
  });

  it('a blank AI_EFFORT reads as absent', async () => {
    process.env['AI_EFFORT'] = '   ';

    const config = await loadConfig(await writeConfig({}));

    expect(config.ai.effort).toBeUndefined();
  });

  it('no machine values leaves the built-in default model untouched', async () => {
    const config = await loadConfig(await writeConfig({}));

    expect(config.ai.model).toBe(DEFAULT_CONFIG.ai.model);
    expect(config.ai.apiKey).toBeUndefined();
  });

  it('blank machine values read as absent', async () => {
    await writeUserRootEnv('AI_API_KEY=\nAI_MODEL=   \n');
    const config = await loadConfig(await writeConfig({}));

    expect(config.ai.apiKey).toBeUndefined();
    expect(config.ai.model).toBe(DEFAULT_CONFIG.ai.model);
  });

  // -------------------------------------------------------------------------
  // AI_GATEWAY_URL (stories/keyless-replay-and-gateway-env.md Part A)
  //
  // The same four-level chain as AI_MODEL — environment → config file →
  // machine `.env` → built-in default — with one thing the model cases cannot
  // exercise: `gatewayUrl` HAS a built-in default, so the merged config always
  // carries a value and "did the file set one?" is only answerable from the
  // raw file config.
  // -------------------------------------------------------------------------

  it('AI_GATEWAY_URL from the environment beats the config file', async () => {
    process.env['AI_GATEWAY_URL'] = 'https://env.gateway.test';
    const config = await loadConfig(
      await writeConfig({ ai: { gatewayUrl: 'https://file.gateway.test' } }),
    );

    expect(config.ai.gatewayUrl).toBe('https://env.gateway.test');
  });

  it('trims AI_GATEWAY_URL and reads a blank one as absent', async () => {
    process.env['AI_GATEWAY_URL'] = '  https://env.gateway.test  ';
    expect((await loadConfig(await writeConfig({}))).ai.gatewayUrl).toBe(
      'https://env.gateway.test',
    );

    process.env['AI_GATEWAY_URL'] = '   ';
    expect((await loadConfig(await writeConfig({}))).ai.gatewayUrl).toBe(
      DEFAULT_CONFIG.ai.gatewayUrl,
    );
  });

  it('a config-file gatewayUrl beats the machine .env', async () => {
    await writeUserRootEnv('AI_GATEWAY_URL=https://machine.gateway.test\n');
    const config = await loadConfig(
      await writeConfig({ ai: { gatewayUrl: 'https://file.gateway.test' } }),
    );

    // THE test for this var. The floor asks `fileAi`, not the merged result —
    // read the merged result and the answer is "someone set it" every time
    // (the built-in default is a string too), so the machine value could never
    // apply. Read only `fileAi` and forget the default exists, and it applies
    // even here, silently re-pointing a project that pinned its own endpoint.
    expect(config.ai.gatewayUrl).toBe('https://file.gateway.test');
  });

  it('the machine .env applies when neither the environment nor the file set one', async () => {
    await writeUserRootEnv('AI_GATEWAY_URL=https://machine.gateway.test\n');
    const config = await loadConfig(await writeConfig({}));

    expect(config.ai.gatewayUrl).toBe('https://machine.gateway.test');
  });

  it('the environment beats the machine .env', async () => {
    await writeUserRootEnv('AI_GATEWAY_URL=https://machine.gateway.test\n');
    process.env['AI_GATEWAY_URL'] = 'https://env.gateway.test';
    const config = await loadConfig(await writeConfig({}));

    expect(config.ai.gatewayUrl).toBe('https://env.gateway.test');
  });

  it('no gateway anywhere leaves the built-in default', async () => {
    await writeUserRootEnv('AI_GATEWAY_URL=   \n');
    const config = await loadConfig(await writeConfig({}));

    expect(config.ai.gatewayUrl).toBe(DEFAULT_CONFIG.ai.gatewayUrl);
  });
});

describe('steptix.config.schema.json validates configs', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let validate: any;

  beforeEach(async () => {
    const schemaText = await fs.readFile(
      path.resolve(__dirname, '../schema/steptix.config.schema.json'),
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

  it('accepts browser.cdp.hideAutomation as a boolean and nothing else', () => {
    expect(validate({ browser: { cdp: { hideAutomation: true } } })).toBe(true);
    expect(validate({ browser: { cdp: { hideAutomation: 'yes' } } })).toBe(false);
    expect(validate({ browser: { cdp: { hideAutomaton: true } } })).toBe(false);
  });

  it("accepts browser.ambiguousTarget as 'first'/'fail' and nothing else", () => {
    expect(validate({ browser: { ambiguousTarget: 'first' } })).toBe(true);
    expect(validate({ browser: { ambiguousTarget: 'fail' } })).toBe(true);
    // No third mode: a `'strict'` arm gating on ALL matches was considered and
    // declined, so the schema must not quietly accept one.
    expect(validate({ browser: { ambiguousTarget: 'strict' } })).toBe(false);
    expect(validate({ browser: { ambiguousTarget: true } })).toBe(false);
    expect(validate({ browser: { ambiguousTargets: 'fail' } })).toBe(false);
  });

  it("accepts tables.structure as 'ask'/'strict' and nothing else", () => {
    expect(validate({ tables: { structure: 'ask' } })).toBe(true);
    expect(validate({ tables: { structure: 'strict' } })).toBe(true);
    // 'off' reads like a third mode and is not one: the switch is between
    // asking and letting the refusal stand (§7.10).
    expect(validate({ tables: { structure: 'off' } })).toBe(false);
    expect(validate({ tables: { structure: true } })).toBe(false);
    expect(validate({ tables: { structures: 'ask' } })).toBe(false);
    expect(validate({ table: { structure: 'ask' } })).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(validate({ reprts: {} })).toBe(false);
  });
});
