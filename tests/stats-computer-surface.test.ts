/**
 * The scoreboard on the computer surface (docs/specs/SPEC-scoreboard.md §5.2,
 * §5.4, §7.1): the real `executeComputerStep` over `FakeDesktopAdapter`, with
 * a scripted model, recording into a temporary user root.
 *
 * Three facts the page surface has too, each measured here on its own path:
 * a Stop is reported as one (`interrupted`, one attempt, the answered call
 * counted); a turn a throw cut short still counts the call it made and the
 * action it ran; and a `holds: false` verdict is an assertion that failed, not
 * a concession.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiClient } from '../src/ai/client.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { FakeDesktopAdapter } from '../src/desktop/fake-adapter.js';
import { executeComputerStep, type ComputerStepOptions } from '../src/runner/computer-step.js';
import { openRunStats, type RunStats } from '../src/runner/run-stats.js';
import { flushStatsWrites, readStatsLines } from '../src/stats/store.js';
import type { StatsActionLine, StatsStepLine } from '../src/stats/types.js';
import type { UserRootDeps } from '../src/env/user-root.js';

const GRAB = { width: 800, height: 600 } as const;

let tmp: string;
let deps: UserRootDeps;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-stats-computer-')));
  deps = { env: { LOCALAPPDATA: tmp, XDG_CONFIG_HOME: tmp }, platform: process.platform };
});

afterEach(async () => {
  await flushStatsWrites();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function opts(adapter: FakeDesktopAdapter, client: unknown, stats: RunStats, over: Partial<ComputerStepOptions> = {}): ComputerStepOptions {
  return {
    page: undefined as never,
    config: {
      ...DEFAULT_CONFIG,
      ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: true },
      execution: { ...DEFAULT_CONFIG.execution, retries: 1, maxTurns: 4, promptOnAmbiguity: true },
      logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
    } as Config,
    aiClient: client as AiClient,
    contextContent: '',
    testName: `stats-computer-${Math.random()}`,
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
    nonInteractive: true,
    computer: { adapter, settleMs: 0, maxImageWidth: 400, reportScreenshots: false },
    stats,
    ...over,
  } as ComputerStepOptions;
}

const usage = { inputTokens: 1500, outputTokens: 30 };

async function written() {
  await flushStatsWrites();
  const { lines } = await readStatsLines({ deps });
  return {
    steps: lines.filter((l): l is StatsStepLine => l.kind === 'step'),
    actions: lines.filter((l): l is StatsActionLine => l.kind === 'action'),
  };
}

describe('the computer surface on the scoreboard', () => {
  it('a Stop after the model answered: interrupted, one attempt, and the answered call counted', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const controller = new AbortController();
    const client = {
      complete: async () => {
        controller.abort();
        return { text: '{"action":"click","x":10,"y":10,"description":"Click"}', model: 'fake-model', usage };
      },
    };
    const stats = openRunStats({ projectRoot: tmp, deps });
    const result = await executeComputerStep(1, 1, 'Click Save', opts(adapter, client, stats, { signal: controller.signal }));

    expect(result).toMatchObject({ status: 'failed', interrupted: true, retried: false, error: 'Aborted by client' });
    expect(adapter.callsOf('click')).toHaveLength(0);
    const { steps } = await written();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ interrupted: true, attempts: 1, calls: 1, tokensIn: 1500, model: 'fake-model' });
    expect(stats.tally).toMatchObject({ steps: 1, failed: 0 });
  });

  it('a turn a throw cut short: the call it made and the action it ran are on the record', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const client = {
      complete: async () => {
        // The capture after the click fails — out of the turn, mid-turn.
        adapter.setGrabError(new Error('screen capture failed'));
        return { text: '{"action":"click","x":10,"y":10,"description":"Click"}', model: 'fake-model', usage };
      },
    };
    const stats = openRunStats({ projectRoot: tmp, deps });
    const result = await executeComputerStep(1, 1, 'Click Save', opts(adapter, client, stats));

    expect(result.status).toBe('failed');
    expect(result.error).toContain('screen capture failed');
    // The click ran — on the real screen, so the step is not retried.
    expect(adapter.callsOf('click')).toHaveLength(1);
    expect(result.turns).toHaveLength(1);
    const { steps, actions } = await written();
    expect(steps[0]).toMatchObject({ status: 'failed', attempts: 1, calls: 1, tokensIn: 1500 });
    expect(actions.map((a) => [a.action, a.outcome])).toEqual([['click', 'ok']]);
  });

  it('a verdict that does not hold is assert-failed — on this surface it is the model judging the screen', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const client = {
      complete: async () => ({
        text: '{"action":"assert","condition":"the result shows 2","holds":false,"evidence":"it shows 3","description":"Check"}',
        model: 'fake-model',
        usage,
      }),
    };
    const stats = openRunStats({ projectRoot: tmp, deps });
    const result = await executeComputerStep(1, 1, 'Check the result is 2', opts(adapter, client, stats));
    expect(result.status).toBe('failed');
    const { actions } = await written();
    expect(actions.map((a) => [a.action, a.outcome])).toContainEqual(['assert', 'assert-failed']);
  });
});
