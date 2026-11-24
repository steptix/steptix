/**
 * The report's agent parts (docs/specs/SPEC-use-agent.md §8): a step's header
 * badge and summary line, its body (*Stored*, *What it did*, *Files*,
 * *Commands*, *Skills*, *Refusals*), and the run-level header — the AGENT: ON
 * banner, the extra summary stats, the agent steps table, *Approvals this run*
 * and *Files the agent wrote this run*.
 *
 * Also the one place that moves the agent's staged copies beside the report
 * (§8.5), since only the report writer knows the report's own name.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AgentStepReport, AgentTurnRecord, StepResult, TestReport, TurnResult } from './types.js';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;

/** A relative link: each segment URL-encoded, so `a#b.csv` or `100%.csv`
 *  still opens, then escaped for the attribute. */
function href(rel: string): string {
  return esc(rel.split('/').map(encodeURIComponent).join('/'));
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why the step ran as an agent step: the badge's tooltip (§8.2). */
export function agentReasonText(agent: AgentStepReport): string {
  switch (agent.scope.reason) {
    case 'prefix':
      return 'This step starts with [use agent].';
    case 'section':
      return `Section "${agent.scope.section ?? ''}" opens with [use agent].`;
    case 'main-flow':
      return 'The main flow opens with [use agent].';
    case 'file':
      return 'agent: on in this file.';
  }
}

/** How the step ended, in the summary line's words (§8.2). */
function endingText(agent: AgentStepReport): string {
  const turns = plural(agent.turns.length, 'turn');
  switch (agent.ending) {
    case 'done':
      return `Done in ${turns}`;
    case 'stuck':
      return `Stuck after ${turns}`;
    case 'max-turns':
      return `Out of turns after ${turns}`;
    case 'timeout':
      return `Out of time after ${turns}`;
    case 'stalled':
      return `Stalled after ${turns}`;
    case 'stopped':
      return `Stopped after ${turns}`;
    case 'error':
      return `Failed after ${turns}`;
  }
}

/** The summary line: ending, turns, commands, files, tokens (§8.2). */
export function agentSummaryLine(agent: AgentStepReport): string {
  const parts = [endingText(agent)];
  parts.push(plural(agent.commandsRun, 'command'));
  if (agent.commandsRefused > 0) parts.push(`${agent.commandsRefused} refused`);
  parts.push(plural(agent.files.length, 'file'));
  parts.push(`${agent.tokens.total.toLocaleString('en-AU')} tokens`);
  if (agent.premiumRequests !== undefined) parts.push(plural(agent.premiumRequests, 'premium request'));
  return parts.join(' · ');
}

/** The context tooltip (§8.2): the largest request and any shrinking. */
function contextTooltip(agent: AgentStepReport): string {
  const lines = [`Largest request: about ${agent.context.largestRequestTokens.toLocaleString('en-AU')} tokens`];
  if (agent.tokens.cached !== undefined) lines.push(`Served from the provider's cache: ${agent.tokens.cached.toLocaleString('en-AU')} tokens`);
  if (agent.context.shrinks.length > 0) lines.push(`Shrunk to fit: ${agent.context.shrinks.join('; ')}`);
  return lines.join('\n');
}

/** The header badge (§8.2), or the *opted out* marker (§8.6). */
export function agentBadge(step: StepResult): string {
  if (step.agent) {
    return `<span class="badge badge-agent" title="${esc(agentReasonText(step.agent))}">AGENT</span>`;
  }
  if (step.agentOptedOut) {
    return '<span class="badge badge-agent-out" title="[no-agent]: this step runs as an ordinary step inside an agent scope.">opted out</span>';
  }
  return '';
}

/** How a command came to run, in a few words. */
function allowanceText(detail: NonNullable<AgentTurnRecord['detail']>): string {
  const a = detail.allowance;
  if (!a) return '';
  switch (a.by) {
    case 'allow-list':
      return `allow list (${a.pattern})`;
    case 'remembered':
      return `you allowed "${a.pattern}" for this run`;
    case 'answer':
      return a.answer === 'allow-run'
        ? `you allowed "${a.pattern}" for the rest of this run, at ${new Date(a.at).toLocaleTimeString('en-AU')}`
        : `you allowed it once, at ${new Date(a.at).toLocaleTimeString('en-AU')}`;
    case 'refused':
      return `refused: ${a.why}`;
  }
}

/** One turn's detail, by kind (§8.4). */
function turnDetail(record: AgentTurnRecord): string {
  const d = record.detail;
  const rows: string[] = [];
  const row = (k: string, v: string, pre = false): void => {
    rows.push(`<div class="agent-kv"><span class="agent-k">${esc(k)}</span>${pre ? `<pre class="agent-pre">${esc(v)}</pre>` : `<span class="agent-v">${esc(v)}</span>`}</div>`);
  };
  if (d?.command !== undefined) {
    row('Command', d.command);
    if (d.folder) row('Folder', d.folder);
    const how = allowanceText(d);
    if (how) row('Allowed by', how);
    if (d.exitCode !== undefined) row('Exit code', String(d.exitCode));
    if (d.output !== undefined) {
      row('Output', d.output === '' ? '(none)' : d.output, true);
      if (d.outputBytes !== undefined) row('Size', sizeOf(d.outputBytes));
    }
    if (d.log) rows.push(`<div class="agent-kv"><span class="agent-k"></span><a href="${href(d.log)}">open full log</a></div>`);
  }
  if (d?.path !== undefined && d.command === undefined) row('Path', d.path);
  if (d?.content !== undefined) row(record.kind === 'write_file' ? 'Content' : 'What came back', d.content, true);
  if (d?.tool) {
    row('Tool', d.tool.name);
    row('Arguments', JSON.stringify(d.tool.args, null, 2), true);
    if (Object.keys(d.tool.outputs).length > 0) row('Outputs', Object.entries(d.tool.outputs).map(([k, v]) => `${k} = ${v}`).join('\n'), true);
    if (d.tool.error) row('Error', d.tool.error);
  }
  if (d?.step) {
    row('Step', d.step.instruction);
    row('Result', d.step.status + (d.step.error ? `: ${d.step.error}` : d.step.explanation ? `: ${d.step.explanation}` : ''));
    if (d.step.actions.length > 0) row('Actions', d.step.actions.join('\n'), true);
  }
  if (d?.skill) row('Skill', `${d.skill.name} (${d.skill.path})`);
  if (d?.values) row('Values', d.values.map((v) => `${v.as} = ${v.value}`).join('\n'), true);
  if (d?.reason) row('Reason', d.reason);
  if (record.notes) row('Notes', record.notes, true);
  return rows.join('\n');
}

/**
 * The agent step's body (§8.3): the summary, *Stored* (or nothing, the
 * failure block below taking its place), one line per turn opening to the
 * turn, *Files*, *Commands*, *Skills* and, on a step that passed, the
 * refusals as warnings. `renderTurn` renders a turn's AI block, as for any
 * step.
 */
export function renderAgentBody(step: StepResult, renderTurn: (turn: TurnResult) => string): string {
  const agent = step.agent!;
  const parts: string[] = [];
  parts.push(
    `<div class="agent-summary" title="${esc(contextTooltip(agent))}">${esc(agentSummaryLine(agent))}</div>`,
  );
  if (agent.stored && agent.stored.length > 0) {
    parts.push(
      `<div class="agent-section"><div class="agent-section-title">Stored</div>${agent.stored
        .map((s) => `<div class="agent-kv"><span class="agent-k">${esc(s.name)}</span><span class="agent-v">${esc(s.value)}</span></div>`)
        .join('')}</div>`,
    );
  }
  const turnsByNumber = new Map<number, TurnResult[]>();
  for (const t of step.turns) {
    const list = turnsByNumber.get(t.turnNumber) ?? [];
    list.push(t);
    turnsByNumber.set(t.turnNumber, list);
  }
  const lines = agent.turns.map((record) => {
    const ai = (turnsByNumber.get(record.turn) ?? []).map(renderTurn).join('\n');
    return `<details class="agent-turn${record.ok ? '' : ' agent-turn-bad'}">
      <summary><span class="agent-turn-n">${record.turn}</span><span class="agent-turn-what">${esc(record.summary)}</span><span class="agent-turn-result">${esc(record.result)}</span><span class="agent-turn-time">${seconds(record.durationMs)}</span></summary>
      <div class="agent-turn-body">${turnDetail(record)}${ai}</div>
    </details>`;
  });
  parts.push(`<div class="agent-section"><div class="agent-section-title">What it did</div>${lines.join('\n') || '<div class="agent-none">No turns.</div>'}</div>`);
  if (agent.files.length > 0) {
    parts.push(
      `<div class="agent-section"><div class="agent-section-title">Files</div>${agent.files
        .map((f) => {
          const links = [
            f.preview !== undefined ? `<details class="agent-show"><summary>show</summary><pre class="agent-pre">${esc(f.preview)}</pre></details>` : '',
            f.copy !== undefined ? `<a href="${href(f.copy)}">open copy</a>` : `<span class="agent-none">${esc(f.notCopied ?? 'no copy')}</span>`,
          ].join(' ');
          return `<div class="agent-file"><span class="agent-file-path">${esc(f.path)}</span><span class="agent-file-size">${sizeOf(f.bytes)}</span><span class="agent-file-where">${esc(f.where)}</span>${links}</div>`;
        })
        .join('')}</div>`,
    );
  }
  parts.push(
    `<div class="agent-section"><div class="agent-section-title">Commands</div><div class="agent-v">${agent.commandsRun} run · ${agent.commandsRefused} refused</div></div>`,
  );
  parts.push(
    `<div class="agent-section"><div class="agent-section-title">Skills</div><div class="agent-v">${
      agent.skillsLoaded.length === 0 ? 'none loaded' : agent.skillsLoaded.map((s) => `${esc(s.name)} (${esc(s.path)})`).join(', ')
    }</div></div>`,
  );
  if (step.status === 'passed' && agent.refusals.length > 0) {
    parts.push(
      `<div class="agent-section agent-warnings"><div class="agent-section-title">⚠ Refusals</div>${agent.refusals
        .map((r) => `<div class="agent-v">${esc(r.what)}: ${esc(r.why)}</div>`)
        .join('')}</div>`,
    );
  }
  return `<div class="agent-block">${parts.join('\n')}</div>`;
}

/** The run-level numbers (§8.7): shown only when the run had an agent step. */
export function agentRunStats(steps: readonly StepResult[]): {
  agentSteps: number;
  agentTurns: number;
  agentCommands: number;
  agentRefused: number;
} {
  let agentSteps = 0;
  let agentTurns = 0;
  let agentCommands = 0;
  let agentRefused = 0;
  for (const s of steps) {
    if (!s.agent) continue;
    agentSteps++;
    agentTurns += s.agent.turns.length;
    agentCommands += s.agent.commandsRun;
    agentRefused += s.agent.commandsRefused;
  }
  return { agentSteps, agentTurns, agentCommands, agentRefused };
}

/**
 * The run-level header (§8.7): the banner for `agent: on`, then the agent
 * steps table (most expensive first, each row linked to its step), the
 * approvals and the files. Empty for a run with no agent step, so its report
 * is the one it always was.
 */
export function renderAgentRunHeader(report: TestReport, anchorOf: (step: StepResult) => string): { banner: string; tables: string } {
  const agentSteps = report.steps.filter((s) => s.agent);
  if (agentSteps.length === 0) return { banner: '', tables: '' };
  const plainSteps = report.steps.filter((s) => !s.hookScope && !s.interactiveAdHoc && !s.interactiveChild);
  const banner = report.agentFile
    ? `<div class="agent-banner"><div class="agent-banner-title">AGENT: ON</div>
        <div>This file runs every plain step as an agent step: ${agentSteps.length} of its ${plainSteps.length} steps did.</div>
        <div>Agent steps never compile, so every run of this file asks the model.</div></div>`
    : '';
  const cost = (s: StepResult): number => s.agent!.tokens.total * 1e6 + s.agent!.turns.length * 1e3 + s.durationMs / 1000;
  const rows = [...agentSteps]
    .sort((a, b) => cost(b) - cost(a))
    .map((s) => {
      const a = s.agent!;
      const goal = a.goal.length > 60 ? `${a.goal.slice(0, 57)}…` : a.goal;
      return `<tr><td><a href="#${esc(anchorOf(s))}">Step ${s.index}</a></td><td>${esc(goal)}</td><td>${esc(a.ending)}</td><td>${a.turns.length}</td><td>${a.commandsRun}</td><td>${a.tokens.total.toLocaleString('en-AU')}</td><td>${seconds(s.durationMs)}</td></tr>`;
    })
    .join('');
  const table = `<div class="agent-run-section"><h3>Agent steps</h3><table class="agent-table"><thead><tr><th>Step</th><th>Goal</th><th>Ended</th><th>Turns</th><th>Commands</th><th>Tokens</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const approvals = (report.agentApprovals ?? []).map(
    (a) =>
      `<div class="agent-v">${esc(a.pattern)} — ${
        a.answer === 'allow-run'
          ? 'allowed for the rest of this run'
          : a.answer === 'deny-run'
            ? 'denied for the rest of this run'
            : 'nobody answered; no more questions this run'
      } · at step ${a.step} · ${esc(new Date(a.at).toLocaleTimeString('en-AU'))}</div>`,
  );
  const approvalsHtml = approvals.length > 0 ? `<div class="agent-run-section"><h3>Approvals this run</h3>${approvals.join('')}</div>` : '';
  const files = agentSteps.flatMap((s) => s.agent!.files.map((f) => ({ ...f, step: f.step ?? s.index })));
  const filesHtml =
    files.length > 0
      ? `<div class="agent-run-section"><h3>Files the agent wrote this run</h3>${files
          .map(
            (f) =>
              `<div class="agent-file"><span class="agent-file-path">${esc(f.path)}</span><span class="agent-file-where">${esc(f.where)}</span><span>step ${f.step}</span>${
                f.copy !== undefined ? `<a href="${href(f.copy)}">open copy</a>` : ''
              }</div>`,
          )
          .join('')}</div>`
      : '';
  return { banner, tables: table + approvalsHtml + filesHtml };
}

/**
 * Copy the agent's staged copies and command logs into `<report base>-agent/`
 * beside the report (§8.5), point the report at them by relative path, and
 * remove each step's staged folder once its files are placed. Mutates the
 * report it is given — the masked copy that renders. A copy that cannot be
 * placed keeps no link, and says so. A report rendered again (to add the
 * session video) finds relative paths already, and leaves them as they are.
 */
export function placeAgentFiles(report: TestReport, reportFile: string): void {
  const steps = report.steps.filter((s) => s.agent);
  if (steps.length === 0) return;
  const base = path.basename(reportFile, '.html');
  const dirName = `${base}-agent`;
  const dir = path.join(path.dirname(reportFile), dirName);
  const move = (staged: string, rel: string): string | undefined => {
    if (!path.isAbsolute(staged)) return staged;
    try {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(staged, target);
      return `${dirName}/${rel.split(path.sep).join('/')}`;
    } catch {
      return undefined;
    }
  };
  for (const step of steps) {
    const agent = step.agent!;
    // One folder per run of the step, so rows and loop passes do not
    // overwrite each other's copies.
    const key = agent.stageKey ?? `step-${step.index}`;
    const stagedDirs = new Set<string>();
    for (const f of agent.files) {
      if (f.copy === undefined) continue;
      if (path.isAbsolute(f.copy)) stagedDirs.add(stagedStepDir(f.copy, key));
      const placed = move(f.copy, path.join(key, f.where === 'workspace' ? 'workspace' : 'folders', f.path));
      if (placed === undefined) {
        delete f.copy;
        f.notCopied = 'the copy could not be placed beside the report';
      } else {
        f.copy = placed;
      }
    }
    for (const t of agent.turns) {
      if (t.detail?.log === undefined) continue;
      if (path.isAbsolute(t.detail.log)) stagedDirs.add(stagedStepDir(t.detail.log, key));
      const placed = move(t.detail.log, path.join(key, 'commands', `turn-${t.turn}.log`));
      if (placed === undefined) delete t.detail.log;
      else t.detail.log = placed;
    }
    for (const dir of stagedDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // left behind; harmless
      }
    }
  }
}

/** The staged folder a staged file sits in: the nearest ancestor named
 *  `key`, or the file's own folder when there is none. */
function stagedStepDir(file: string, key: string): string {
  let dir = path.dirname(file);
  while (path.basename(dir) !== key) {
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(file);
    dir = parent;
  }
  return dir;
}

/** The agent parts' styles, appended to the report's own. */
export const AGENT_CSS = `
    .badge-agent { background: #ede9fe; color: #5b21b6; border: 1px solid #ddd6fe; font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; }
    .badge-agent-out { background: #f3f4f6; color: #4b5563; border: 1px solid #e5e7eb; font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; text-transform: none; }
    .agent-block { margin: 8px 0 12px; padding: 10px 14px; border: 1px solid #ddd6fe; border-left: 3px solid #7c3aed; border-radius: 6px; background: #faf5ff; }
    .agent-summary { font-weight: 600; color: #4c1d95; margin-bottom: 8px; }
    .agent-section { margin-top: 8px; }
    .agent-section-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #6d28d9; margin-bottom: 4px; }
    .agent-kv { display: flex; gap: 12px; align-items: baseline; font-size: 0.85rem; }
    .agent-k { min-width: 110px; color: #6b7280; }
    .agent-v { font-size: 0.85rem; }
    .agent-pre { margin: 2px 0; padding: 6px 8px; background: #fff; border: 1px solid #e5e7eb; border-radius: 4px; font-size: 0.78rem; white-space: pre-wrap; max-height: 360px; overflow: auto; flex: 1; }
    .agent-turn > summary { display: flex; gap: 12px; cursor: pointer; font-size: 0.85rem; padding: 2px 0; }
    .agent-turn-n { min-width: 22px; color: #6b7280; text-align: right; }
    .agent-turn-what { flex: 1; font-family: 'Cascadia Code', 'Consolas', monospace; }
    .agent-turn-result { color: #374151; }
    .agent-turn-bad .agent-turn-result { color: var(--fail); }
    .agent-turn-time { color: #6b7280; min-width: 50px; text-align: right; }
    .agent-turn-body { margin: 4px 0 8px 34px; }
    .agent-file { display: flex; gap: 12px; font-size: 0.85rem; align-items: baseline; }
    .agent-file-path { font-family: 'Cascadia Code', 'Consolas', monospace; min-width: 200px; }
    .agent-file-size, .agent-file-where { color: #6b7280; }
    .agent-none { color: #9ca3af; font-size: 0.85rem; }
    .agent-warnings .agent-v { color: #92400e; }
    .agent-banner { margin: 0 0 16px; padding: 10px 14px; border: 1px solid #ddd6fe; border-left: 3px solid #7c3aed; border-radius: 6px; background: #faf5ff; color: #4c1d95; font-size: 0.9rem; }
    .agent-banner-title { font-weight: 700; letter-spacing: 0.05em; }
    .agent-run-section { margin: 0 0 16px; }
    .agent-run-section h3 { font-size: 0.95rem; margin: 0 0 6px; }
    .agent-table { border-collapse: collapse; font-size: 0.85rem; width: 100%; }
    .agent-table th, .agent-table td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #e5e7eb; }
    .stat-agent { color: #6d28d9; }
`;
