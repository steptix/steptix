import { buildRecordStepsPrompt, type RecordStepsPromptInput } from '../ai/prompts.js';
import type { ChatMessage } from '../ai/types.js';
import { isImageInputUnsupported } from '../desktop/vision-route.js';
import { MASK, isSecretName } from '../utils/secrets.js';
import type { TargetFileSummary } from './target-file.js';
import type { RecordedAction } from './types.js';

/**
 * The model's side of live drafting (stories/steptix-record-steps.md,
 * decision 9): one draft call, and a strict reading of what comes back. When
 * calls happen, and what their answers do to the draft, is the draft engine's
 * (./draft-engine.ts).
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
 * The model's step texts as they go into the file — each with the index it
 * had in the answer, so a list parallel to `steps` (`stepActions`) stays
 * parallel once the empty ones are gone.
 */
function cleanSteps(raw: readonly string[]): Array<{ text: string; from: number }> {
  return (
    raw
      // A step is one physical line (handbook §2): a wrapped one would be seen
      // by Steptix as a step and a stray line.
      .map((s, from) => ({ text: s.replace(/\s*[\r\n]+\s*/g, ' ').trim(), from }))
      // Numbers are Steptix's to assign.
      .map((s) => ({ text: s.text.replace(/^\d+[.)]\s+/, ''), from: s.from }))
      .filter((s) => s.text !== '')
  );
}

/**
 * Read the JSON answer `{ steps, parameters, notes? }`.
 *
 * Forgiving about the envelope — a Markdown fence, prose around the object, a
 * step that starts `3. ` — because none of that changes what the author gets.
 * Strict about the content: `steps` must be a list of strings, and a parameter
 * needs a usable name and a string value, because Steptix writes both into
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
  const steps = cleanSteps(rawSteps as string[]).map((s) => s.text);

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

/** A draft call's answer: the parsed tail, and where it starts. */
export interface DraftAnswer extends RecordStepsAnswer {
  /**
   * The 0-based index in the draft so far where `steps` begin. Undefined when
   * the model left it out or gave something that is not a whole number — the
   * engine refuses that exactly as it refuses one that reaches back too far.
   */
  replaceFrom: number | undefined;
  /**
   * Which recorded actions each step describes, by the numbers the prompt
   * showed — parallel to `steps` (stories/steptix-record-edit-steps.md, "The
   * wire, exactly"). Undefined when the model left it out, or gave anything
   * that is not one list of whole numbers per step: the engine then infers the
   * mapping. Read only for its shape here; whether the numbers make sense for
   * the call is the engine's to check.
   */
  stepActions: number[][] | undefined;
}

/** Read a draft call's JSON answer `{ replaceFrom, steps, stepActions?, parameters, notes? }`. */
export function parseDraftAnswer(text: string): DraftAnswer {
  const answer = parseRecordStepsAnswer(text);
  // Valid JSON by now — `parseRecordStepsAnswer` threw otherwise.
  const obj = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>;
  const raw = obj['replaceFrom'];
  const replaceFrom = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  return { ...answer, replaceFrom, stepActions: readStepActions(obj['steps'] as string[], obj['stepActions']) };
}

/** `stepActions` beside the raw `steps`, kept parallel to the cleaned ones —
 *  or undefined when it is not one list of whole numbers (1 or more) per step. */
function readStepActions(rawSteps: readonly string[], raw: unknown): number[][] | undefined {
  if (!Array.isArray(raw) || raw.length !== rawSteps.length) return undefined;
  const lists: number[][] = [];
  for (const entry of raw as unknown[]) {
    if (!Array.isArray(entry)) return undefined;
    if (!entry.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 1)) return undefined;
    lists.push([...(entry as number[])]);
  }
  return cleanSteps(rawSteps).map((s) => lists[s.from]!);
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
 * The parameter half of the file-safety pass — rules the prompt states,
 * enforced rather than hoped for, because Steptix writes what it is given.
 * Applied to every draft, so the panel shows what will be inserted, and
 * idempotent on a draft it already settled.
 *
 * - A parameter the file already has under the same name with a DIFFERENT
 *   value is renamed (`email` → `email_2`) and the steps rewritten to match
 *   (decision 8: "never overwrites an existing line with a different value").
 *   Steptix keeps an existing line as it is, so without this the steps would
 *   silently type the old value. Two `.env` references under one name are the
 *   exception: the model meant the file's own and spelled the variable its own
 *   way, so the file's is kept.
 * - A value that is, or contains, the secret mask is a secret the model could
 *   not see: it becomes `$NAME` (decision 7).
 *
 * Its `notes` say what it CHANGED — they are kept with the draft for the rest
 * of the recording. What is merely TRUE of the draft right now is
 * {@link draftStateNotes}, recomputed every time.
 */
export function settleParameters(answer: RecordStepsAnswer, file: TargetFileSummary): RecordStepsAnswer {
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
  return { steps, parameters, notes };
}

/**
 * What is true of a draft as it stands — recomputed for every draft rather than
 * kept, so a note disappears the moment the model fixes what it was about.
 *
 * - A `{{name}}` the steps use that neither the draft nor the file defines: the
 *   run would fail on it, and the author should hear it now.
 * - A secret-named NEW parameter holding a literal: how a password ends up in a
 *   test file. The recorder never had one to give, so it is worth saying.
 */
export function draftStateNotes(
  steps: readonly string[],
  parameters: ReadonlyArray<{ name: string; value: string }>,
  file: TargetFileSummary,
): string[] {
  const existing = new Set(file.parameters.map((p) => p.name));
  const defined = new Set([...existing, ...parameters.map((p) => p.name)]);
  const undefinedNames = new Set<string>();
  for (const s of steps) {
    for (const m of s.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_.]*)\}\}/g)) {
      const root = m[1]!.split('.')[0]!;
      if (!defined.has(root)) undefinedNames.add(root);
    }
  }
  const notes: string[] = [];
  for (const name of undefinedNames) {
    notes.push(`The steps use {{${name}}}, which no parameter defines — add it under ## Parameters before running.`);
  }
  for (const p of parameters) {
    if (isSecretName(p.name) && !isEnvReference(p.value) && !existing.has(p.name)) {
      notes.push(
        `"${p.name}" looks like a secret but holds a literal value; consider ${envReferenceFor(p.name)} and a .env entry.`,
      );
    }
  }
  return notes;
}

/** Both halves at once: the settled answer with its state notes appended. */
export function reconcileAnswer(answer: RecordStepsAnswer, file: TargetFileSummary): RecordStepsAnswer {
  const settled = settleParameters(answer, file);
  return { ...settled, notes: [...settled.notes, ...draftStateNotes(settled.steps, settled.parameters, file)] };
}

/** Did the model refuse the request because it carried images? */
export function isImageRejection(err: unknown): boolean {
  if (isImageInputUnsupported(err)) return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  // Providers other than the Copilot bridge say it in words, on a 400.
  return /\b4\d\d\b/.test(message) && /image|vision|multimodal/i.test(message);
}

export interface AskForDraftArgs {
  /** The actions this call covers. */
  actions: readonly RecordedAction[];
  /** The draft so far; empty for a full (re)draft. With the toolbar: its
   *  locked and authored steps, and where an inserting call's steps go. */
  draft: NonNullable<RecordStepsPromptInput['draft']>;
  firstActionNumber: number;
  /** Each action's number, parallel to `actions`. */
  actionNumbers?: readonly number[];
  previousAtMs: number;
  file: TargetFileSummary;
  /** Send the covered actions' crops (`ai.sendScreenshots`, and the model has
   *  not rejected images earlier in this recording). */
  sendImages: boolean;
  /** Values that must not reach the model. */
  secrets: readonly string[];
  complete: (messages: ChatMessage[], signal: AbortSignal) => Promise<{ text: string }>;
  signal: AbortSignal;
  /** Called once when the model rejects images and the call is asked again
   *  without them. */
  onImagesRejected: () => void;
}

/**
 * One draft call: build the prompt, ask, read the answer. A model that rejects
 * images (SPEC-use-computer §15.4 — the Copilot bridge, some providers) is asked
 * once more without them. The answer is parsed but not yet checked against the
 * draft — `replaceFrom`'s limit is the draft engine's to enforce.
 */
export async function askForDraft(args: AskForDraftArgs): Promise<DraftAnswer> {
  const withImages = args.sendImages && args.actions.some((a) => a.crop !== undefined);
  const ask = (includeImages: boolean): Promise<{ text: string }> =>
    args.complete(
      buildRecordStepsPrompt({
        actions: args.actions,
        draft: args.draft,
        firstActionNumber: args.firstActionNumber,
        ...(args.actionNumbers !== undefined && { actionNumbers: args.actionNumbers }),
        previousAtMs: args.previousAtMs,
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
    args.onImagesRejected();
    answer = await ask(false);
  }
  return parseDraftAnswer(answer.text);
}
