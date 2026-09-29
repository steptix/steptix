import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTestFile } from '../src/parser/markdown.js';
import { buildCodeBehindRegistry, resolveCodeBehindCacheDir } from '../src/codebehind/loader.js';
import { bundleToolModule } from '../src/tools/reload.js';

/**
 * A project that never installed the framework still runs its code-behind
 * (the self-resolve plugin in `src/tools/reload.ts`).
 *
 * Caught live: `C:\\Projects\\AITests` — a tests-only project driven from
 * Steptix, no `node_modules` — had a freshly compiled, correct `.steps.ts`,
 * and every run fell back to AI with "Cannot find package 'steptix'".
 * The server loading the file IS the framework; it resolves its own module.
 *
 * The project here lives in the OS temp dir, deliberately outside this repo,
 * so nothing above it resolves `steptix` — the repo's own
 * `package.json` self-reference is exactly what would mask the bug.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-selfres-'));
});

afterAll(async () => {
  // Each test's dir is removed as it goes; nothing to do here.
});

const STEPS_TS = `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  {
    source: 'Enter the booking code',
    async run({ page }) { await page.locator('#code').waitFor(); },
  },
]);
`;

async function project(): Promise<{ md: string; steps: string }> {
  await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
  // A project root, so the cache dir's walk-up finds a package.json that is
  // NOT the framework — the nameless kind a tests project has.
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'someones-tests', private: true }));
  const md = path.join(dir, 'tests', 'booking.md');
  await fs.writeFile(md, ['# Booking', '', '## Steps', '1. Enter the booking code'].join('\n'));
  const steps = path.join(dir, 'tests', 'booking.steps.ts');
  await fs.writeFile(steps, STEPS_TS);
  return { md, steps };
}

describe('code-behind in a project without node_modules', () => {
  it('binds its entries, resolving the framework to the one doing the loading', async () => {
    const { md } = await project();
    try {
      const test = await parseTestFile(md);
      const warnings: string[] = [];
      const registry = await buildCodeBehindRegistry(
        {
          steps: test.steps,
          rawSteps: test.expansion!.rawSteps,
          origins: test.expansion!.origins,
          frames: test.expansion!.frames,
        },
        { testFilePath: md, onWarn: (m) => warnings.push(m) },
      );
      expect(warnings).toEqual([]);
      expect(registry.loadErrors).toEqual([]);
      expect(registry.bindingFor(0)?.entry).toBeDefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rewrites the import to the framework's own export when the project cannot resolve it", async () => {
    const { steps } = await project();
    try {
      const { contents: bytes } = await bundleToolModule(steps, resolveCodeBehindCacheDir(steps));
      const contents = Buffer.from(bytes).toString("utf8");
      const expected = path.resolve(repoRoot, 'dist', 'codebehind', 'index.js').replace(/\\/g, '/');
      expect(contents).toContain(`from "file:///`);
      expect(contents).toContain(expected);
      expect(contents).not.toContain(`from "steptix/codebehind"`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves the bare specifier alone where the package does resolve', async () => {
    // Inside this repo the nearest package.json IS the framework, so Node
    // resolves the bare import by self-reference and the plugin stays out.
    const inRepo = path.join(repoRoot, 'tests', '.tmp-codebehind-self-resolve');
    await fs.mkdir(inRepo, { recursive: true });
    const file = path.join(inRepo, 'booking.steps.ts');
    await fs.writeFile(file, STEPS_TS);
    try {
      const { contents: bytes } = await bundleToolModule(file, resolveCodeBehindCacheDir(file));
      const contents = Buffer.from(bytes).toString("utf8");
      expect(contents).toContain(`from "steptix/codebehind"`);
      expect(contents).not.toContain('file:///');
    } finally {
      await fs.rm(inRepo, { recursive: true, force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
