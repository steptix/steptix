/**
 * What one agent turn's request holds (docs/specs/SPEC-use-agent.md §5.5).
 *
 * Each turn is ONE fresh request rebuilt from the step's state — a system
 * message and one user message, the shape every multi-turn step already uses
 * — never a chat that grows by a message a turn. The parts that do not change
 * come first, so a provider that caches a prefix can reuse it from turn to
 * turn, and every part is rendered through the run's masking.
 */

import type { ChatMessage, MessageContentBlock } from '../ai/types.js';
import { redact } from '../utils/secrets.js';

/** A tool as the catalogue lists it. */
export interface AgentToolInfo {
  name: string;
  description?: string;
  params?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** What the surface shows now (§5.5 part 9). */
export type AgentObservation =
  | { kind: 'dom'; url: string; title?: string; snapshot: string }
  | { kind: 'screen'; imageDataUrl: string; note?: string }
  | { kind: 'none'; note: string };

/** One finished turn's full result, kept while it is recent (part 8). */
export interface RecentResult {
  turn: number;
  text: string;
}

export interface AgentContextState {
  /** Part 1's surface: which ordinary steps the `step` action can take. */
  surface: 'browser' | 'computer';
  shell: { on: boolean; name: string; runtimes: string[] };
  tools: AgentToolInfo[];
  skills: Array<{ name: string; description: string }>;
  priorSteps: string[];
  /** The step as authored. */
  goal: string;
  /** `name = value` lines, values masked by the caller. */
  values: string[];
  /** Secrets handed to commands by name (§6.4): variable name → env name. */
  secretEnv: Array<{ name: string; env: string }>;
  workspace?: string;
  folders: string[];
  loadedSkills: Array<{ name: string; body: string }>;
  log: string[];
  notes: string;
  recent: RecentResult[];
  observation: AgentObservation;
  turn: number;
  maxTurns: number;
  msLeft: number;
}

/** What a request may spend, and how it was shrunk to fit (§5.5). */
export interface RenderLimits {
  historyTurns: number;
  resultMaxChars: number;
  maxContextTokens: number;
}

export interface RenderedRequest {
  messages: ChatMessage[];
  /** Estimated tokens of the request as sent. */
  tokens: number;
  /** What shrinking was done, in order, for the log and the report. */
  shrinks: string[];
}

/** A rough token estimate: four characters a token, a screenshot a fixed
 *  amount. Good enough to keep a request under a limit with room to spare. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
const IMAGE_TOKENS = 1600;

/** Cut text over `max` characters to its first and last halves, with a line
 *  saying how much was left out (§5.5). */
export function headAndTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.max(1, Math.floor(max / 2));
  const cut = text.length - half * 2;
  return `${text.slice(0, half)}\n… [${cut} characters left out of this result] …\n${text.slice(-half)}`;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${s % 60} s` : `${s} s`;
}

/** Part 1: the agent's rules. Never changes within a run. */
export function systemPrompt(state: Pick<AgentContextState, 'surface' | 'shell'>): string {
  const surfaceLine =
    state.surface === 'computer'
      ? 'The test is on the COMPUTER surface: you are shown a screenshot of the whole screen, and a `step` action is carried out with the real mouse and keyboard.'
      : 'The test is on the BROWSER surface: you are shown a snapshot of the page, and a `step` action is carried out on that page.';
  const shellLines = state.shell.on
    ? [
        `Files and commands are ON. Commands run in ${state.shell.name}, in the workspace folder. On the path: ${state.shell.runtimes.join(', ') || 'node'}.`,
        'Install packages into the workspace only: `npm install <pkg>` there, or a virtual environment (`python -m venv .venv`, then its own pip). Global installs are refused, and pip refuses to install outside a virtual environment.',
        'A command not on the project\'s allow list may be refused; when one is, you are told which setting decided it. Do not retry a refused command.',
      ]
    : ['Files and commands are OFF for this project (agent.shell). Do not ask for them.'];
  return [
    'You are the agent of a Steptix test step. You work towards the step\'s goal over several turns. Each turn you are shown the goal, what you have done so far, and what the surface shows now, and you answer with ONE action as a single JSON object. Steptix performs it and starts the next turn.',
    surfaceLine,
    ...shellLines,
    '',
    'Actions:',
    '- {"action":"step","instruction":"<one ordinary test step>"} — do ONE thing on the surface, written as a test author would write a step, e.g. "Click the Export button" or "Type {{customer}} into the Name field". Refer to a value by its {{name}}; never type a value shown as ***.',
    '- {"action":"tool","name":"<tool>","args":{"<param>":"<value>"}} — call a project tool from the catalogue.',
    ...(state.shell.on
      ? [
          '- {"action":"read_file","path":"<path>","offset":0} — read a text file; offset is a character position, to read past what one result shows.',
          '- {"action":"write_file","path":"<path>","content":"<text>"} — create or replace a text file.',
          '- {"action":"list_dir","path":"<path>"} — list a folder.',
          '- {"action":"run","command":"<command line>","timeoutMs":120000} — run a command.',
          'A relative path is in the workspace. Only the workspace and the allowed folders can be used.',
        ]
      : []),
    '- {"action":"load_skill","name":"<skill>"} — add an agent skill\'s instructions to what you are shown.',
    '- {"action":"done","values":[{"as":"<variable>","value":"<text>"}]} — the goal is met. Store each value the goal asks for, under the name the goal gives it.',
    '- {"action":"stuck","reason":"<why>"} — you cannot meet the goal. Also answer stuck when the goal gives no way to tell it is finished.',
    '',
    'Any answer may add "notes": a short text (at most 2,000 characters) that replaces your notes and is shown to you on every later turn. Older results stop being shown, so keep there any fact you will need again.',
    'Answer with the JSON object only.',
  ].join('\n');
}

/** Part 2: the tools and the skills. Never changes within a run. */
function cataloguePart(state: AgentContextState): string {
  const lines: string[] = [];
  if (state.tools.length > 0) {
    lines.push('## Project tools');
    for (const t of state.tools) {
      const params = (t.params ?? [])
        .map((p) => `${p.name}${p.required ? '' : '?'}${p.description ? ` (${p.description})` : ''}`)
        .join(', ');
      lines.push(`- ${t.name}${t.description ? ` — ${t.description}` : ''}${params ? `. Arguments: ${params}` : ''}`);
    }
  } else {
    lines.push('## Project tools\n(none)');
  }
  if (state.skills.length > 0) {
    lines.push('', '## Agent skills (load one with load_skill when you need it)');
    for (const s of state.skills) lines.push(`- ${s.name} — ${s.description}`);
  }
  return lines.join('\n');
}

/** Parts 3 and 4: the steps before, and the goal. Never change within a step. */
function goalPart(state: AgentContextState): string {
  const lines: string[] = [];
  if (state.priorSteps.length > 0) {
    lines.push('## Steps before this one', ...state.priorSteps, '');
  }
  lines.push('## Goal', state.goal);
  if (state.values.length > 0) lines.push('', '## Values', ...state.values);
  // Only where there are commands to read them: with agent.shell off, naming
  // environment variables would point the model at a way it does not have.
  if (state.shell.on && state.secretEnv.length > 0) {
    lines.push(
      '',
      '## Secrets for commands',
      'These values are hidden from you. A command can read each from its environment variable:',
      // The shell's own spelling: in PowerShell `$NAME` is a shell variable,
      // and the environment's is `$env:NAME`.
      ...state.secretEnv.map((s) => `- {{${s.name}}} → ${state.shell.name === 'PowerShell' ? '$env:' : '$'}${s.env}`),
    );
  }
  if (state.workspace !== undefined) {
    lines.push('', '## Folders', `Workspace (commands run here): ${state.workspace}`);
    for (const f of state.folders) lines.push(`Allowed folder: ${f}`);
  }
  return lines.join('\n');
}

/** Part 5: loaded skills, in the order loaded. Appended to. */
function skillsPart(state: AgentContextState): string {
  return state.loadedSkills.map((s) => `## Skill: ${s.name}\n${s.body}`).join('\n\n');
}

/** Parts 1 to 5 — the parts that do not shrink — in estimated tokens, masked
 *  as they would be sent. What `load_skill` measures a new skill against. */
export function fixedPartsTokens(
  state: Omit<AgentContextState, 'log' | 'notes' | 'recent' | 'observation' | 'turn' | 'maxTurns' | 'msLeft'>,
  secrets: readonly string[],
): number {
  const mask = (text: string): string => redact(text, [...secrets]);
  const full = { ...state, log: [], notes: '', recent: [], observation: { kind: 'none', note: '' }, turn: 0, maxTurns: 0, msLeft: 0 } as AgentContextState;
  return (
    estimateTokens(mask(systemPrompt(full))) +
    estimateTokens(mask(cataloguePart(full))) +
    estimateTokens(mask(goalPart(full))) +
    estimateTokens(mask(skillsPart(full)))
  );
}

/**
 * Build one turn's request, kept under `limits.maxContextTokens` by shrinking
 * in §5.5's order: fewer recent results down to one, then `resultMaxChars`
 * halved, then the oldest log lines folded into one. Returns `{ error }` when
 * the fixed parts alone (1 to 5) are over the limit.
 */
export function renderRequest(
  state: AgentContextState,
  limits: RenderLimits,
  secrets: readonly string[],
): RenderedRequest | { error: string } {
  const mask = (text: string): string => redact(text, [...secrets]);
  const system = mask(systemPrompt(state));
  const catalogue = mask(cataloguePart(state));
  const goal = mask(goalPart(state));
  const skills = mask(skillsPart(state));
  const imageTokens = state.observation.kind === 'screen' ? IMAGE_TOKENS : 0;

  const fixed = [
    { name: 'the system prompt', tokens: estimateTokens(system) },
    { name: 'the tool and skill catalogue', tokens: estimateTokens(catalogue) },
    { name: 'the goal and the steps before it', tokens: estimateTokens(goal) },
    { name: 'the loaded skills', tokens: estimateTokens(skills) },
  ];
  const fixedTokens = fixed.reduce((n, p) => n + p.tokens, 0);
  if (fixedTokens > limits.maxContextTokens) {
    const largest = [...fixed].sort((a, b) => b.tokens - a.tokens)[0]!;
    return {
      error:
        `The agent's request is over agent.maxContextTokens (${limits.maxContextTokens}) before any turn's ` +
        `results are added: its fixed parts come to about ${fixedTokens} tokens, the largest being ` +
        `${largest.name} (about ${largest.tokens}). Raise agent.maxContextTokens, or make that part smaller.`,
    };
  }

  const shrinks: string[] = [];
  let recentCount = Math.max(1, limits.historyTurns);
  let resultMax = limits.resultMaxChars;
  let foldUpTo = 0;

  const variable = (): string => {
    const lines: string[] = [];
    if (state.log.length > 0) {
      lines.push('## What you have done');
      if (foldUpTo > 0) {
        lines.push(`Turns 1–${foldUpTo}: ${foldUpTo} actions (see notes).`);
        lines.push(...state.log.slice(foldUpTo));
      } else {
        lines.push(...state.log);
      }
    }
    lines.push('', '## Notes', state.notes.trim() === '' ? '(none)' : state.notes);
    const recent = state.recent.slice(-recentCount);
    if (recent.length > 0) {
      lines.push('', '## Recent results');
      // Masked BEFORE it is cut, so a secret straddling the cut cannot reach
      // the model as two unmasked halves.
      for (const r of recent) lines.push(`### Turn ${r.turn}`, headAndTail(mask(r.text), resultMax));
    }
    lines.push('', '## Now');
    lines.push(`Turn ${state.turn} of at most ${state.maxTurns}, ${formatDuration(state.msLeft)} left.`);
    if (state.observation.kind === 'dom') {
      lines.push(`URL: ${state.observation.url}`);
      if (state.observation.title) lines.push(`Title: ${state.observation.title}`);
      lines.push('Page snapshot:', state.observation.snapshot);
    } else if (state.observation.kind === 'screen') {
      lines.push(state.observation.note ?? 'The screenshot shows the whole screen now.');
    } else {
      lines.push(state.observation.note);
    }
    return mask(lines.join('\n'));
  };

  let tail = variable();
  const total = (): number => fixedTokens + estimateTokens(tail) + imageTokens;
  while (total() > limits.maxContextTokens) {
    if (recentCount > 1 && state.recent.length > 1) {
      recentCount = Math.min(recentCount, state.recent.length) - 1;
      shrinks.push(`recent results cut to the last ${recentCount}`);
    } else if (resultMax > 500) {
      resultMax = Math.floor(resultMax / 2);
      shrinks.push(`results cut to ${resultMax} characters`);
    } else if (foldUpTo < state.log.length - 1) {
      foldUpTo = state.log.length - 1;
      shrinks.push(`turn log folded: turns 1–${foldUpTo}`);
    } else {
      break;
    }
    tail = variable();
  }

  const userBlocks: MessageContentBlock[] = [
    { type: 'text', text: catalogue, cache: true },
    { type: 'text', text: goal + (skills ? `\n\n${skills}` : '') },
    { type: 'text', text: tail },
  ];
  if (state.observation.kind === 'screen') {
    userBlocks.push({ type: 'image_url', image_url: { url: state.observation.imageDataUrl } });
  }
  return {
    messages: [
      { role: 'system', content: [{ type: 'text', text: system, cache: true }] },
      { role: 'user', content: userBlocks },
    ],
    tokens: total(),
    shrinks,
  };
}
