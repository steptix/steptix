import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, BrowserContext, Browser } from 'playwright';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { buildCodeBehindRegistry, type CodeBehindBinding } from '../src/codebehind/loader.js';
import { runCodeBehindEntry } from '../src/codebehind/execute.js';
import type { CodeBehindContext } from '../src/codebehind/types.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * Frame-aware variables (stories/step-codebehind.md, "Skill variables").
 *
 * A skill's code-behind is written ONCE and reused by every invocation, so it
 * keeps using the name the author wrote. The runtime maps that name through
 * the invocation's own scope — the `__skill<N>_` renames the expander applied
 * to the step text, the caller's output aliases, and the declared parameters
 * the expander interpolated straight into the text.
 */

/** This run's own directory, with the house Prettier style pinned at its root
 *  (tests/codebehind-scratch.ts says why both matter). */
let tmpBase: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('codebehind-vars');
});

const noPage = {} as unknown as Page;
const noContext = {} as unknown as BrowserContext;
const noBrowser = {} as unknown as Browser;

let counter = 0;
let dir: string;

beforeEach(async () => {
  clearSkillCache();
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await removeScratchBase(tmpBase);
});

async function write(rel: string, contents: string): Promise<string> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, 'utf-8');
  return abs;
}

/**
 * The skill under test. `username` is a declared parameter (interpolated into
 * the text), `token` a declared output (aliased by the caller), `scratch` an
 * internal name (namespaced per invocation).
 */
const LOGIN_SKILL = [
  '---', 'type: skill', '---', '# login', '',
  '## Parameters', '- username: who to sign in as', '',
  '## Outputs', '- token', '',
  '## Steps',
  '1. Sign in as {{username}}',
  '2. Read the session token [store as: token]',
  '3. Note the scratch value [store as: scratch] then reuse {{scratch}}',
].join('\n');

async function bindingsFor(testMd: string): Promise<CodeBehindBinding[]> {
  await write('skills/login.md', LOGIN_SKILL);
  const testPath = await write('t.md', testMd);
  const parsed = await parseTestFile(testPath, { skillsDir: path.join(dir, 'skills') });
  const registry = await buildCodeBehindRegistry(
    {
      steps: parsed.steps,
      rawSteps: parsed.expansion!.rawSteps,
      origins: parsed.expansion!.origins,
      frames: parsed.expansion!.frames,
    },
    { testFilePath: parsed.filePath, onWarn: () => {} },
  );
  return parsed.steps.map((_, i) => registry.bindingFor(i)!);
}

/** Run `body` as the entry for `binding`, against `params`. */
async function runEntry(
  binding: CodeBehindBinding,
  params: Record<string, string>,
  body: (ctx: CodeBehindContext) => Promise<void> | void,
): Promise<Awaited<ReturnType<typeof runCodeBehindEntry>>> {
  return runCodeBehindEntry({
    binding: { ...binding, entry: { source: binding.source, run: body } },
    page: noPage,
    context: noContext,
    browser: noBrowser,
    resolvedParameters: params,
    label: 'test',
  });
}

describe('code-behind variables inside a skill frame', () => {
  const oneCall = ['# T', '', '## Steps', '1. [skill: login username="alice" out.token="session"]'].join('\n');

  it('reads a declared parameter by its AUTHORED name', async () => {
    const [first] = await bindingsFor(oneCall);
    const params: Record<string, string> = {};
    let seen: string | undefined;
    await runEntry(first!, params, ({ step }) => { seen = step.getVar('username'); });
    expect(seen).toBe('alice');
  });

  it('reads an internal name through the frame\'s __skill<N>_ namespace', async () => {
    const bindings = await bindingsFor(oneCall);
    const scratchStep = bindings[2]!;
    const namespaced = scratchStep.scope.renames['scratch']!;
    expect(namespaced).toMatch(/^__skill\d+_scratch$/);

    const params: Record<string, string> = { [namespaced]: 'namespaced value', scratch: 'bare value' };
    let seen: string | undefined;
    await runEntry(scratchStep, params, ({ step }) => { seen = step.getVar('scratch'); });
    // The frame's namespace wins over the bare name — an outer variable that
    // happens to share the skill's internal name must not leak in.
    expect(seen).toBe('namespaced value');
  });

  it('falls back to the bare name for anything the frame does not rename', async () => {
    const [first] = await bindingsFor(oneCall);
    let seen: string | undefined;
    await runEntry(first!, { unrelated: 'outer' }, ({ step }) => { seen = step.getVar('unrelated'); });
    expect(seen).toBe('outer');
  });

  it('writes a declared output through the caller\'s alias', async () => {
    const bindings = await bindingsFor(oneCall);
    const params: Record<string, string> = {};
    const outcome = await runEntry(bindings[1]!, params, ({ step }) => { step.setVar('token', 'T-1'); });
    expect(outcome.status).toBe('passed');
    expect(params['session']).toBe('T-1');
    expect(params['token']).toBeUndefined();
    expect(outcome.outputs).toEqual({ session: 'T-1' });
  });

  it('writes an internal name into the frame\'s namespace', async () => {
    const bindings = await bindingsFor(oneCall);
    const namespaced = bindings[2]!.scope.renames['scratch']!;
    const params: Record<string, string> = {};
    await runEntry(bindings[2]!, params, ({ step }) => { step.setVar('scratch', 'S'); });
    expect(params[namespaced]).toBe('S');
    expect(params['scratch']).toBeUndefined();
  });

  it('gives two invocations of one skill their own values from the SAME entry', async () => {
    const bindings = await bindingsFor([
      '# T', '', '## Steps',
      '1. [skill: login username="alice" out.token="a_session"]',
      '2. [skill: login username="bob" out.token="b_session"]',
    ].join('\n'));

    // One entry body, reused: exactly what a shared `.steps.ts` would hold.
    const body = ({ step }: CodeBehindContext): void => {
      step.setVar('token', `token-for-${step.getVar('username')}`);
    };

    const params: Record<string, string> = {};
    await runEntry(bindings[0]!, params, body);   // alice's step 1
    await runEntry(bindings[3]!, params, body);   // bob's step 1

    expect(params['a_session']).toBe('token-for-alice');
    expect(params['b_session']).toBe('token-for-bob');
    // Different frames, so the internal namespaces are distinct too.
    expect(bindings[2]!.scope.renames['scratch']).not.toBe(bindings[5]!.scope.renames['scratch']);
  });

  it('resolves a caller argument that is itself a {{placeholder}}', async () => {
    const bindings = await bindingsFor([
      '# T', '', '## Steps', '1. [skill: login username="{{outer_user}}" out.token="session"]',
    ].join('\n'));
    let seen: string | undefined;
    await runEntry(bindings[0]!, { outer_user: 'carol' }, ({ step }) => { seen = step.getVar('username'); });
    expect(seen).toBe('carol');
  });
});

describe('code-behind variables outside a skill frame', () => {
  it('uses bare names for a top-level step', async () => {
    const testPath = await write('plain.md', ['# T', '', '## Steps', '1. Read the balance'].join('\n'));
    const parsed = await parseTestFile(testPath);
    const registry = await buildCodeBehindRegistry(
      {
        steps: parsed.steps,
        rawSteps: parsed.expansion!.rawSteps,
        origins: parsed.expansion!.origins,
        frames: parsed.expansion!.frames,
      },
      { testFilePath: parsed.filePath, onWarn: () => {} },
    );
    const binding = registry.bindingFor(0)!;
    expect(binding.scope).toEqual({ renames: {}, inputs: {} });

    const params: Record<string, string> = { seed: 'in' };
    const outcome = await runEntry(binding, params, ({ step }) => {
      step.setVar('balance', step.getVar('seed') ?? 'missing');
    });
    expect(outcome.status).toBe('passed');
    expect(params['balance']).toBe('in');
  });

  it('reports a failed step.expect distinctly from a thrown error', async () => {
    const testPath = await write('plain.md', ['# T', '', '## Steps', '1. Verify the total'].join('\n'));
    const parsed = await parseTestFile(testPath);
    const registry = await buildCodeBehindRegistry(
      {
        steps: parsed.steps,
        rawSteps: parsed.expansion!.rawSteps,
        origins: parsed.expansion!.origins,
        frames: parsed.expansion!.frames,
      },
      { testFilePath: parsed.filePath, onWarn: () => {} },
    );
    const binding = registry.bindingFor(0)!;

    const failedExpect = await runEntry(binding, {}, ({ step }) => {
      step.expect(false, 'total was 5, wanted 7');
    });
    expect(failedExpect.status).toBe('failed');
    expect(failedExpect.expectationFailed).toBe(true);
    expect(failedExpect.error).toBe('total was 5, wanted 7');

    const threw = await runEntry(binding, {}, () => { throw new Error('selector went away'); });
    expect(threw.status).toBe('failed');
    expect(threw.expectationFailed).toBe(false);
  });

  it('JSON-encodes an array value so it round-trips through the string map', async () => {
    const testPath = await write('plain.md', ['# T', '', '## Steps', '1. List the repos'].join('\n'));
    const parsed = await parseTestFile(testPath);
    const registry = await buildCodeBehindRegistry(
      {
        steps: parsed.steps,
        rawSteps: parsed.expansion!.rawSteps,
        origins: parsed.expansion!.origins,
        frames: parsed.expansion!.frames,
      },
      { testFilePath: parsed.filePath, onWarn: () => {} },
    );
    const params: Record<string, string> = {};
    await runEntry(registry.bindingFor(0)!, params, ({ step }) => {
      step.setVar('repos', ['a', 'b']);
    });
    expect(params['repos']).toBe('["a","b"]');
  });
});

describe('a caller argument that is an env-data reference', () => {
  // The expander captures the argument TEXT raw — env-data interpolation
  // runs after expansion and never walks frame inputs — so `getVar` must
  // resolve `${data.*}` itself, against the run's context (the bug found
  // 2026-08-25: it returned the literal placeholder text instead).
  const dataCall = ['# T', '', '## Steps', '1. [skill: login username="${data.username}"]'].join('\n');

  it('resolves through the run environment at read time', async () => {
    const [first] = await bindingsFor(dataCall);
    expect(first!.scope.inputs['username']).toBe('${data.username}');

    let seen: string | undefined;
    const outcome = await runCodeBehindEntry({
      binding: { ...first!, entry: { source: first!.source, run: ({ step }) => { seen = step.getVar('username'); } } },
      page: noPage,
      context: noContext,
      browser: noBrowser,
      resolvedParameters: {},
      envData: { env: {}, data: { username: 'alice' }, envName: 'dev' },
      label: 'test',
    });
    expect(outcome.status).toBe('passed');
    expect(seen).toBe('alice');
  });

  it('fails fast, naming the reference, when the run has no environment', async () => {
    const [first] = await bindingsFor(dataCall);
    let seen: string | undefined;
    const outcome = await runCodeBehindEntry({
      binding: { ...first!, entry: { source: first!.source, run: ({ step }) => { seen = step.getVar('username'); } } },
      page: noPage,
      context: noContext,
      browser: noBrowser,
      resolvedParameters: {},
      label: 'test',
    });
    // Never the raw "${data.username}" text into the page — the failure says
    // what is missing instead.
    expect(seen).toBeUndefined();
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/data\.username/);
  });
});

/**
 * `getVar` asks three maps in turn, and a name off `Object.prototype` is a
 * member of none of them.
 *
 * `scope.renames[name]`, `scope.inputs[name]` and `resolvedParameters[name]`
 * are plain-object indexes, so `getVar('constructor')` answered with the
 * `Object` FUNCTION on a step whose scope binds nothing of the sort — into a
 * signature that promises `string | undefined`, and from there into whatever
 * the generated code does with it (`page.fill`, a comparison, a template
 * string). The renames map is asked FIRST, so on the same run a real
 * `[store as: constructor]` capture became unreadable: the prototype answered
 * for the rename, the function took the early return, and the value the step
 * had actually captured was never looked for.
 */
describe('a code-behind variable named after a prototype key', () => {
  /** A top-level step's binding — `{ renames: {}, inputs: {} }`, which is the
   *  scope every one of these names is NOT in. */
  async function topLevel(instruction: string): Promise<CodeBehindBinding> {
    const testPath = await write('proto.md', ['# T', '', '## Steps', `1. ${instruction}`].join('\n'));
    const parsed = await parseTestFile(testPath);
    const registry = await buildCodeBehindRegistry(
      {
        steps: parsed.steps,
        rawSteps: parsed.expansion!.rawSteps,
        origins: parsed.expansion!.origins,
        frames: parsed.expansion!.frames,
      },
      { testFilePath: parsed.filePath, onWarn: () => {} },
    );
    return registry.bindingFor(0)!;
  }

  /** A map that really binds `name` — `defineProperty`, because `__proto__` is
   *  a setter on an object literal and would bind nothing at all. */
  const bound = (name: string, value: string): Record<string, string> =>
    Object.defineProperty({}, name, {
      value, writable: true, enumerable: true, configurable: true,
    }) as Record<string, string>;

  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'answers getVar(%o) with undefined when nothing binds it',
    async (name) => {
      const binding = await topLevel('Read the balance');
      let seen: unknown = 'unset';
      const outcome = await runEntry(binding, {}, ({ step }) => { seen = step.getVar(name); });
      expect(outcome.status).toBe('passed');
      expect(seen).toBeUndefined();
      expect(typeof seen).not.toBe('function');
    },
  );

  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'reads a real [store as: %s] capture rather than the rename map’s prototype',
    async (name) => {
      const binding = await topLevel('Read the balance');
      const params = bound(name, 'ORD-1001');
      let seen: unknown = 'unset';
      const outcome = await runEntry(binding, params, ({ step }) => { seen = step.getVar(name); });
      expect(outcome.status).toBe('passed');
      expect(seen).toBe('ORD-1001');
    },
  );

  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'does not resolve a rename TO %s through the prototype either',
    async (name) => {
      // The caller aliased the skill's declared output onto a variable of
      // that name, so the rename is real and its TARGET is the prototype key.
      // Nothing has written it yet, which is the ordinary state of an output
      // before its step runs.
      const bindings = await bindingsFor(
        ['# T', '', '## Steps', `1. [skill: login username="alice" out.token="${name}"]`].join('\n'),
      );
      const tokenStep = bindings[1]!;
      expect(tokenStep.scope.renames['token']).toBe(name);

      let seen: unknown = 'unset';
      const outcome = await runEntry(tokenStep, {}, ({ step }) => { seen = step.getVar('token'); });
      expect(outcome.status).toBe('passed');
      expect(seen).toBeUndefined();

      // And with the alias actually bound, the value comes back.
      let after: unknown = 'unset';
      await runEntry(tokenStep, bound(name, 'T-1'), ({ step }) => { after = step.getVar('token'); });
      expect(after).toBe('T-1');
    },
  );
});
