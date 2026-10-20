/**
 * `steptix init` creates the sample project (docs/specs/SPEC-install.md
 * §7.3): the files in templates/sample, the standard folders, and the config
 * from scaffoldConfig(). The sample's steps come compiled, so its first run
 * needs no AI; that run itself is checked by the release test (§10.1).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initCommand, SAMPLE_DIR, SAMPLE_TEST, scaffoldConfig, sampleFiles } from '../src/cli/commands/init.js';
import { parseTestFile } from '../src/parser/markdown.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function init(force = false, dir?: string): Promise<{ dir: string; output: string }> {
  const target = dir ?? mkdtempSync(path.join(os.tmpdir(), 'steptix-init-sample-'));
  if (!dir) made.push(target);
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
  try {
    await initCommand(target, force);
  } finally {
    log.mockRestore();
  }
  return { dir: target, output: lines.join('\n') };
}

describe('steptix init', () => {
  it('creates every sample file and the standard folders', async () => {
    const { dir } = await init();
    for (const file of await sampleFiles()) {
      expect(readFileSync(path.join(dir, file), 'utf8')).toBe(readFileSync(path.join(SAMPLE_DIR, file), 'utf8'));
    }
    for (const folder of ['tests', 'context', 'reports']) expect(existsSync(path.join(dir, folder))).toBe(true);
  });

  it('is the sample: a test, its page, its compiled steps, the context and the config', async () => {
    expect(await sampleFiles()).toEqual([
      'context/app.md',
      'pages/sample-page.html',
      'steptix.config.json',
      'tests/first-test.md',
      'tests/first-test.steps.ts',
    ]);
  });

  it('ends by naming the command that runs the sample', async () => {
    const { output } = await init();
    expect(output).toContain(`steptix run ${SAMPLE_TEST}`);
  });

  it('skips a file that is there already, and --force replaces it', async () => {
    const { dir } = await init();
    const test = path.join(dir, SAMPLE_TEST);
    writeFileSync(test, '# Mine\n');
    const again = await init(false, dir);
    expect(readFileSync(test, 'utf8')).toBe('# Mine\n');
    expect(again.output).toMatch(/Skipping tests\/first-test\.md \(already exists/);
    await init(true, dir);
    expect(readFileSync(test, 'utf8')).toBe(readFileSync(path.join(SAMPLE_DIR, SAMPLE_TEST), 'utf8'));
  });

  it('writes a config that names no AI model, so the one chosen for all projects reaches it', () => {
    // A project's model wins over the machine .env's (src/config/loader.ts,
    // withMachineAiFloor), so a model written here would set aside the
    // choice the welcome page or steptix ai saved for all projects (§7.2).
    const config = JSON.parse(scaffoldConfig()) as { ai?: { model?: string } };
    expect(config.ai?.model).toBeUndefined();
  });
});

describe('the sample test', () => {
  it('opens its own page, by a path beside the test, and every step is compiled', async () => {
    const testFile = path.join(SAMPLE_DIR, SAMPLE_TEST);
    const parsed = await parseTestFile(testFile, {});
    expect(parsed.config.baseUrl).toBe('../pages/sample-page.html');
    expect(existsSync(path.resolve(path.dirname(testFile), parsed.config.baseUrl!))).toBe(true);
    const steps = readFileSync(testFile.replace(/\.md$/, '.steps.ts'), 'utf8');
    expect(parsed.steps).toHaveLength(4);
    for (const step of parsed.steps) {
      expect(steps, `a compiled entry for "${step}"`).toContain(`source: ${JSON.stringify(step).replace(/^"|"$/g, "'").replace(/\\"/g, '"')}`);
    }
  });
});
