/**
 * A hook line as the author wrote it (docs/specs/SPEC-scoreboard.md §5.7;
 * finding 9): the parser substitutes a hook's `${env.X}` / `${data.x}` before
 * the run — hooks are not shown to the model as authored text — so the line
 * the runner holds carries the values, an environment's password included.
 * The scoreboard records the step AS AUTHORED, so the parse keeps the line as
 * written beside the baked one, and `resolveHooks` carries it to the runner.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTestFile } from '../src/parser/markdown.js';
import { resolveHooks } from '../src/runner/hooks.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-stats-hook-text-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const ENV = { env: { SIGNIN_NAME: 'alice-SECRET-name' }, data: {}, envName: 'uat' };

describe('the authored hook text survives the parse and the resolver', () => {
  it('the runner gets both: the baked line to run, and the line as written to record', async () => {
    const file = path.join(dir, 'hooks.md');
    fs.writeFileSync(
      file,
      '# Hooks\n\n## Steps\n1. Open the dashboard\n\n## Hooks\n- before: Sign in as ${env.SIGNIN_NAME}\n- afterEach: Dismiss the toast\n',
    );
    const test = await parseTestFile(file, { envData: ENV });
    // The run acts on the value, as it always did.
    expect(test.hooks.before).toEqual(['Sign in as alice-SECRET-name']);
    expect(test.authoredHooks?.before).toEqual(['Sign in as ${env.SIGNIN_NAME}']);

    const hooks = await resolveHooks(test, { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution } });
    expect(hooks.before).toEqual(['Sign in as alice-SECRET-name']);
    expect(hooks.authored).toEqual({
      before: ['Sign in as ${env.SIGNIN_NAME}'],
      beforeEach: [],
      afterEach: ['Dismiss the toast'],
      after: [],
    });
  });

  it('a project default hook is never substituted, so it is its own authored text — first, as it runs', async () => {
    const file = path.join(dir, 'defaults.md');
    fs.writeFileSync(file, '# Defaults\n\n## Steps\n1. Open the dashboard\n\n## Hooks\n- before: Sign in as ${env.SIGNIN_NAME}\n');
    const test = await parseTestFile(file, { envData: ENV });
    const hooks = await resolveHooks(test, {
      ...DEFAULT_CONFIG,
      execution: { ...DEFAULT_CONFIG.execution, defaultHooks: { before: ['Accept the cookies'] } },
    });
    expect(hooks.before).toEqual(['Accept the cookies', 'Sign in as alice-SECRET-name']);
    expect(hooks.authored?.before).toEqual(['Accept the cookies', 'Sign in as ${env.SIGNIN_NAME}']);
  });

  it('a parse with no environment substitutes nothing, and the resolver falls back to the lines themselves', async () => {
    const file = path.join(dir, 'plain.md');
    fs.writeFileSync(file, '# Plain\n\n## Steps\n1. Open the dashboard\n\n## Hooks\n- before: Sign in as ${env.SIGNIN_NAME}\n');
    const test = await parseTestFile(file);
    expect(test.authoredHooks).toBeUndefined();
    const hooks = await resolveHooks(test, DEFAULT_CONFIG);
    expect(hooks.authored?.before).toEqual(['Sign in as ${env.SIGNIN_NAME}']);
  });
});
