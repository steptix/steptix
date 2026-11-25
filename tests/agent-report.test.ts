import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { renderReport, renderStep } from '../src/report/generator.js';
import { placeAgentFiles } from '../src/report/agent-render.js';
import type { AgentStepReport, StepResult, TestReport } from '../src/report/types.js';

/**
 * The report's agent parts (docs/specs/SPEC-use-agent.md §8). The step data
 * is built by hand: it shows how the report renders what a run recorded.
 */

function agent(overrides: Partial<AgentStepReport> = {}): AgentStepReport {
  return {
    scope: { reason: 'prefix' },
    ending: 'done',
    goal: 'Download the March orders report as CSV',
    turns: [
      { turn: 1, kind: 'step', summary: 'step "Click Download CSV"', result: '1 action', durationMs: 2100, ok: true },
      {
        turn: 2,
        kind: 'run',
        summary: 'run python convert.py',
        result: 'exit 0',
        durationMs: 1300,
        ok: true,
        detail: { command: 'python convert.py', folder: '.steptix/agent/run-7', exitCode: 0, output: 'converted 120 rows', allowance: { by: 'allow-list', pattern: 'python *' } },
      },
      { turn: 3, kind: 'done', summary: 'done', result: '2 values', durationMs: 0, ok: true, detail: { values: [{ as: 'report_rows', value: '120' }] } },
    ],
    stored: [
      { name: 'report_xlsx', value: 'exports/orders.xlsx' },
      { name: 'report_rows', value: '120' },
    ],
    files: [{ path: 'convert.py', where: 'workspace', bytes: 512, preview: 'print("hi")' }],
    commandsRun: 1,
    commandsRefused: 0,
    skillsLoaded: [],
    refusals: [],
    tokens: { input: 18000, output: 430, total: 18430 },
    context: { largestRequestTokens: 4100, shrinks: [] },
    ...overrides,
  };
}

function step(overrides: Partial<StepResult> = {}): StepResult {
  return {
    index: 2,
    instruction: '[use agent] Download the March orders report as CSV',
    status: 'passed',
    turns: [],
    durationMs: 41_200,
    retried: false,
    agent: agent(),
    ...overrides,
  };
}

function report(steps: StepResult[], extra: Partial<TestReport> = {}): TestReport {
  return {
    testName: 'Month-end',
    filePath: 'tests/month-end.md',
    tags: [],
    status: steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
    steps,
    totalSteps: steps.length,
    passedSteps: steps.filter((s) => s.status === 'passed').length,
    failedSteps: steps.filter((s) => s.status === 'failed').length,
    totalSubActions: 0,
    durationMs: 1000,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    date: new Date(0).toISOString(),
    ...extra,
  } as TestReport;
}

describe('an agent step (§8.1–§8.4)', () => {
  it('has the badge with its reason, the summary, Stored, a line per turn, Files and Commands', () => {
    const html = renderStep(step());
    expect(html).toContain('class="badge badge-agent" title="This step starts with [use agent]."');
    expect(html).toContain('Done in 3 turns · 1 command · 1 file · 18,430 tokens');
    expect(html).toContain('report_xlsx');
    expect(html).toContain('exports/orders.xlsx');
    expect(html.match(/class="agent-turn[ "]/g)).toHaveLength(3);
    expect(html).toContain('allow list (python *)');
    expect(html).toContain('convert.py');
    expect(html).toContain('1 run · 0 refused');
    // The Captured box is the ordinary step's; an agent step has Stored.
    expect(html).not.toContain('◆ Captured');
  });

  it('names each scope in the badge\'s tooltip', () => {
    expect(renderStep(step({ agent: agent({ scope: { reason: 'section', section: 'Export' } }) }))).toContain(
      'Section &quot;Export&quot; opens with [use agent].',
    );
    expect(renderStep(step({ agent: agent({ scope: { reason: 'file' } }) }))).toContain('agent: on in this file.');
  });

  it('a stuck step shows the reason and refusals in the failure block, and no Stored', () => {
    const error = 'Agent stuck after 5 turns: I could not convert the file.\nSteptix refused 1 action in this step:\n- pip install openpyxl: not in agent.allowCommands';
    const html = renderStep(
      step({
        status: 'failed',
        error,
        agent: agent({ ending: 'stuck', stored: undefined as never, commandsRefused: 1, refusals: [{ what: 'pip install openpyxl', why: 'not in agent.allowCommands', setting: 'agent.allowCommands' }] }),
      }),
    );
    expect(html).toContain('Stuck after 3 turns');
    expect(html).toContain('not in agent.allowCommands');
    expect(html).not.toContain('agent-section-title">Stored');
  });

  it('a passing step with refusals lists them as warnings', () => {
    const html = renderStep(step({ agent: agent({ refusals: [{ what: 'curl x', why: 'not allowed', setting: 'agent.allowCommands' }] }) }));
    expect(html).toContain('⚠ Refusals');
  });

  it('escapes what the agent wrote: a path, a command and notes', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderStep(
      step({
        agent: agent({
          files: [{ path: evil, where: 'workspace', bytes: 1, preview: evil, copy: `x/${evil}` }],
          turns: [{ turn: 1, kind: 'run', summary: `run ${evil}`, result: evil, durationMs: 1, ok: true, notes: evil, detail: { command: evil, output: evil } }],
        }),
      }),
    );
    expect(html).not.toContain('<img src=x');
  });

  it('a link to a file with # or % in its name is URL-encoded', () => {
    const html = renderStep(step({ agent: agent({ files: [{ path: 'a#b.csv', where: 'workspace', bytes: 1, copy: 'r-agent/step-2-1/workspace/100%#.csv' }] }) }));
    expect(html).toContain('href="r-agent/step-2-1/workspace/100%25%23.csv"');
  });

  it('a [no-agent] step in a scope carries the opted-out marker', () => {
    const html = renderStep({ index: 6, instruction: 'Verify the count', status: 'passed', turns: [], durationMs: 1, retried: false, agentOptedOut: true });
    expect(html).toContain('opted out');
  });
});

describe('the run header (§8.7)', () => {
  it('an agent: on file shows the banner, the four stats and the agent steps table, most expensive first', () => {
    const cheap = step({ index: 1, agent: agent({ goal: 'cheap', tokens: { input: 1, output: 1, total: 100 } }) });
    const dear = step({ index: 4, agent: agent({ goal: 'dear', tokens: { input: 1, output: 1, total: 90_000 } }) });
    const plain: StepResult = { index: 6, instruction: 'Verify', status: 'passed', turns: [], durationMs: 1, retried: false, agentOptedOut: true };
    const html = renderReport(report([cheap, dear, plain], { agentFile: true }));
    expect(html).toContain('AGENT: ON');
    expect(html).toContain('2 of its 3 steps did');
    expect(html).toMatch(/<span class="label">Agent<\/span>/);
    expect(html).toMatch(/<span class="label">Refused<\/span>/);
    expect(html.indexOf('>dear<')).toBeLessThan(html.indexOf('>cheap<'));
  });

  it('a run with one [use agent] step and no agent: on has the header but no banner', () => {
    const html = renderReport(report([step()]));
    expect(html).not.toContain('AGENT: ON');
    expect(html).toContain('Agent steps');
  });

  it('a run with no agent step shows none of it', () => {
    const html = renderReport(report([{ index: 1, instruction: 'Click', status: 'passed', turns: [], durationMs: 1, retried: false }]));
    expect(html).not.toContain('Agent steps');
    expect(html).not.toMatch(/<span class="label">Agent<\/span>/);
  });

  it('lists the run\'s approvals, an unanswered question included', () => {
    const html = renderReport(
      report([step()], {
        agentApprovals: [
          { pattern: 'pip install *', answer: 'allow-run', step: 2, at: new Date(0).toISOString() },
          { pattern: 'curl *', answer: 'unanswered', step: 3, at: new Date(0).toISOString() },
        ],
      }),
    );
    expect(html).toContain('Approvals this run');
    expect(html).toContain('pip install * — allowed for the rest of this run · at step 2');
    expect(html).toContain('curl * — nobody answered');
  });
});

describe('files kept beside the report (§8.5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-report-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('copies staged files and logs into <report>-agent/, links them relatively, and removes the staging', () => {
    const staged = path.join(dir, 'staging', 'step-2-1000', 'files', 'workspace', 'convert.py');
    const log = path.join(dir, 'staging', 'step-2-1000', 'commands', 'turn-2.log');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(staged, 'print(1)');
    fs.writeFileSync(log, '$ python convert.py\nok');
    const a = agent({ stageKey: 'step-2-1000', files: [{ path: 'convert.py', where: 'workspace', bytes: 8, copy: staged }] });
    a.turns[1]!.detail!.log = log;
    const r = report([step({ agent: a })]);
    const reportFile = path.join(dir, 'reports', '2026-01-01_00-00-00-month-end.html');
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    placeAgentFiles(r, reportFile);
    const placedFile = r.steps[0]!.agent!.files[0]!.copy!;
    expect(placedFile).toBe('2026-01-01_00-00-00-month-end-agent/step-2-1000/workspace/convert.py');
    expect(fs.readFileSync(path.join(dir, 'reports', placedFile), 'utf8')).toBe('print(1)');
    expect(r.steps[0]!.agent!.turns[1]!.detail!.log).toBe('2026-01-01_00-00-00-month-end-agent/step-2-1000/commands/turn-2.log');
    // The step's staged folder is gone, and the copies beside the report stay.
    expect(fs.existsSync(path.join(dir, 'staging', 'step-2-1000'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'reports', placedFile))).toBe(true);
  });

  it('two runs of the same step (rows, loop passes) keep their own copies', () => {
    const mk = (key: string, body: string): StepResult => {
      const staged = path.join(dir, 'staging', key, 'files', 'workspace', 'out.txt');
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.writeFileSync(staged, body);
      return step({ agent: agent({ stageKey: key, files: [{ path: 'out.txt', where: 'workspace', bytes: 1, copy: staged }] }) });
    };
    const r = report([mk('step-2-1', 'row one'), mk('step-2-2', 'row two')]);
    const reportFile = path.join(dir, 'reports', 'r.html');
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    placeAgentFiles(r, reportFile);
    const [a, b] = r.steps.map((s) => s.agent!.files[0]!.copy!);
    expect(a).not.toBe(b);
    expect(fs.readFileSync(path.join(dir, 'reports', a!), 'utf8')).toBe('row one');
    expect(fs.readFileSync(path.join(dir, 'reports', b!), 'utf8')).toBe('row two');
  });
});
