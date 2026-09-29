import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSelect, exitCodeFor, parseStepRange } from '../src/cli/commands/compile.js';
import { createCli } from '../src/cli/index.js';

/**
 * `steptix compile`'s argument surface (stories/codebehind-compile.md, "What the
 * author runs").
 *
 * The flag parsing is pure and tested directly. The exit codes are driven
 * through the real commander program rather than a spawned process: what is
 * worth proving is that the command is registered, that its options bind, and
 * that a bad invocation exits 1 — all of which the in-process program answers
 * without paying for a Node start and a build.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run the CLI and report what it exited with. `process.exit` is stubbed to
 *  throw so the command unwinds where it would have terminated. */
async function runCli(args: string[]): Promise<{ code: number; stderr: string[] }> {
  const stderr: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(' '));
  });
  let code = 0;
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c ?? 0;
    throw new Error('__exit__');
  }) as never);

  try {
    await createCli().parseAsync(args, { from: 'user' });
  } catch (err) {
    if ((err as Error).message !== '__exit__') throw err;
  }
  return { code, stderr };
}

describe('parseStepRange', () => {
  it('reads a single step, a range, and a comma list', () => {
    expect(parseStepRange('5')).toEqual([5]);
    expect(parseStepRange('3-5')).toEqual([3, 4, 5]);
    expect(parseStepRange('3-5,8')).toEqual([3, 4, 5, 8]);
    expect(parseStepRange(' 8 , 3 - 4 ')).toEqual([3, 4, 8]);
  });

  it('de-duplicates overlapping ranges and sorts them', () => {
    expect(parseStepRange('5,3-6,4')).toEqual([3, 4, 5, 6]);
  });

  it('refuses a backwards range, junk, and an empty spec', () => {
    expect(() => parseStepRange('5-3')).toThrow(/backwards/);
    expect(() => parseStepRange('two')).toThrow(/numbers or ranges/);
    expect(() => parseStepRange(',,')).toThrow(/named no steps/);
  });
});

describe('buildSelect', () => {
  it('maps the flags onto the selection', () => {
    expect(buildSelect({ onlyStale: true })).toEqual({ onlyStale: true });
    expect(buildSelect({ all: true })).toEqual({ all: true });
    expect(buildSelect({ steps: '3-4' })).toEqual({ steps: [3, 4] });
    expect(buildSelect({})).toEqual({});
  });

  it('exits 0 on green, 2 on partial (files written), 1 on failed', () => {
    // A script needs to tell "everything compiled" from "some did" from
    // "nothing did" (stories/codebehind-compile-as-a-run.md §Write what passed).
    expect(exitCodeFor('green')).toBe(0);
    expect(exitCodeFor('partial')).toBe(2);
    expect(exitCodeFor('failed')).toBe(1);
  });

  it('refuses a non-positive --max-rounds', () => {
    expect(() => buildSelect({ maxRounds: 0 })).toThrow(/positive integer/);
    expect(() => buildSelect({ maxRounds: Number.NaN })).toThrow(/positive integer/);
  });
});

describe('the compile command', () => {
  it('is registered with the flags the story names', () => {
    const compile = createCli().commands.find((c) => c.name() === 'compile');
    expect(compile).toBeDefined();
    const flags = compile!.options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining(['--only-stale', '--all', '--steps', '--dry-run', '--max-rounds']),
    );
  });

  it('exits 1 when --only-stale and --all are combined', async () => {
    const { code, stderr } = await runCli(['compile', 'tests/x.md', '--only-stale', '--all']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('pick one');
  });

  it('exits 1 on an unparseable --steps, before touching config or the browser', async () => {
    const { code, stderr } = await runCli(['compile', 'tests/x.md', '--steps', '5-3']);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('backwards');
  });
});
