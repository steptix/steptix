/**
 * Hooks may not return (stories/step-flow-control.md, decision 8).
 *
 * There is no flow to leave from inside a hook, and inventing one would mean
 * deciding whether it ends the hook scope, the step it wraps, or the run —
 * three defensible answers, which is the signature of a rule nobody should
 * have to guess. So the line is refused in the two places it can be AUTHORED:
 * `## Hooks` at parse, and project `defaultHooks` at config load. (The third
 * arrival — a hook the Sessions API posted, or one a skill expanded into a
 * default — is the run loop's backstop, covered in
 * `tests/flow-control-runner.test.ts`.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseTestContent, parseTestFile } from '../src/parser/markdown.js';
import { loadConfig } from '../src/config/loader.js';
import { FLOW_CONTROL_IN_HOOK } from '../src/parser/flow-control-step.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-control-hooks-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('`## Hooks`', () => {
  const withHook = (hook: string) => `# t

## Steps
1. Navigate to /

## Hooks
- ${hook}
`;

  for (const hook of [
    'beforeEach: If we are already signed in then return',
    'afterEach: Stop',
    'before: When the banner is gone, stop running the remaining steps',
    'after: Return',
  ]) {
    it(`refuses ${JSON.stringify(hook)}, naming the line`, () => {
      expect(() => parseTestContent(withHook(hook), '/t/hooks.md')).toThrow(
        FLOW_CONTROL_IN_HOOK,
      );
      // Naming the line is the point: a hook list is a wall of prose, and
      // "one of your hooks is wrong" would send the author reading all of it.
      expect(() => parseTestContent(withHook(hook), '/t/hooks.md')).toThrow(
        hook.slice(hook.indexOf(':') + 2),
      );
    });
  }

  it('still accepts an ordinary hook, including a near miss', () => {
    const parsed = parseTestContent(
      withHook('beforeEach: If a cookie banner is shown then return to the top of the page'),
      '/t/hooks.md',
    );
    expect(parsed.hooks.beforeEach).toHaveLength(1);
  });
});

describe('`## Steps`', () => {
  it('accepts a flow-control step, in the main flow and in a section', async () => {
    // The refusal is about HOOKS. The same line is the feature everywhere else,
    // and a parse-time guard that over-reached would delete it.
    const filePath = path.join(tmpDir, 'steps.md');
    await fs.writeFile(filePath, `# t

## Steps
1. Navigate to /
2. If the page title contains "Dashboard" then stop
3. Sign in

### Sign in
1. Return
2. Enter the username
`);
    const parsed = await parseTestFile(filePath);
    expect(parsed.steps).toEqual([
      'Navigate to /',
      'If the page title contains "Dashboard" then stop',
      'Return',
      'Enter the username',
    ]);
  });
});

describe('project `defaultHooks`', () => {
  async function loadWith(defaultHooks: Record<string, string[]>): Promise<void> {
    const configPath = path.join(tmpDir, 'aiui.config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ execution: { defaultHooks } }, null, 2),
    );
    await loadConfig(configPath, tmpDir);
  }

  it('refuses a flow-control line at load, naming the scope', async () => {
    await expect(loadWith({ beforeEach: ['If we are signed in then return'] })).rejects.toThrow(
      FLOW_CONTROL_IN_HOOK,
    );
    await expect(loadWith({ beforeEach: ['If we are signed in then return'] })).rejects.toThrow(
      'execution.defaultHooks.beforeEach',
    );
  });

  it('checks every scope, not just the first', async () => {
    await expect(
      loadWith({ before: ['dismiss the banner'], after: ['Stop here'] }),
    ).rejects.toThrow('execution.defaultHooks.after');
  });

  it('loads ordinary default hooks unchanged', async () => {
    await expect(
      loadWith({ beforeEach: ['dismiss any cookie banner'], after: ['log out'] }),
    ).resolves.toBeUndefined();
  });
});
