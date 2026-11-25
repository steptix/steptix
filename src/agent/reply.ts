/**
 * Reading the model's answer on one agent turn (docs/specs/SPEC-use-agent.md
 * §5.2): exactly one action, in Steptix's JSON action format, plus optional
 * `notes`.
 */

import { extractJson } from '../ai/action-parser.js';

export type AgentAction =
  | { action: 'step'; instruction: string }
  | { action: 'tool'; name: string; args: Record<string, unknown> }
  | { action: 'read_file'; path: string; offset?: number }
  | { action: 'write_file'; path: string; content: string }
  | { action: 'list_dir'; path: string }
  | { action: 'run'; command: string; timeoutMs?: number }
  | { action: 'load_skill'; name: string }
  | { action: 'done'; values: Array<{ as: string; value: string }> }
  | { action: 'stuck'; reason: string };

export type AgentReply =
  | { kind: 'action'; action: AgentAction; notes?: string }
  | { kind: 'malformed'; why: string };

/** The action kinds, for the prompt and the error that lists them. */
export const AGENT_ACTION_KINDS = [
  'step',
  'tool',
  'read_file',
  'write_file',
  'list_dir',
  'run',
  'load_skill',
  'done',
  'stuck',
] as const;

/** The file and command actions, offered only when `agent.shell` is on. */
export const SHELL_ACTION_KINDS: ReadonlySet<string> = new Set(['read_file', 'write_file', 'list_dir', 'run']);

/** Most characters of notes kept (§5.5). */
export const NOTES_MAX_CHARS = 2000;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A string value: strings as they are, numbers and booleans as text. */
function valueText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

export function parseAgentReply(raw: string): AgentReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return { kind: 'malformed', why: 'the reply was not one JSON object' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', why: 'the reply was not one JSON object' };
  }
  const o = parsed as Record<string, unknown>;
  const kind = str(o['action']);
  const notesRaw = str(o['notes']);
  const notes = notesRaw === undefined ? undefined : notesRaw.slice(0, NOTES_MAX_CHARS);
  const ok = (action: AgentAction): AgentReply => ({ kind: 'action', action, ...(notes !== undefined && { notes }) });
  const missing = (field: string): AgentReply => ({
    kind: 'malformed',
    why: `a "${kind}" action needs "${field}"`,
  });

  switch (kind) {
    case 'step': {
      const instruction = str(o['instruction']) ?? str(o['step']);
      return instruction && instruction.trim() !== '' ? ok({ action: 'step', instruction: instruction.trim() }) : missing('instruction');
    }
    case 'tool': {
      const name = str(o['name']);
      if (!name) return missing('name');
      const args = o['args'];
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        return { kind: 'malformed', why: 'a "tool" action\'s "args" must be an object' };
      }
      return ok({ action: 'tool', name, args: (args as Record<string, unknown> | undefined) ?? {} });
    }
    case 'read_file': {
      const path = str(o['path']);
      if (!path) return missing('path');
      const offset = typeof o['offset'] === 'number' && o['offset'] >= 0 ? Math.floor(o['offset']) : undefined;
      return ok({ action: 'read_file', path, ...(offset !== undefined && { offset }) });
    }
    case 'write_file': {
      const path = str(o['path']);
      const content = str(o['content']);
      if (!path) return missing('path');
      if (content === undefined) return missing('content');
      return ok({ action: 'write_file', path, content });
    }
    case 'list_dir':
      return ok({ action: 'list_dir', path: str(o['path']) ?? '.' });
    case 'run': {
      const command = str(o['command']);
      if (!command || command.trim() === '') return missing('command');
      const t = o['timeoutMs'];
      return ok({
        action: 'run',
        command: command.trim(),
        ...(typeof t === 'number' && t > 0 && { timeoutMs: Math.floor(t) }),
      });
    }
    case 'load_skill': {
      const name = str(o['name']);
      return name ? ok({ action: 'load_skill', name }) : missing('name');
    }
    case 'done': {
      const raw = o['values'];
      if (raw === undefined) return ok({ action: 'done', values: [] });
      if (!Array.isArray(raw)) return { kind: 'malformed', why: '"values" must be a list of {"as", "value"}' };
      const values: Array<{ as: string; value: string }> = [];
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) {
          return { kind: 'malformed', why: 'each of "values" must be {"as": name, "value": text}' };
        }
        const as = str((item as Record<string, unknown>)['as']);
        const value = valueText((item as Record<string, unknown>)['value']);
        if (!as || value === undefined) {
          return { kind: 'malformed', why: 'each of "values" must be {"as": name, "value": text}' };
        }
        values.push({ as, value });
      }
      return ok({ action: 'done', values });
    }
    case 'stuck': {
      const reason = str(o['reason']);
      return ok({ action: 'stuck', reason: reason && reason.trim() !== '' ? reason.trim() : 'no reason given' });
    }
    case undefined:
      return { kind: 'malformed', why: 'the reply has no "action"' };
    default:
      return {
        kind: 'malformed',
        why: `"${kind}" is not an agent action; the actions are ${AGENT_ACTION_KINDS.join(', ')}`,
      };
  }
}

/** The action without its notes, as text: what the stall rule compares
 *  (§5.3), so the same action with different notes still counts. */
export function actionKey(action: AgentAction): string {
  return JSON.stringify(action);
}
