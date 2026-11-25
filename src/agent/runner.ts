/**
 * Running one agent step (docs/specs/SPEC-use-agent.md §5): a loop of turns,
 * each one fresh request (§5.5) answered with ONE action (§5.2), until the
 * model says `done` or `stuck`, or a limit ends it (§5.3).
 *
 * Shared by every step loop that runs agent steps. What differs between them
 * — how an ordinary step is carried out on the surface, how a project tool is
 * called, who can answer a question — is handed in, so this module never
 * imports a browser, a server or the executor.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentConfig } from '../config/types.js';
import type {
  AgentCommandAllowance,
  AgentEnding,
  AgentFileRecord,
  AgentRefusal,
  AgentStepReport,
  AgentStepScope,
  AgentTurnRecord,
  AiInteraction,
  StepResult,
  TurnResult,
} from '../report/types.js';
import type { ChatMessage } from '../ai/types.js';
import { contentBlocksToText, maskValueForPrompt } from '../ai/prompts.js';
import { bindVariable } from '../parser/parameters.js';
import { isSecretParameterName, MASK, redact, redactDeep } from '../utils/secrets.js';
import { logger } from '../utils/logger.js';
import { parseAgentReply, actionKey, SHELL_ACTION_KINDS, type AgentAction } from './reply.js';
import {
  renderRequest,
  fixedPartsTokens,
  headAndTail,
  type AgentObservation,
  type AgentToolInfo,
  type RecentResult,
} from './context.js';
import {
  commandParts,
  displayFolder,
  uncheckableReason,
  isGlobalInstall,
  matchingPattern,
  patternFor,
  runCommand,
  scrubbedEnv,
  secretEnvName,
  shellFor,
} from './commands.js';
import type { ApprovalAsker, RunApprovals } from './approvals.js';
import {
  displayPath,
  fileStates,
  resolveAgentPath,
  whereOf,
  writableRoots,
  SKIPPED_DIRS,
  type AgentWorkspace,
} from './workspace.js';
import { findSkill, loadSkillBody, type AgentSkill } from './skills.js';

/** The one method of the AI client an agent step needs. */
export interface AgentModel {
  complete(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<{ text: string; model?: string | undefined; usage?: AiInteraction['usage'] }>;
}

/** The surface the step runs on, as the loop hands it over. */
export interface AgentSurface {
  kind: 'browser' | 'computer';
  observe(signal?: AbortSignal): Promise<AgentObservation>;
  /** Carry out one ordinary step on this surface (`step` action). */
  step(instruction: string, signal?: AbortSignal): Promise<StepResult>;
}

/** Project tools, as the loop hands them over. */
export interface AgentToolbox {
  list(): Promise<AgentToolInfo[]>;
  call(
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; outputs: Record<string, string>; error?: string }>;
}

/**
 * What one run keeps across its agent steps (§6.2, §6.3, §7): the workspace,
 * the remembered answers, the skills found at the first agent step, and where
 * the report's copies are staged. The CLI holds one per run. The server holds
 * one per `agentRunId` (`SessionManager.agentRuns`), outliving the sessions a
 * row loop recycles, or, for a batch without one, on the session until the
 * next `runStart`. The run's file list (§8.7) is built by the report from each
 * step's own *Files*.
 */
export interface AgentRunState {
  runId: string;
  projectRoot: string;
  approvals: RunApprovals;
  workspace?: AgentWorkspace;
  skills?: { list: AgentSkill[]; warnings: string[] };
  /** Where file copies and command logs are staged until the report is
   *  written beside them (§8.5). Outside the workspace, which is removed. */
  stagingDir: string;
}

export interface AgentStepArgs {
  /** 1-based, like every `StepResult.index`. */
  index: number;
  /** The step as authored — what the report shows. */
  instruction: string;
  /** The goal the model works towards: the text after `[use agent]`, or the
   *  whole step in a scope. */
  goal: string;
  scope: AgentStepScope;
  /** The live variable map: read for `## Values`, written by `done`. */
  vars: Record<string, string>;
  /** The run's mask set (`secretsNow()`). */
  secrets: readonly string[];
  unmask?: ReadonlySet<string> | undefined;
  /** The effective agent settings, a test's lowering applied. */
  config: AgentConfig;
  /** Which limits the test's `## Config` lowered, for the failure (§5.8). */
  lowered?: { maxTurns?: boolean; timeout?: boolean } | undefined;
  /** `execution.retries`: an unusable reply is asked again within it. */
  retries: number;
  model: AgentModel;
  surface: AgentSurface;
  tools?: AgentToolbox | undefined;
  run: AgentRunState;
  /** Present only when someone can answer a question (§6.3). */
  asker?: ApprovalAsker | undefined;
  /** Why nobody can be asked, when `asker` is absent: `CLI`, `MCP`, … */
  noAsker: string;
  /** The step as a person knows it, e.g. `step 2 of month-end.md`. */
  stepLabel: string;
  /** One line per earlier step (`formatStepHistoryEntry`). */
  priorSteps: string[];
  signal?: AbortSignal | undefined;
  /** Called as each turn ends, for the live run panel (§8.8). */
  onTurn?: ((turn: AgentTurnRecord, progress: { turn: number; maxTurns: number }) => void) | undefined;
  /** Called while a question waits, and when it closes (§6.3). */
  onWaiting?: ((waiting: boolean) => void) | undefined;
  /** Is the AI route the Copilot bridge, where each model call is a premium
   *  request (§9)? No loop sets it yet: a `gateway/` model names any gateway,
   *  not the bridge, and a wrong count is worse than none (§16.2). */
  premiumRoute?: boolean | undefined;
  /** For tests: the platform the shell is picked for. */
  platform?: NodeJS.Platform | undefined;
  /** For tests: the clock. */
  now?: (() => number) | undefined;
}

export interface AgentStepOutcome {
  result: StepResult;
  /** Values `done` stored, unmasked, for the loop's capture events. */
  stored: Array<{ name: string; value: string }>;
}

/** Runtimes the system prompt names on every turn (§6.3). Node always is:
 *  Steptix runs on it. */
let runtimesCache: string[] | undefined;
function runtimesOnPath(): string[] {
  if (runtimesCache) return runtimesCache;
  const found = ['node'];
  const pathDirs = (process.env['PATH'] ?? process.env['Path'] ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const name of ['python3', 'python', 'py']) {
    const hit = pathDirs.some((d) =>
      exts.some((ext) => {
        const file = path.join(d, name + ext);
        // The Microsoft Store's python stubs open the Store instead of running.
        if (/WindowsApps/i.test(d)) return false;
        try {
          return fs.statSync(file).isFile();
        } catch {
          return false;
        }
      }),
    );
    if (hit) found.push(name);
  }
  runtimesCache = found;
  return found;
}

/** Placeholders the goal refers to, in order, once each. */
function placeholdersIn(goal: string): string[] {
  const out: string[] = [];
  for (const m of goal.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/**
 * A file's text, or undefined for a binary file. UTF-16 with a byte order
 * mark is text — Windows PowerShell's `>` and `Out-File` write it — and is
 * decoded, so it can be read back and masked rather than passed on as bytes.
 */
export function decodeText(buf: Buffer): string | undefined {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    // `swap16` needs an even length; a trailing odd byte is not a character.
    const swapped = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.subarray(0, 8192).includes(0)) return undefined;
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** A text file's whole content, masked, for the report's *show*. Undefined for
 *  a binary file or one over 64 KB. */
function previewOf(file: string, secrets: readonly string[]): string | undefined {
  try {
    const st = fs.statSync(file);
    if (st.size > 64 * 1024) return undefined;
    const text = decodeText(fs.readFileSync(file));
    return text === undefined ? undefined : redact(text, [...secrets]);
  } catch {
    return undefined;
  }
}

/** Stage a copy of `file` for the report (§8.5), masked when it is text —
 *  a text copy is written as UTF-8, whatever the file's own encoding. A binary
 *  file is copied as it is, since no mask can be applied to bytes. Returns the
 *  staged path, or why none was kept. */
function stageCopy(
  file: string,
  stageDir: string,
  rel: string,
  maxBytes: number,
  secrets: readonly string[],
): { copy?: string; notCopied?: string } {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) {
      return { notCopied: `${st.size} bytes, over agent.reportFileMaxBytes (${maxBytes})` };
    }
    const target = path.join(stageDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const buf = fs.readFileSync(file);
    const text = decodeText(buf);
    if (text === undefined) fs.writeFileSync(target, buf);
    else fs.writeFileSync(target, redact(text, [...secrets]));
    return { copy: target };
  } catch (err) {
    return { notCopied: `could not copy: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Inline output as the report shows it: whole up to 20 KB, else the first
 *  and last 10 KB (§8.5). */
function inlineOutput(text: string): string {
  const limit = 20 * 1024;
  if (text.length <= limit) return text;
  const half = 10 * 1024;
  return `${text.slice(0, half)}\n… [${text.length - 2 * half} characters cut — open full log] …\n${text.slice(-half)}`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The §5.8 lines after a failure's reason. */
export function refusalLines(refusals: readonly AgentRefusal[], shellOn: boolean): string {
  if (refusals.length === 0) {
    return shellOn ? '' : '\nFiles and commands are off for this project (agent.shell).';
  }
  return (
    `\nSteptix refused ${plural(refusals.length, 'action')} in this step:\n` +
    refusals.map((r) => `- ${r.what}: ${r.why}`).join('\n')
  );
}

export async function runAgentStep(args: AgentStepArgs): Promise<AgentStepOutcome> {
  const now = args.now ?? Date.now;
  const startedAt = now();
  const cfg = args.config;
  const secrets = [...args.secrets];
  const mask = (text: string): string => redact(text, secrets);
  const turns: TurnResult[] = [];
  const records: AgentTurnRecord[] = [];
  const refusals: AgentRefusal[] = [];
  const recent: RecentResult[] = [];
  const log: string[] = [];
  const loadedSkills: Array<{ name: string; body: string; path: string }> = [];
  const shrinksSeen: string[] = [];
  let notes = '';
  let largestRequest = 0;
  let commandsRun = 0;
  let commandsRefused = 0;
  const tokens = { input: 0, output: 0, cached: 0, total: 0 };
  const shellOn = cfg.shell === true;
  /** One folder per run of the step, so a step that runs once per row or
   *  loop pass keeps each pass's copies apart (§8.5). */
  const stageKey = `step-${args.index}-${startedAt}`;
  const stageDir = path.join(args.run.stagingDir, stageKey);

  // ── The deadline and the stop signal, combined ─────────────────────────
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(1, cfg.timeout));
  const signal = args.signal ? AbortSignal.any([args.signal, deadline.signal]) : deadline.signal;
  const stoppedByPerson = (): boolean => args.signal?.aborted === true;

  // ── Values the goal refers to (§5.5 part 4), and secrets by name (§6.4) ─
  const values: string[] = [];
  const secretEnv: Array<{ name: string; env: string }> = [];
  const secretVars: Record<string, string> = {};
  for (const name of placeholdersIn(args.goal)) {
    const value = args.vars[name];
    if (value === undefined) continue;
    const byName = isSecretParameterName(name, args.vars);
    const shown = maskValueForPrompt(byName, name, value, args.unmask, secrets);
    values.push(`${name} = ${shown}`);
    if (shown.includes(MASK) && shown !== value) {
      secretEnv.push({ name, env: secretEnvName(name) });
      secretVars[name] = value;
    }
  }

  // ── The workspace and skills `ensureAgentRun` made for the run ─────────
  const ws = args.run.workspace;
  const skills = args.run.skills?.list ?? [];
  const toolList = args.tools ? await args.tools.list().catch(() => [] as AgentToolInfo[]) : [];
  const filesBefore = new Map<string, string>();
  if (shellOn && ws) for (const root of writableRoots(ws)) for (const [k, v] of fileStates(root)) filesBefore.set(k, v);

  const shell = shellFor(args.platform);
  const shellInfo = { on: shellOn, name: shell.name, runtimes: shellOn ? runtimesOnPath() : [] };

  /** Record a refusal and say it back to the model, naming the setting. */
  const refuse = (what: string, why: string, setting: string | null): string => {
    refusals.push({ what: mask(what), why: mask(why), setting });
    return `Refused: ${why}`;
  };

  let ending: AgentEnding = 'max-turns';
  let reason: string | undefined;
  let stored: Array<{ name: string; value: string }> = [];
  let lastKey = '';
  let repeats = 0;
  let stallAction = '';

  const finish = (): AgentStepOutcome => {
    clearTimeout(timer);
    // Files the agent created or changed (§8.3): what differs from the start.
    const files: AgentFileRecord[] = [];
    if (shellOn && ws) {
      for (const root of writableRoots(ws)) {
        for (const [file, state] of fileStates(root)) {
          if (filesBefore.get(file) === state) continue;
          const rel = displayPath(ws, file);
          const where = whereOf(ws, file);
          let bytes = 0;
          try {
            bytes = fs.statSync(file).size;
          } catch {
            continue;
          }
          const staged = stageCopy(file, path.join(stageDir, 'files', where === 'workspace' ? 'workspace' : 'folders'), rel, cfg.reportFileMaxBytes, secrets);
          const preview = previewOf(file, secrets);
          files.push({
            path: rel,
            where,
            bytes,
            step: args.index,
            ...(staged.copy !== undefined && { copy: staged.copy }),
            ...(staged.notCopied !== undefined && { notCopied: staged.notCopied }),
            ...(preview !== undefined && { preview }),
          });
        }
      }
    }
    const report: AgentStepReport = {
      stageKey,
      scope: args.scope,
      ending,
      goal: mask(args.goal),
      turns: records,
      ...(ending === 'done' && { stored: stored.map((s) => ({ name: s.name, value: mask(s.value) })) }),
      ...(reason !== undefined && { reason: mask(reason) }),
      files,
      commandsRun,
      commandsRefused,
      skillsLoaded: loadedSkills.map((s) => ({ name: s.name, path: s.path })),
      refusals,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        total: tokens.total,
        ...(tokens.cached > 0 && { cached: tokens.cached }),
      },
      context: { largestRequestTokens: largestRequest, shrinks: [...new Set(shrinksSeen)] },
      ...(args.premiumRoute && { premiumRequests: turns.length }),
    };
    const durationMs = now() - startedAt;
    const turnCount = records.length;
    const base = {
      index: args.index,
      instruction: args.instruction,
      turns,
      durationMs,
      retried: false,
      agent: report,
    };
    if (ending === 'done') {
      return {
        result: {
          ...base,
          status: 'passed',
          ...(stored.length > 0 && {
            outputs: Object.fromEntries(stored.filter((s) => !s.name.startsWith('__macro')).map((s) => [s.name, s.value])),
          }),
          aiExplanation: `Agent done in ${plural(turnCount, 'turn')}` + (refusals.length > 0 ? ` (${plural(refusals.length, 'refusal')})` : ''),
        },
        stored,
      };
    }
    if (ending === 'stopped') {
      return {
        result: {
          ...base,
          status: 'failed',
          interrupted: true,
          error: 'Aborted by client',
          aiExplanation: 'Step aborted by client (run stopped).',
        },
        stored: [],
      };
    }
    const head =
      ending === 'stuck'
        ? `Agent stuck after ${plural(turnCount, 'turn')}: ${reason ?? 'no reason given'}`
        : ending === 'max-turns'
          ? `The agent did not finish in ${plural(cfg.maxTurns, 'turn')} (agent.maxTurns${args.lowered?.maxTurns ? ', lowered by this test\'s ## Config' : ''}).`
          : ending === 'timeout'
            ? `The agent did not finish within ${Math.round(cfg.timeout / 1000)} s (agent.timeout${args.lowered?.timeout ? ', lowered by this test\'s ## Config' : ''}).`
            : ending === 'stalled'
              ? `The agent repeated the same action three times on an unchanged page and was stopped as stuck: ${stallAction}`
              : (reason ?? 'The agent step failed.');
    const error = mask(head + refusalLines(refusals, shellOn));
    return {
      result: { ...base, status: 'failed', error, aiExplanation: error },
      stored: [],
    };
  };

  // ── The turns ───────────────────────────────────────────────────────────
  try {
    for (let turn = 1; turn <= cfg.maxTurns; turn++) {
      if (stoppedByPerson()) {
        ending = 'stopped';
        return finish();
      }
      if (deadline.signal.aborted) {
        ending = 'timeout';
        return finish();
      }

      let observation: AgentObservation;
      try {
        observation = await args.surface.observe(signal);
      } catch (err) {
        observation = { kind: 'none', note: `The surface could not be read: ${err instanceof Error ? err.message : String(err)}` };
      }

      // Ask, within execution.retries, for an action we can use.
      let action: AgentAction | undefined;
      let retryNote: string | undefined;
      const attempts = Math.max(0, Math.floor(args.retries)) + 1;
      for (let attempt = 1; attempt <= attempts && action === undefined; attempt++) {
        const rendered = renderRequest(
          {
            surface: args.surface.kind,
            shell: shellInfo,
            tools: toolList,
            skills: skills.map((s) => ({ name: s.name, description: s.description })),
            priorSteps: args.priorSteps,
            goal: args.goal,
            values,
            secretEnv,
            ...(shellOn && ws !== undefined && { workspace: ws.dir }),
            folders: shellOn && ws ? ws.folders : [],
            loadedSkills,
            log,
            notes: retryNote ? `${notes}\n\nYour last reply could not be used: ${retryNote}. Answer with one JSON action.`.trim() : notes,
            recent,
            observation,
            turn,
            maxTurns: cfg.maxTurns,
            msLeft: Math.max(0, startedAt + cfg.timeout - now()),
          },
          { historyTurns: cfg.historyTurns, resultMaxChars: cfg.resultMaxChars, maxContextTokens: cfg.maxContextTokens },
          secrets,
        );
        if ('error' in rendered) {
          ending = 'error';
          reason = rendered.error;
          return finish();
        }
        largestRequest = Math.max(largestRequest, rendered.tokens);
        if (rendered.shrinks.length > 0) {
          shrinksSeen.push(...rendered.shrinks);
          logger.info(`[use agent] step ${args.index} turn ${turn}: ${rendered.shrinks.join('; ')}`);
        }
        const timestamp = new Date().toISOString();
        let completion: Awaited<ReturnType<AgentModel['complete']>>;
        try {
          completion = await args.model.complete(rendered.messages, signal);
        } catch (err) {
          if (stoppedByPerson()) {
            ending = 'stopped';
            return finish();
          }
          if (deadline.signal.aborted) {
            ending = 'timeout';
            return finish();
          }
          const e = err instanceof Error ? err : new Error(String(err));
          if (['AiNotConfiguredError', 'AiForbiddenByPolicyError', 'GatewayUrlRequiredError'].includes(e.name)) {
            ending = 'error';
            reason = e.message;
            return finish();
          }
          retryNote = undefined;
          if (attempt === attempts) {
            ending = 'error';
            reason = `The model call failed: ${e.message}`;
            return finish();
          }
          continue;
        }
        const usage = completion.usage;
        if (usage) {
          tokens.input += usage.inputTokens;
          tokens.output += usage.outputTokens;
          tokens.total += usage.inputTokens + usage.outputTokens;
          if (typeof usage.cachedInputTokens === 'number') tokens.cached += usage.cachedInputTokens;
        }
        turns.push({
          turnNumber: turn,
          attemptNumber: attempt,
          timestamp,
          aiInteractions: [
            {
              purpose: 'agent',
              attemptNumber: attempt,
              requestMessages: rendered.messages.map((m) => ({ role: m.role, content: contentBlocksToText(m.content) })),
              response: completion.text,
              ...(completion.model !== undefined && { model: completion.model }),
              ...(usage !== undefined && { usage }),
              timestamp,
            } as AiInteraction,
          ],
          subActions: [],
        });
        const reply = parseAgentReply(completion.text);
        if (reply.kind === 'malformed') {
          retryNote = reply.why;
          if (attempt === attempts) {
            ending = 'error';
            reason = `The agent's reply could not be used: ${reply.why}`;
            return finish();
          }
          continue;
        }
        action = reply.action;
        if (reply.notes !== undefined) notes = reply.notes;
      }
      if (action === undefined) {
        ending = 'error';
        reason = 'The agent gave no usable action.';
        return finish();
      }

      // The stall rule (§5.3): the same action on an unchanged observation.
      // The whole observation is hashed: a page that changed only in the
      // middle ("Page 2 of 5" → "Page 3 of 5") is progress, not a repeat.
      const observed = observation.kind === 'dom' ? `${observation.url}\n${observation.snapshot}` : observation.kind === 'screen' ? observation.imageDataUrl : observation.note;
      const key = `${actionKey(action)}\u0000${createHash('sha256').update(observed).digest('hex')}`;
      repeats = key === lastKey ? repeats + 1 : 1;
      lastKey = key;
      if (repeats >= 3) {
        ending = 'stalled';
        stallAction = summarise(action);
        return finish();
      }

      const turnStarted = now();
      const outcome = await perform(action, turn);
      const record: AgentTurnRecord = {
        turn,
        kind: action.action,
        summary: mask(summarise(action)),
        result: mask(outcome.short),
        durationMs: now() - turnStarted,
        ok: outcome.ok,
        ...(notes !== '' && { notes: mask(notes) }),
        ...(outcome.detail !== undefined && { detail: outcome.detail }),
      };
      records.push(record);
      log.push(`${turn}. ${record.summary} → ${record.result}${record.durationMs >= 100 ? ` (${(record.durationMs / 1000).toFixed(1)} s)` : ''}`);
      if (outcome.full !== undefined) recent.push({ turn, text: outcome.full });
      args.onTurn?.(record, { turn, maxTurns: cfg.maxTurns });

      if (outcome.end) {
        ending = outcome.end;
        return finish();
      }
      if (stoppedByPerson()) {
        ending = 'stopped';
        return finish();
      }
    }
    ending = deadline.signal.aborted ? 'timeout' : 'max-turns';
    return finish();
  } finally {
    clearTimeout(timer);
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  function summarise(action: AgentAction): string {
    switch (action.action) {
      case 'step':
        return `step "${action.instruction}"`;
      case 'tool':
        return `tool ${action.name}`;
      case 'read_file':
        return `read_file ${action.path}${action.offset ? ` from ${action.offset}` : ''}`;
      case 'write_file':
        return `write_file ${action.path}`;
      case 'list_dir':
        return `list_dir ${action.path}`;
      case 'run':
        return `run ${action.command}`;
      case 'load_skill':
        return `load_skill ${action.name}`;
      case 'done':
        return 'done';
      case 'stuck':
        return 'stuck';
    }
  }

  interface Performed {
    ok: boolean;
    /** The result in a few words, for the log line. */
    short: string;
    /** The full result for *Recent results*, unmasked (the request masks). */
    full?: string;
    detail?: AgentTurnRecord['detail'];
    end?: AgentEnding;
  }

  async function perform(action: AgentAction, turn: number): Promise<Performed> {
    if (SHELL_ACTION_KINDS.has(action.action) && !shellOn) {
      const said = refuse(summarise(action), 'files and commands are off for this project (agent.shell)', 'agent.shell');
      return { ok: false, short: 'refused: agent.shell is off', full: said };
    }
    switch (action.action) {
      case 'done':
        return performDone(action.values);
      case 'stuck':
        reason = action.reason;
        return { ok: true, short: action.reason, detail: { reason: mask(action.reason) }, end: 'stuck' };
      case 'step':
        return performStep(action.instruction);
      case 'tool':
        return performTool(action.name, action.args);
      case 'load_skill':
        return performLoadSkill(action.name);
      case 'read_file':
        return performRead(action.path, action.offset ?? 0);
      case 'write_file':
        return performWrite(action.path, action.content);
      case 'list_dir':
        return performList(action.path);
      case 'run':
        return performRun(action.command, action.timeoutMs, turn);
    }
  }

  function performDone(vals: Array<{ as: string; value: string }>): Performed {
    const bad: string[] = [];
    const accepted: Array<{ name: string; value: string }> = [];
    for (const v of vals) {
      if (!/^[\w.]+$/.test(v.as)) {
        bad.push(`"${v.as}" is not a variable name`);
        continue;
      }
      // A name ends where a word character stops, or at a full stop that ends
      // the sentence ("…in largest_amount."); only a full stop followed by a
      // word character carries a dotted name on (`order.id`).
      const found = new RegExp(`(?<![\\w.])${v.as.replace(/\./g, '\\.')}(?!\\w|\\.\\w)`, 'i').exec(args.goal);
      if (!found) {
        bad.push(`the goal does not mention "${v.as}"; store only the values the goal names`);
        continue;
      }
      if (secretEnv.length > 0 && v.value.includes(MASK)) {
        bad.push(`the value for "${v.as}" holds ${MASK}, the mask for a value you were not shown`);
        continue;
      }
      accepted.push({ name: found[0], value: v.value });
    }
    if (bad.length > 0) {
      return { ok: false, short: `not finished: ${bad[0]}`, full: `Not finished — ${bad.join('; ')}.` };
    }
    for (const s of accepted) bindVariable(args.vars, s.name, s.value);
    stored = accepted;
    return {
      ok: true,
      short: plural(accepted.length, 'value'),
      detail: { values: accepted.map((s) => ({ as: s.name, value: mask(s.value) })) },
      end: 'done',
    };
  }

  async function performStep(instruction: string): Promise<Performed> {
    let result: StepResult;
    try {
      result = await args.surface.step(instruction, signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, short: `failed: ${message}`, full: `The step failed: ${message}` };
    }
    const actions = result.turns.flatMap((t) => t.subActions.map((a) => a.action.description));
    const ok = result.status === 'passed';
    const said = ok
      ? `Done: ${result.aiExplanation ?? 'the step passed'}`
      : `The step failed: ${result.error ?? result.aiExplanation ?? 'no reason given'}`;
    if (result.outputs) for (const [k, v] of Object.entries(result.outputs)) args.vars[k] ??= v;
    return {
      ok,
      short: ok ? (actions.length > 0 ? plural(actions.length, 'action') : 'passed') : 'failed',
      full: said,
      detail: {
        step: {
          instruction: mask(instruction),
          status: result.status,
          ...(result.aiExplanation !== undefined && { explanation: mask(result.aiExplanation) }),
          ...(result.error !== undefined && { error: mask(result.error) }),
          actions: actions.map(mask),
        },
      },
    };
  }

  async function performTool(name: string, rawArgs: Record<string, unknown>): Promise<Performed> {
    if (!args.tools) return { ok: false, short: 'no project tools', full: 'This project has no tools (toolsDir).' };
    const toolArgs: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawArgs)) toolArgs[k] = typeof v === 'string' ? v : JSON.stringify(v);
    let r: Awaited<ReturnType<AgentToolbox['call']>>;
    try {
      r = await args.tools.call(name, toolArgs, signal);
    } catch (err) {
      r = { ok: false, outputs: {}, error: err instanceof Error ? err.message : String(err) };
    }
    const outputs = Object.entries(r.outputs).map(([k, v]) => `${k} = ${v}`).join('\n');
    return {
      ok: r.ok,
      short: r.ok ? (Object.keys(r.outputs).length > 0 ? plural(Object.keys(r.outputs).length, 'output') : 'ok') : `failed: ${r.error ?? ''}`,
      full: r.ok ? `Tool ${name} ran.${outputs ? `\n${outputs}` : ''}` : `Tool ${name} failed: ${r.error ?? 'no reason given'}`,
      detail: {
        tool: {
          name,
          args: redactDeep(rawArgs, secrets),
          outputs: Object.fromEntries(Object.entries(r.outputs).map(([k, v]) => [k, mask(v)])),
          ...(r.error !== undefined && { error: mask(r.error) }),
        },
      },
    };
  }

  function performLoadSkill(name: string): Performed {
    const skill = findSkill(skills, name);
    if (!skill) {
      return { ok: false, short: 'no such skill', full: `There is no agent skill named "${name}".` };
    }
    if (loadedSkills.some((s) => s.path === skill.path)) {
      return { ok: true, short: 'already loaded', full: `The skill ${skill.name} is already loaded.` };
    }
    let body: string;
    try {
      body = loadSkillBody(skill);
    } catch (err) {
      return { ok: false, short: 'could not read it', full: `The skill could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
    const size = Math.ceil(body.length / 4);
    // §5.5: a skill too big to load fails the load_skill, not the next turn.
    // The fixed parts with it loaded must leave room for a turn's results.
    const fixedWith = fixedPartsTokens(
      {
        surface: args.surface.kind,
        shell: shellInfo,
        tools: toolList,
        skills: skills.map((s) => ({ name: s.name, description: s.description })),
        priorSteps: args.priorSteps,
        goal: args.goal,
        values,
        secretEnv,
        ...(shellOn && ws !== undefined && { workspace: ws.dir }),
        folders: shellOn && ws ? ws.folders : [],
        loadedSkills: [...loadedSkills, { name: skill.name, body }],
      },
      secrets,
    );
    if (fixedWith > cfg.maxContextTokens * 0.75) {
      return {
        ok: false,
        short: `too big (${size} tokens)`,
        full: `The skill ${skill.name} is about ${size} tokens, too big to load under agent.maxContextTokens (${cfg.maxContextTokens}).`,
      };
    }
    loadedSkills.push({ name: skill.name, body, path: skill.path });
    const rel = ws ? path.relative(args.run.projectRoot, skill.path).split(path.sep).join('/') : skill.path;
    return { ok: true, short: 'loaded', full: `Loaded the skill ${skill.name}; its instructions are now shown to you.`, detail: { skill: { name: skill.name, path: rel } } };
  }

  function performRead(p: string, offset: number): Performed {
    if (!ws) return { ok: false, short: 'no workspace', full: 'There is no workspace in this run.' };
    const check = resolveAgentPath(ws, p, 'read');
    if (!check.ok) {
      return { ok: false, short: 'refused', full: refuse(`read_file ${p}`, `${check.reason} (agent.folders)`, 'agent.folders') };
    }
    try {
      const st = fs.statSync(check.absolute);
      if (st.isDirectory()) return { ok: false, short: 'is a folder', full: `${p} is a folder; use list_dir.` };
      const decoded = decodeText(fs.readFileSync(check.absolute));
      if (decoded === undefined) {
        return { ok: true, short: `binary, ${st.size} bytes`, full: `${p} is a binary file of ${st.size} bytes; read it with a script.`, detail: { path: p } };
      }
      // Masked BEFORE it is cut, so a secret cannot reach the model as two
      // halves on either side of a cut; offsets count the masked text, which
      // is the only text the model ever sees.
      const text = mask(decoded);
      const piece = text.slice(offset);
      // Room for the header and the hint inside one result, so the result is
      // never cut in its middle and the hint's offset is where reading stopped.
      const take = Math.max(500, cfg.resultMaxChars - 300);
      const more = offset + take < text.length;
      return {
        ok: true,
        short: `${text.length} characters${offset ? ` from ${offset}` : ''}`,
        full: `${p}, ${text.length} characters${offset ? `, from ${offset}` : ''}:\n${piece.slice(0, take)}${more ? `\n… (more: read_file with offset ${offset + take})` : ''}`,
        detail: { path: p, content: headAndTail(piece, 20 * 1024) },
      };
    } catch (err) {
      return { ok: false, short: 'could not read it', full: `${p} could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  function performWrite(p: string, content: string): Performed {
    if (!ws) return { ok: false, short: 'no workspace', full: 'There is no workspace in this run.' };
    const check = resolveAgentPath(ws, p, 'write');
    if (!check.ok) {
      return { ok: false, short: 'refused', full: refuse(`write_file ${p}`, `${check.reason} (agent.folders)`, 'agent.folders') };
    }
    try {
      fs.mkdirSync(path.dirname(check.absolute), { recursive: true });
      fs.writeFileSync(check.absolute, content);
      const lines = content.split('\n').length;
      return { ok: true, short: plural(lines, 'line'), full: `Wrote ${p} (${lines} lines).`, detail: { path: p, content: headAndTail(mask(content), 20 * 1024) } };
    } catch (err) {
      return { ok: false, short: 'could not write it', full: `${p} could not be written: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  function performList(p: string): Performed {
    if (!ws) return { ok: false, short: 'no workspace', full: 'There is no workspace in this run.' };
    const check = resolveAgentPath(ws, p, 'read');
    if (!check.ok) {
      return { ok: false, short: 'refused', full: refuse(`list_dir ${p}`, `${check.reason} (agent.folders)`, 'agent.folders') };
    }
    try {
      const entries = fs.readdirSync(check.absolute, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          if (e.isDirectory()) return `${e.name}/${SKIPPED_DIRS.has(e.name) ? ' (installed packages)' : ''}`;
          try {
            return `${e.name} (${fs.statSync(path.join(check.absolute, e.name)).size} bytes)`;
          } catch {
            return e.name;
          }
        });
      return {
        ok: true,
        short: lines.length === 0 ? 'empty' : lines.length <= 3 ? lines.join(', ') : plural(lines.length, 'entry', 'entries'),
        full: `${p}:\n${lines.join('\n') || '(empty)'}`,
        detail: { path: p, content: mask(lines.join('\n')) },
      };
    } catch (err) {
      return { ok: false, short: 'could not list it', full: `${p} could not be listed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Decide whether one command part may run (§6.3). */
  async function allowance(part: string): Promise<AgentCommandAllowance> {
    if (isGlobalInstall(part)) {
      return { by: 'refused', why: 'a global install; packages install into the workspace only' };
    }
    const listed = matchingPattern(part, cfg.allowCommands);
    if (listed !== undefined) return { by: 'allow-list', pattern: listed };
    const remembered = args.run.approvals.remembered(part);
    if (remembered?.allow) return { by: 'remembered', pattern: remembered.pattern };
    const pattern = patternFor(part);
    if (remembered && !remembered.allow) {
      return { by: 'refused', why: `you denied "${remembered.pattern}" for the rest of this run (agent.allowCommands)` };
    }
    const nobody = !args.asker
      ? args.noAsker
      : args.surface.kind === 'computer'
        ? 'computer mode asks no questions'
        : args.run.approvals.unanswered
          ? 'an earlier question went unanswered, so this run asks no more'
          : undefined;
    if (nobody !== undefined) {
      return {
        by: 'refused',
        why:
          `not in agent.allowCommands, and this run had nobody to ask (${nobody}). ` +
          `Add "${pattern}" to agent.allowCommands in steptix.config.json to allow it.`,
      };
    }
    args.onWaiting?.(true);
    let answer: Awaited<ReturnType<ApprovalAsker['ask']>>;
    try {
      answer = await args.asker!.ask(
        {
          command: mask(part),
          folder: ws ? displayFolder(ws.dir, args.run.projectRoot) : '',
          stepLabel: args.stepLabel,
          pattern,
          timeoutMs: cfg.approvalTimeoutMs,
        },
        signal,
      );
    } finally {
      args.onWaiting?.(false);
    }
    if ('closed' in answer) {
      if (answer.closed === 'timeout') {
        args.run.approvals.markUnanswered(pattern, args.index);
        return {
          by: 'refused',
          why: `nobody answered within agent.approvalTimeoutMs (${cfg.approvalTimeoutMs} ms), so it was denied and this run asks no more. Add "${pattern}" to agent.allowCommands to allow it.`,
        };
      }
      return {
        by: 'refused',
        why: deadline.signal.aborted && !stoppedByPerson()
          ? `agent.timeout (${cfg.timeout} ms) ran out while the question was open`
          : 'the run was stopped while the question was open',
      };
    }
    const at = new Date().toISOString();
    switch (answer.answer) {
      case 'allow-once':
        return { by: 'answer', answer: 'allow-once', pattern, at };
      case 'allow-run':
        args.run.approvals.remember('allow-run', pattern, args.index);
        return { by: 'answer', answer: 'allow-run', pattern, at };
      case 'deny-run':
        args.run.approvals.remember('deny-run', pattern, args.index);
        return { by: 'refused', why: `you denied it for the rest of this run. To allow it for good, add "${pattern}" to agent.allowCommands` };
      default:
        return { by: 'refused', why: `you denied it. To allow it for good, add "${pattern}" to agent.allowCommands` };
    }
  }

  async function performRun(command: string, timeoutMs: number | undefined, turn: number): Promise<Performed> {
    if (!ws) return { ok: false, short: 'no workspace', full: 'There is no workspace in this run.' };
    const uncheckable = uncheckableReason(command, args.platform);
    if (uncheckable !== undefined) {
      commandsRefused++;
      const said = refuse(
        command,
        `it holds ${uncheckable}, which agent.allowCommands cannot check; run each command as its own run action`,
        'agent.allowCommands',
      );
      return { ok: false, short: 'refused', full: said, detail: { command: mask(command), allowance: { by: 'refused', why: uncheckable } } };
    }
    let allowed: AgentCommandAllowance | undefined;
    for (const part of commandParts(command, args.platform)) {
      const a = await allowance(part);
      if (a.by === 'refused') {
        commandsRefused++;
        const setting = /global install|run was stopped/.test(a.why)
          ? null
          : /agent\.timeout \(/.test(a.why)
            ? 'agent.timeout'
            : /approvalTimeoutMs/.test(a.why)
              ? 'agent.approvalTimeoutMs'
              : 'agent.allowCommands';
        const said = refuse(part, a.why, setting);
        if (stoppedByPerson()) return { ok: false, short: 'stopped', full: said, end: 'stopped' };
        return { ok: false, short: `refused`, full: said, detail: { command: mask(command), folder: displayFolder(ws.dir, args.run.projectRoot), allowance: a } };
      }
      allowed ??= a;
      if (a.by === 'answer') allowed = a;
    }
    const limit = Math.min(timeoutMs ?? cfg.commandTimeoutMs, cfg.commandTimeoutMs);
    const run = await runCommand({
      command,
      cwd: ws.dir,
      env: scrubbedEnv(process.env, secretVars),
      timeoutMs: limit,
      signal,
      ...(args.platform !== undefined && { platform: args.platform }),
    });
    commandsRun++;
    const masked = mask(run.output);
    const logFile = path.join(stageDir, 'commands', `turn-${turn}.log`);
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `$ ${mask(command)}\n${masked}`);
    } catch {
      // the report then has no full log for this one
    }
    if (run.stopped === 'aborted' && stoppedByPerson()) {
      return { ok: false, short: 'stopped', full: 'Stopped.', end: 'stopped' };
    }
    const timedOut = run.stopped === 'timeout';
    let said = timedOut
      ? refuse(command, `it ran past agent.commandTimeoutMs (${limit} ms) and was stopped`, 'agent.commandTimeoutMs')
      : `Exit code ${run.exitCode ?? 'none'}.`;
    said += `\n${run.output}`;
    return {
      ok: !timedOut && run.exitCode === 0,
      short: timedOut ? 'timed out' : `exit ${run.exitCode ?? '?'}`,
      full: said,
      detail: {
        command: mask(command),
        folder: displayFolder(ws.dir, args.run.projectRoot),
        exitCode: run.exitCode,
        ...(allowed !== undefined && { allowance: allowed }),
        output: inlineOutput(masked),
        outputBytes: run.outputBytes,
        log: logFile,
      },
    };
  }
}
