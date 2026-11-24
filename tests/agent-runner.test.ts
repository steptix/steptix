import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { runAgentStep, type AgentModel, type AgentStepArgs, type AgentRunState } from '../src/agent/runner.js';
import { renderRequest, headAndTail, type AgentContextState } from '../src/agent/context.js';
import { RunApprovals, type ApprovalAsker } from '../src/agent/approvals.js';
import { ensureAgentRun, newAgentRun, withTestAgentLimits } from '../src/agent/host.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { StepResult } from '../src/report/types.js';
import { assertAgentSection } from '../src/config/loader.js';

/**
 * The agent step's loop (docs/specs/SPEC-use-agent.md §5): its endings, the
 * refusals that name their setting (§5.8), the question and what a run
 * remembers (§6.3), and what each turn's request holds (§5.5).
 *
 * Every model reply here is SCRIPTED — constructed, not observed. These cases
 * show how Steptix reacts to a reply; they say nothing about what a model
 * sends.
 */

/** A model that answers from a script and records every request. */
function scripted(replies: Array<string | object>): AgentModel & { requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  let i = 0;
  return {
    requests,
    async complete(messages) {
      requests.push(messages);
      const next = replies[Math.min(i, replies.length - 1)]!;
      i++;
      return { text: typeof next === 'string' ? next : JSON.stringify(next), usage: { inputTokens: 100, outputTokens: 10 } };
    },
  };
}

const textOf = (m: ChatMessage): string =>
  typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');

let root: string;
let run: AgentRunState;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-'));
  run = newAgentRun(root, 'run-test');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function args(model: AgentModel, overrides: Partial<AgentStepArgs> = {}, config: Partial<typeof DEFAULT_CONFIG.agent> = {}): AgentStepArgs {
  const agentConfig = { ...DEFAULT_CONFIG.agent, maxTurns: 6, ...config };
  ensureAgentRun(run, agentConfig);
  const stepped: string[] = [];
  return {
    index: 2,
    instruction: '[use agent] Export the report and store its path in report_file',
    goal: 'Export the report and store its path in report_file',
    scope: { reason: 'prefix' },
    vars: {},
    secrets: [],
    config: agentConfig,
    retries: 1,
    model,
    surface: {
      kind: 'browser',
      observe: async () => ({ kind: 'dom', url: 'https://app.test/reports', snapshot: '- button "Export" [ref=e1]' }),
      step: async (instruction): Promise<StepResult> => {
        stepped.push(instruction);
        return { index: 0, instruction, status: 'passed', turns: [], durationMs: 1, retried: false, aiExplanation: 'clicked' };
      },
    },
    run,
    noAsker: 'CLI',
    stepLabel: 'step 2 of t.md',
    priorSteps: ['Step 1: [✓ PASSED] Navigate to the Reports page'],
    ...overrides,
  };
}

describe('how it ends (§5.3)', () => {
  it('done stores the values the goal names', async () => {
    const vars: Record<string, string> = {};
    const model = scripted([
      { action: 'step', instruction: 'Click the Export button' },
      { action: 'done', values: [{ as: 'report_file', value: 'exports/report.csv' }] },
    ]);
    const out = await runAgentStep(args(model, { vars }));
    expect(out.result.status).toBe('passed');
    expect(vars['report_file']).toBe('exports/report.csv');
    expect(out.result.agent?.ending).toBe('done');
    expect(out.result.agent?.stored).toEqual([{ name: 'report_file', value: 'exports/report.csv' }]);
    expect(out.result.agent?.turns.map((t) => t.kind)).toEqual(['step', 'done']);
  });

  it('a value the goal does not name is not stored, and the model is told', async () => {
    const vars: Record<string, string> = {};
    const model = scripted([
      { action: 'done', values: [{ as: 'something_else', value: 'x' }] },
      { action: 'done', values: [{ as: 'report_file', value: 'r.csv' }] },
    ]);
    const out = await runAgentStep(args(model, { vars }));
    expect(out.result.status).toBe('passed');
    expect(vars['something_else']).toBeUndefined();
    expect(textOf(model.requests[1]![1]!)).toMatch(/does not mention "something_else"/);
  });

  // Seen in a live run (2026-11-24, openai/gpt-6-luna): a goal ending
  // "…in largest_amount." had its done refused, the full stop read as part of
  // a dotted name. The reply below is scripted; the refusal was wrong whatever
  // the model sent.
  it('a name at the end of a sentence is named, and a dotted name still is', async () => {
    const vars: Record<string, string> = {};
    const goal = 'Find the largest debit. Store its merchant in largest_merchant and its id in order.id, then its amount in largest_amount.';
    const model = scripted([
      {
        action: 'done',
        values: [
          { as: 'largest_merchant', value: 'Ada Energy' },
          { as: 'largest_amount', value: '−$140.00' },
          { as: 'order.id', value: '12' },
        ],
      },
    ]);
    const out = await runAgentStep(args(model, { vars, goal, instruction: `[use agent] ${goal}` }));
    expect(out.result.status).toBe('passed');
    expect(vars['largest_amount']).toBe('−$140.00');
    expect(out.result.agent?.stored.map((s) => s.name)).toEqual(['largest_merchant', 'largest_amount', 'order.id']);
  });

  it('a name that only begins a dotted name in the goal is not named', async () => {
    const goal = 'Store the number in order.id';
    const model = scripted([
      { action: 'done', values: [{ as: 'order', value: '12' }] },
      { action: 'done', values: [{ as: 'order.id', value: '12' }] },
    ]);
    const out = await runAgentStep(args(model, { goal, instruction: `[use agent] ${goal}` }));
    expect(out.result.status).toBe('passed');
    expect(textOf(model.requests[1]![1]!)).toMatch(/does not mention "order"/);
  });

  it('stuck fails with the reason, and says files and commands are off', async () => {
    const out = await runAgentStep(args(scripted([{ action: 'stuck', reason: 'The export was emailed instead.' }])));
    expect(out.result.status).toBe('failed');
    expect(out.result.error).toMatch(/^Agent stuck after 1 turn: The export was emailed instead\./);
    expect(out.result.error).toMatch(/Files and commands are off for this project \(agent\.shell\)\./);
  });

  it('running out of turns names agent.maxTurns, and the test that lowered it', async () => {
    let n = 0;
    const model: AgentModel = {
      async complete() {
        n++;
        return { text: JSON.stringify({ action: 'step', instruction: `Click item ${n}` }) };
      },
    };
    const out = await runAgentStep(args(model, { lowered: { maxTurns: true } }, { maxTurns: 3 }));
    expect(out.result.status).toBe('failed');
    expect(out.result.error).toMatch(/did not finish in 3 turns \(agent\.maxTurns, lowered by this test's ## Config\)/);
  });

  it('the same action on an unchanged page three times stops as stuck', async () => {
    const out = await runAgentStep(args(scripted([{ action: 'step', instruction: 'Click Export' }])));
    expect(out.result.agent?.ending).toBe('stalled');
    expect(out.result.error).toMatch(/repeated the same action three times.*step "Click Export"/);
    expect(out.result.agent?.turns).toHaveLength(2);
  });

  it('the time limit ends a step whose model never answers', async () => {
    const model: AgentModel = {
      complete: (_m, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    };
    const out = await runAgentStep(args(model, {}, { timeout: 50 }));
    expect(out.result.agent?.ending).toBe('timeout');
    expect(out.result.error).toMatch(/agent\.timeout/);
  });

  it('Stop interrupts the step', async () => {
    const controller = new AbortController();
    const model: AgentModel = {
      complete: (_m, signal) => {
        controller.abort();
        return Promise.reject(signal?.aborted ? Object.assign(new Error('aborted'), { name: 'AbortError' }) : new Error('x'));
      },
    };
    const out = await runAgentStep(args(model, { signal: controller.signal }));
    expect(out.result.interrupted).toBe(true);
    expect(out.result.agent?.ending).toBe('stopped');
  });

  it('an unusable reply is asked again within execution.retries', async () => {
    const model = scripted(['not json', { action: 'stuck', reason: 'cannot' }]);
    const out = await runAgentStep(args(model));
    expect(out.result.agent?.ending).toBe('stuck');
    expect(textOf(model.requests[1]![1]!)).toMatch(/Your last reply could not be used/);
  });
});

describe('refusals name the setting (§5.8)', () => {
  it('a file or command action with agent.shell off', async () => {
    const out = await runAgentStep(
      args(scripted([{ action: 'run', command: 'node -v' }, { action: 'stuck', reason: 'no shell' }])),
    );
    expect(out.result.error).toMatch(/Steptix refused 1 action in this step:\n- run node -v: files and commands are off for this project \(agent\.shell\)/);
    expect(out.result.agent?.refusals[0]?.setting).toBe('agent.shell');
  });

  it('a command off the allow list with nobody to ask', async () => {
    const out = await runAgentStep(
      args(scripted([{ action: 'run', command: 'curl https://example.test' }, { action: 'stuck', reason: 'blocked' }]), {}, { shell: true }),
    );
    expect(out.result.error).toMatch(
      /curl https:\/\/example\.test: not in agent\.allowCommands, and this run had nobody to ask \(CLI\)\. Add "curl \*" to agent\.allowCommands/,
    );
    expect(out.result.agent?.commandsRefused).toBe(1);
  });

  it('a global install', async () => {
    const out = await runAgentStep(
      args(scripted([{ action: 'run', command: 'npm install -g left-pad' }, { action: 'stuck', reason: 'x' }]), {}, { shell: true }),
    );
    expect(out.result.error).toMatch(/a global install; packages install into the workspace only/);
    expect(out.result.agent?.refusals[0]?.setting).toBeNull();
  });

  it('a path outside the workspace and agent.folders', async () => {
    const out = await runAgentStep(
      args(scripted([{ action: 'read_file', path: path.join(root, 'secret.txt') }, { action: 'stuck', reason: 'x' }]), {}, { shell: true }),
    );
    expect(out.result.error).toMatch(/outside the workspace and the folders in agent\.folders/);
  });

  it('a step that passes despite a refusal keeps it as a warning', async () => {
    const out = await runAgentStep(
      args(
        scripted([
          { action: 'run', command: 'node -v' },
          { action: 'done', values: [{ as: 'report_file', value: 'r' }] },
        ]),
      ),
    );
    expect(out.result.status).toBe('passed');
    expect(out.result.agent?.refusals).toHaveLength(1);
  });
});

describe('the question and what a run remembers (§6.3)', () => {
  const asker = (answers: Array<Awaited<ReturnType<ApprovalAsker['ask']>>>): ApprovalAsker & { asked: string[] } => {
    const asked: string[] = [];
    let i = 0;
    return {
      asked,
      async ask(q) {
        asked.push(q.pattern);
        return answers[Math.min(i++, answers.length - 1)]!;
      },
    };
  };

  it('"Allow for the rest of this run" asks once per pattern across steps of the run', async () => {
    const a = asker([{ answer: 'allow-run' }]);
    const cmd = { action: 'run', command: 'node -e "console.log(1)"' };
    const model1 = scripted([cmd, { action: 'stuck', reason: 'x' }]);
    await runAgentStep(args(model1, { asker: a }, { shell: true, allowCommands: [] }));
    const model2 = scripted([cmd, { action: 'stuck', reason: 'x' }]);
    const second = await runAgentStep(args(model2, { asker: a }, { shell: true, allowCommands: [] }));
    expect(a.asked).toEqual(['node *']);
    expect(second.result.agent?.turns[0]?.detail?.allowance).toEqual({ by: 'remembered', pattern: 'node *' });
  }, 60_000);

  it('a new run asks again', async () => {
    const a = asker([{ answer: 'allow-run' }]);
    const cmd = { action: 'run', command: 'node -e "1"' };
    await runAgentStep(args(scripted([cmd, { action: 'stuck', reason: 'x' }]), { asker: a }, { shell: true, allowCommands: [] }));
    run = newAgentRun(root, 'run-test-2');
    await runAgentStep(args(scripted([cmd, { action: 'stuck', reason: 'x' }]), { asker: a }, { shell: true, allowCommands: [] }));
    expect(a.asked).toEqual(['node *', 'node *']);
  }, 60_000);

  it('an unanswered question denies, and the rest of the run asks nothing', async () => {
    const a = asker([{ closed: 'timeout' }]);
    const out = await runAgentStep(
      args(
        scripted([
          { action: 'run', command: 'curl https://a.test' },
          { action: 'run', command: 'wget https://b.test' },
          { action: 'stuck', reason: 'x' },
        ]),
        { asker: a },
        { shell: true },
      ),
    );
    expect(a.asked).toEqual(['curl *']);
    expect(run.approvals.unanswered).toBe(true);
    expect(out.result.error).toMatch(/nobody answered within agent\.approvalTimeoutMs/);
    expect(out.result.error).toMatch(/an earlier question went unanswered, so this run asks no more/);
  });

  it('computer mode asks nothing', async () => {
    const a = asker([{ answer: 'allow-once' }]);
    const base = args(scripted([{ action: 'run', command: 'curl https://a.test' }, { action: 'stuck', reason: 'x' }]), { asker: a }, { shell: true });
    const out = await runAgentStep({
      ...base,
      surface: { ...base.surface, kind: 'computer', observe: async () => ({ kind: 'screen', imageDataUrl: 'data:image/png;base64,AA==' }) },
    });
    expect(a.asked).toEqual([]);
    expect(out.result.error).toMatch(/computer mode asks no questions/);
  });

  it('a person\'s "Deny once" is named in the failure', async () => {
    const a = asker([{ answer: 'deny-once' }]);
    const out = await runAgentStep(
      args(scripted([{ action: 'run', command: 'curl https://a.test' }, { action: 'stuck', reason: 'x' }]), { asker: a }, { shell: true }),
    );
    expect(out.result.error).toMatch(/you denied it\. To allow it for good, add "curl \*" to agent\.allowCommands/);
  });
});

describe('what each turn sees (§5.5)', () => {
  it('the system prompt and the catalogue are the same bytes every turn', async () => {
    const model = scripted([
      { action: 'step', instruction: 'Click A' },
      { action: 'step', instruction: 'Click B' },
      { action: 'stuck', reason: 'x' },
    ]);
    await runAgentStep(args(model));
    const [first, second] = model.requests;
    expect(first![0]).toEqual(second![0]);
    const block0 = (m: ChatMessage[]): unknown => (m[1]!.content as Array<{ text?: string }>)[0];
    expect(block0(first!)).toEqual(block0(second!));
  });

  it('notes replace and persist, and an old result falls away', async () => {
    const model = scripted([
      { action: 'step', instruction: 'Click A', notes: 'The export is under Reports > Monthly.' },
      { action: 'step', instruction: 'Click B' },
      { action: 'step', instruction: 'Click C', notes: 'Second note.' },
      { action: 'stuck', reason: 'x' },
    ]);
    await runAgentStep(args(model, {}, { historyTurns: 1 }));
    const third = textOf(model.requests[2]![1]!);
    expect(third).toMatch(/The export is under Reports > Monthly\./);
    expect(third).toMatch(/### Turn 2/);
    expect(third).not.toMatch(/### Turn 1/);
    expect(third).toMatch(/1\. step "Click A"/);
    const fourth = textOf(model.requests[3]![1]!);
    expect(fourth).toMatch(/Second note\./);
    expect(fourth).not.toMatch(/Reports > Monthly/);
  });

  // Seen in a live run (2026-11-24): with agent.shell off, the request still
  // told the model which environment variable held the password.
  it('with commands off, no secret is offered as an environment variable', async () => {
    const model = scripted([{ action: 'stuck', reason: 'x' }]);
    await runAgentStep(
      args(model, {
        goal: 'Sign in with {{password}}',
        vars: { password: 'agent-runner-test-password' },
        secrets: ['agent-runner-test-password'],
      }),
    );
    const first = model.requests[0]!.map(textOf).join('\n');
    expect(first).toMatch(/password = \*\*\*/);
    expect(first).not.toMatch(/Secrets for commands|STEPTIX_SECRET_PASSWORD/);
  });

  it('a secret a command prints is masked in the next request', async () => {
    const secret = 'agent-runner-test-token-value';
    const model = scripted([
      { action: 'run', command: 'node -e "console.log(process.env.STEPTIX_SECRET_API_TOKEN)"' },
      { action: 'stuck', reason: 'x' },
    ]);
    const out = await runAgentStep(
      args(model, {
        goal: 'Call the API with {{api_token}}',
        vars: { api_token: secret },
        secrets: [secret],
      }, { shell: true }),
    );
    const second = model.requests[1]!.map(textOf).join('\n');
    expect(second).not.toContain(secret);
    // The shell's own spelling of an environment variable.
    expect(second).toMatch(/\$(?:env:)?STEPTIX_SECRET_API_TOKEN/);
    // The command did print the secret, and it came back masked — not an
    // empty output that would pass the line above on its own.
    expect(second).toMatch(/### Turn 1[\s\S]*\*\*\*/);
    expect(second).toMatch(/api_token = \*\*\*/);
    expect(JSON.stringify(out.result.agent)).not.toContain(secret);
  }, 60_000);

  it('each agent step starts with no log, notes or results', async () => {
    const m1 = scripted([{ action: 'step', instruction: 'Click A', notes: 'remember me' }, { action: 'stuck', reason: 'x' }]);
    await runAgentStep(args(m1));
    const m2 = scripted([{ action: 'stuck', reason: 'x' }]);
    await runAgentStep(args(m2));
    const first = textOf(m2.requests[0]![1]!);
    expect(first).not.toMatch(/remember me/);
    expect(first).not.toMatch(/What you have done/);
  });
});

describe('fitting the request (§5.5)', () => {
  const state = (overrides: Partial<AgentContextState> = {}): AgentContextState => ({
    surface: 'browser',
    shell: { on: false, name: 'sh', runtimes: [] },
    tools: [],
    skills: [],
    priorSteps: [],
    goal: 'Do the thing',
    values: [],
    secretEnv: [],
    folders: [],
    loadedSkills: [],
    log: Array.from({ length: 10 }, (_, i) => `${i + 1}. step "Click ${i}" → passed`),
    notes: '',
    // Each result longer than resultMaxChars, so that after the recent
    // results are cut to one, that one still has to be cut shorter.
    recent: Array.from({ length: 4 }, (_, i) => ({ turn: i + 7, text: 'x'.repeat(12_000) })),
    observation: { kind: 'dom', url: 'u', snapshot: 's' },
    turn: 11,
    maxTurns: 30,
    msLeft: 1000,
    ...overrides,
  });

  it('cuts a long result to its head and tail, saying how much was left out', () => {
    const text = 'a'.repeat(50) + 'b'.repeat(50);
    const cut = headAndTail(text, 20);
    expect(cut.startsWith('a'.repeat(10))).toBe(true);
    expect(cut.endsWith('b'.repeat(10))).toBe(true);
    expect(cut).toMatch(/80 characters left out/);
  });

  it('shrinks in order: fewer recent results, then shorter results, then a folded log', () => {
    const r = renderRequest(state(), { historyTurns: 4, resultMaxChars: 8000, maxContextTokens: 2000 }, []);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.shrinks[0]).toMatch(/recent results cut to the last 3/);
    expect(r.shrinks.some((s) => /results cut to \d+ characters/.test(s))).toBe(true);
    const idxRecent = r.shrinks.findIndex((s) => /recent results/.test(s));
    const idxChars = r.shrinks.findIndex((s) => /characters/.test(s));
    expect(idxRecent).toBeLessThan(idxChars);
  });

  it('fails before the turn when the fixed parts alone are too big, naming the setting', () => {
    const r = renderRequest(state({ goal: 'g'.repeat(40_000) }), { historyTurns: 4, resultMaxChars: 8000, maxContextTokens: 1000 }, []);
    expect('error' in r && r.error).toMatch(/agent\.maxContextTokens \(1000\).*the goal and the steps before it/);
  });
});

describe('settings (§10)', () => {
  it('a test may lower maxTurns and timeout, never raise them', () => {
    const lowered = withTestAgentLimits(DEFAULT_CONFIG.agent, { agentMaxTurns: '5', agentTimeout: '90s' });
    expect(lowered.config.maxTurns).toBe(5);
    expect(lowered.config.timeout).toBe(90_000);
    expect(lowered.lowered).toEqual({ maxTurns: true, timeout: true });
    const raised = withTestAgentLimits(DEFAULT_CONFIG.agent, { agentMaxTurns: '500', agentTimeout: '2h' });
    expect(raised.config.maxTurns).toBe(DEFAULT_CONFIG.agent.maxTurns);
    expect(raised.warnings).toHaveLength(2);
  });

  it('agent.shell must be a JSON boolean', () => {
    expect(() => assertAgentSection({ shell: 'false' }, 'steptix.config.json')).toThrow(/agent\.shell.*true or false/);
    expect(() => assertAgentSection({ allowCommands: 'node *' }, 'steptix.config.json')).toThrow(/agent\.allowCommands/);
    expect(() => assertAgentSection({ shell: true, maxTurns: 10 }, 'steptix.config.json')).not.toThrow();
  });

  it('shell is off by default', () => {
    expect(DEFAULT_CONFIG.agent.shell).toBe(false);
    expect(new RunApprovals().allowed).toEqual([]);
  });
});
