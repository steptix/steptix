import { buildRecordStepsPrompt } from '../ai/prompts.js';
import type { ChatMessage } from '../ai/types.js';
import { isImageInputUnsupported } from '../desktop/vision-route.js';
import { MASK, isSecretName } from '../utils/secrets.js';
import type { TargetFileSummary } from './target-file.js';
import type { RecordedAction } from './types.js';

/**
 * Stop → the model → `record:result` (stories/testbench-record-steps.md,
 * decision 9): one call with the whole recording, and a strict reading of what
 * comes back.
 */

/** What the model answered, validated. */
export interface RecordStepsAnswer {
  steps: string[];
  parameters: Array<{ name: string; value: string }>;
  notes: string[];
}

/**
 * The model's answer could not be used. Its message is the one sentence the
 * client shows — it names what was wrong, and quotes the start of the answer so
 * the author can see it was the model and not the recording.
 */
export class RecordStepsAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordStepsAnswerError';
  }
}

const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function preview(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 160 ? `${one.slice(0, 159)}…` : one;
}

function isEnvReference(value: string): boolean {
  return value.trim().startsWith('$');
}

/**
 * Read the JSON answer `{ steps, parameters, notes? }`.
 *
 * Forgiving about the envelope — a Markdown fence, prose around the object, a
 * step that starts `3. ` — because none of that changes what the author gets.
 * Strict about the content: `steps` must be a list of strings, and a parameter
 * needs a usable name and a string value, because TestBench writes both into
 * the file verbatim.
 */
export function parseRecordStepsAnswer(text: string): RecordStepsAnswer {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new RecordStepsAnswerError(
      `The model did not answer with the JSON object Record Steps asks for. Its answer began: "${preview(text)}"`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new RecordStepsAnswerError(
      `The model's answer was not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `Its answer began: "${preview(text)}"`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RecordStepsAnswerError(`The model's answer was not a JSON object. Its answer began: "${preview(text)}"`);
  }
  const obj = parsed as Record<string, unknown>;
  const rawSteps = obj['steps'];
  if (!Array.isArray(rawSteps) || !rawSteps.every((s) => typeof s === 'string')) {
    throw new RecordStepsAnswerError(
      `The model's answer had no "steps" list of strings. Its answer began: "${preview(text)}"`,
    );
  }
  const notes: string[] = [];
  const steps = (rawSteps as string[])
    // A step is one physical line (handbook §2): a wrapped one would be seen by
    // TestBench as a step and a stray line.
    .map((s) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim())
    // Numbers are TestBench's to assign.
    .map((s) => s.replace(/^\d+[.)]\s+/, ''))
    .filter((s) => s !== '');

  const parameters: Array<{ name: string; value: string }> = [];
  const rawParams = obj['parameters'];
  if (rawParams !== undefined && rawParams !== null) {
    if (!Array.isArray(rawParams)) {
      throw new RecordStepsAnswerError(`The model's "parameters" was not a list. Its answer began: "${preview(text)}"`);
    }
    const seen = new Map<string, string>();
    for (const entry of rawParams as unknown[]) {
      const rec = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
      const name = typeof rec['name'] === 'string' ? rec['name'].trim() : '';
      const value = typeof rec['value'] === 'string' ? rec['value'] : undefined;
      if (!PARAMETER_NAME.test(name) || value === undefined) {
        notes.push(
          `A parameter the model returned was dropped because it had no usable name or value: ${preview(JSON.stringify(entry))}`,
        );
        continue;
      }
      const clean = value.replace(/[\r\n]+/g, ' ');
      const earlier = seen.get(name);
      if (earlier !== undefined) {
        if (earlier !== clean) notes.push(`The model gave the parameter "${name}" two different values; the first is kept.`);
        continue;
      }
      seen.set(name, clean);
      parameters.push({ name, value: clean });
    }
  }
  const rawNotes = obj['notes'];
  if (Array.isArray(rawNotes)) {
    for (const n of rawNotes) if (typeof n === 'string' && n.trim() !== '') notes.push(n.trim());
  }
  return { steps, parameters, notes };
}

/** `password` → `$PASSWORD`, `apiKey` → `$API_KEY`. */
export function envReferenceFor(name: string): string {
  const upper = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
  return '$' + upper;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The file-safety pass over a parsed answer — rules the prompt states,
 * enforced rather than hoped for, because TestBench writes what it is given.
 *
 * - A parameter the file already has under the same name with a DIFFERENT
 *   value is renamed (`email` → `email_2`) and the new steps rewritten to match
 *   (decision 8: "never overwrites an existing line with a different value").
 *   TestBench keeps an existing line as it is, so without this the new steps
 *   would silently type the old value. Two `.env` references under one name are
 *   the exception: the model meant the file's own and spelled the variable its
 *   own way, so the file's is kept.
 * - A value that is, or contains, the secret mask is a secret the model could
 *   not see: it becomes `$NAME` (decision 7).
 * - A `{{name}}` the steps use that neither the answer nor the file defines is
 *   noted — the run would fail on it, and the author should hear it now.
 */
export function reconcileAnswer(answer: RecordStepsAnswer, file: TargetFileSummary): RecordStepsAnswer {
  const existing = new Map(file.parameters.map((p) => [p.name, p.value.trim()]));
  let steps = [...answer.steps];
  const notes = [...answer.notes];
  const taken = new Set([...existing.keys(), ...answer.parameters.map((p) => p.name)]);
  const parameters: Array<{ name: string; value: string }> = [];

  for (const p of answer.parameters) {
    let value = p.value;
    if (value.includes(MASK)) {
      value = envReferenceFor(p.name);
      notes.push(`The parameter "${p.name}" is a secret, so it reads ${value} from the project's .env.`);
    }
    const had = existing.get(p.name);
    if (had !== undefined && isEnvReference(had) && isEnvReference(value)) {
      parameters.push({ name: p.name, value: had });
      continue;
    }
    if (had !== undefined && had !== value.trim()) {
      let n = 2;
      while (taken.has(`${p.name}_${n}`)) n++;
      const renamed = `${p.name}_${n}`;
      taken.add(renamed);
      const pattern = new RegExp(`\\{\\{${escapeRegExp(p.name)}\\}\\}`, 'g');
      steps = steps.map((s) => s.split(pattern).join(`{{${renamed}}}`));
      // SPEC-record-steps.md §10's sentence, finished with what the server did
      // instead of dropping the value: the steps now name the new parameter.
      notes.push(
        `Parameter ${p.name} already exists with a different value; the recorded value was added as ${renamed} instead.`,
      );
      parameters.push({ name: renamed, value });
      continue;
    }
    parameters.push({ name: p.name, value });
  }

  const defined = new Set([...existing.keys(), ...parameters.map((p) => p.name)]);
  const undefinedNames = new Set<string>();
  for (const s of steps) {
    for (const m of s.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_.]*)\}\}/g)) {
      const root = m[1]!.split('.')[0]!;
      if (!defined.has(root)) undefinedNames.add(root);
    }
  }
  for (const name of undefinedNames) {
    notes.push(`The steps use {{${name}}}, which no parameter defines — add it under ## Parameters before running.`);
  }
  // A secret-named parameter holding a literal is how a password ends up in a
  // test file; the recorder never had one to give, so say so if one appears.
  for (const p of parameters) {
    if (isSecretName(p.name) && !isEnvReference(p.value) && !existing.has(p.name)) {
      notes.push(
        `"${p.name}" looks like a secret but holds a literal value; consider ${envReferenceFor(p.name)} and a .env entry.`,
      );
    }
  }
  return { steps, parameters, notes };
}

/** Did the model refuse the request because it carried images? */
export function isImageRejection(err: unknown): boolean {
  if (isImageInputUnsupported(err)) return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  // Providers other than the Copilot bridge say it in words, on a 400.
  return /\b4\d\d\b/.test(message) && /image|vision|multimodal/i.test(message);
}

export interface WriteRecordedStepsArgs {
  actions: readonly RecordedAction[];
  file: TargetFileSummary;
  /** Crops go to the model (`ai.sendScreenshots`). */
  sendImages: boolean;
  /** Values that must not reach the model. */
  secrets: readonly string[];
  complete: (messages: ChatMessage[], signal: AbortSignal) => Promise<{ text: string }>;
  signal: AbortSignal;
  warn: (message: string) => void;
}

/**
 * Build the prompt, ask once, and read the answer. A model that rejects images
 * (SPEC-use-computer §15.4 — the Copilot bridge, some providers) is asked once
 * more without them, and the author is told the steps were written from the
 * descriptions alone.
 */
export async function writeRecordedSteps(args: WriteRecordedStepsArgs): Promise<RecordStepsAnswer> {
  const withImages = args.sendImages && args.actions.some((a) => a.crop !== undefined);
  const ask = (includeImages: boolean): Promise<{ text: string }> =>
    args.complete(
      buildRecordStepsPrompt({
        actions: args.actions,
        file: args.file,
        includeImages,
        secrets: args.secrets,
      }),
      args.signal,
    );

  let answer: { text: string };
  try {
    answer = await ask(withImages);
  } catch (err) {
    if (!withImages || args.signal.aborted || !isImageRejection(err)) throw err;
    args.warn(
      'The model does not accept images, so the steps are written from the page descriptions alone ' +
        '(icon-only targets may be described less well).',
    );
    answer = await ask(false);
  }
  return reconcileAnswer(parseRecordStepsAnswer(answer.text), args.file);
}
