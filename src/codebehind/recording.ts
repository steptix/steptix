import fs from 'node:fs/promises';
import path from 'node:path';
import type { AIAction } from '../ai/types.js';
import type { AssertionResult, StepResult, StepStatus } from '../report/types.js';
import { logger } from '../utils/logger.js';
import { isSecretName, secretValues, redact, redactDeep, redactMap } from '../utils/secrets.js';
import { resolveCodeBehindCacheDir } from './loader.js';

/**
 * The recording a compile generates from, on disk beside the test
 * (stories/codebehind-recording-on-disk.md).
 *
 * `.aiui-codebehind-cache/<name>.recording/` — one JSON per step with what
 * the step did and where it was, the DOM before and after it as files the
 * author can open, and the failure screenshot when there is one. Written by
 * the run that made it, when it ends; replaced wholesale by the next one.
 * The server keeps none of it: a recording is a project file, not session
 * state.
 *
 * Secrets: the values of parameters whose names look secret are redacted
 * from the actions and the DOM before anything is written — the recording is
 * gitignored with the rest of the cache dir, but readable by anyone with the
 * checkout, and a generator reading a redacted value writes `step.getVar`
 * anyway, which is what it is told to do. The environment's secrets — a
 * secret-named env var, a data leaf under a secret-named key — are redacted
 * by the same name rule; the caller passes them as `secrets`
 * (stories/codebehind-env-data.md).
 */

export interface RecordingManifest {
  /** Absolute path of the test. */
  test: string;
  startedAt: string;
  finishedAt: string;
  status: 'passed' | 'failed';
  /** Expanded step count of the test as recorded. */
  steps: number;
  /** Parameter NAMES in play. Never values. */
  parameters: string[];
  source: 'cli' | 'server';
}

export interface RecordedStep {
  /** 1-based expanded step index. */
  index: number;
  instruction: string;
  /**
   * The step's AUTHORED text — an entry's `source` — where `instruction` is
   * the expanded, `{{param}}`-carrying line the runner executed. This plus
   * `section` is the identity a single-step splice matches on
   * (stories/compile-as-you-go.md §The recording), which is why it is never
   * the index: a Compile This Step request only knows the steps it was sent,
   * not where they sit in the test.
   *
   * Optional so a recording written before this field, or by a caller that
   * has no binding for the step, still reads back — the match then falls
   * back to `instruction`.
   */
  source?: string;
  /** Section scope of the step's entry, part of the splice identity. */
  section?: string;
  /**
   * 0-based occurrence of this (section, source) pair within its frame — the
   * third part of the splice identity. A section body that says "Press Enter"
   * twice yields two steps identical in every other way, and without this a
   * splice of the second would overwrite the first.
   */
  occurrence?: number;
  /**
   * The entry's target `.steps.ts` (the binding's `file`) — the fourth part
   * of the splice identity. A skill-body step and a test-frame step can share
   * authored text, an empty section and occurrence 0; only the file they bind
   * into tells them apart, and without it a skill-step splice would claim the
   * test step's slot (first in file order) and overwrite its evidence.
   * Optional so recordings written before the field still read and splice.
   */
  file?: string;
  /**
   * When THIS step's files were written. A wholesale recording stamps them
   * all the same; a splice stamps only the step it replaced, so the author
   * can see that step 3's recording is from Tuesday and step 7's from just
   * now.
   */
  recordedAt?: string;
  status: StepStatus;
  error?: string;
  fromCodeBehind?: boolean;
  codeBehindStale?: { file: string; source: string; error: string };
  urlBefore?: string;
  urlAfter?: string;
  pageUrl?: string;
  /** The step's transcript as the generator reads it: the actions that ran. */
  actions: AIAction[];
  assertions?: AssertionResult[];
  outputs?: Record<string, string>;
  durationMs: number;
  /** File names, relative to the recording dir. */
  files: { before?: string; after?: string; screenshot?: string };
}

export interface RecordingInput {
  /** The run's step results, hook rows and interactive rows included — they
   *  are dropped here, as `reportToOutcome` drops them. */
  steps: StepResult[];
  status: 'passed' | 'failed';
  startedAt: string;
  /** The resolved parameter map. Names go in the manifest; values whose name
   *  looks secret are redacted wherever they appear. */
  parameters: Record<string, string>;
  /** Further values to redact: the environment's secrets, from
   *  `envDataSecretValues`. Never named in the manifest. */
  secrets?: string[] | undefined;
  source: 'cli' | 'server';
  /**
   * Authored text + section scope per 1-based step index, from the run's
   * code-behind bindings. Stamped onto each step so a later splice can find
   * it by identity rather than by position.
   */
  identities?:
    | Record<
        number,
        {
          source: string;
          section?: string | undefined;
          occurrence?: number | undefined;
          file?: string | undefined;
        }
      >
    | undefined;
}

const DIR_SUFFIX = '.recording';

/** `tests/checkout.md` → `tests/.aiui-codebehind-cache/checkout.recording`. */
export function recordingDirFor(testFilePath: string): string {
  const resolved = path.resolve(testFilePath);
  const base = path.basename(resolved, path.extname(resolved));
  return path.join(resolveCodeBehindCacheDir(resolved), `${base}${DIR_SUFFIX}`);
}

/** The rule and the masking live in `src/utils/secrets.ts` now, shared with
 *  the console step line and the report; re-exported for the callers that
 *  learned them here. */
export { isSecretName, secretValues, redact };

/** Comparable form of a `.steps.ts` path — see `fileKey` below. Exported so
 *  every consumer of the recording/sidecar `file` discriminator folds drive
 *  case the same way. */
export function codeBehindFileKey(file: string | undefined): string | undefined {
  return fileKey(file);
}

/**
 * Write a run's recording. Replaces any earlier one for the test, so the
 * directory always describes the latest recording and nothing else.
 *
 * Never throws: a recording that could not be written is a warning, not a
 * failed run — the run itself already happened.
 */
export async function writeRecording(testFilePath: string, input: RecordingInput): Promise<string | null> {
  const dir = recordingDirFor(testFilePath);
  const secrets = secretValues(input.parameters, input.secrets);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });

    const recordedAt = new Date().toISOString();
    let count = 0;
    for (const result of input.steps) {
      if (result.hookScope || result.interactiveAdHoc || result.interactiveChild) continue;
      await writeRecordedStep(dir, result, {
        at: result.index,
        secrets,
        recordedAt,
        ...(input.identities?.[result.index] && { identity: input.identities[result.index]! }),
      });
      count++;
    }

    const manifest: RecordingManifest = {
      test: path.resolve(testFilePath),
      startedAt: input.startedAt,
      finishedAt: new Date().toISOString(),
      status: input.status,
      steps: count,
      parameters: Object.keys(input.parameters),
      source: input.source,
    };
    await fs.writeFile(path.join(dir, 'recording.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    return dir;
  } catch (err) {
    logger.warn(`Could not write the recording at ${dir}: ${String(err)}`);
    return null;
  }
}

/** File-name stem for a step slot: `step-07`. */
function stemFor(index: number): string {
  return `step-${String(index).padStart(2, '0')}`;
}

/**
 * Write one step's JSON and its DOM/screenshot files into a recording dir,
 * under the slot `at` — which is the step's own index for a wholesale
 * recording and the matched step's index for a splice, so a spliced step
 * keeps its filenames.
 */
async function writeRecordedStep(
  dir: string,
  result: StepResult,
  options: {
    at: number;
    secrets: string[];
    recordedAt: string;
    identity?: {
      source: string;
      section?: string | undefined;
      occurrence?: number | undefined;
      file?: string | undefined;
    };
  },
): Promise<RecordedStep> {
  const { at, secrets, recordedAt, identity } = options;
  const name = stemFor(at);
  const files: RecordedStep['files'] = {};
  const ctx = result.stepContext;
  if (ctx?.domBefore !== undefined) {
    files.before = `${name}.before.html`;
    await fs.writeFile(path.join(dir, files.before), redact(ctx.domBefore, secrets), 'utf-8');
  }
  if (ctx?.domAfter !== undefined) {
    files.after = `${name}.after.html`;
    await fs.writeFile(path.join(dir, files.after), redact(ctx.domAfter, secrets), 'utf-8');
  }
  if (result.status !== 'passed' && result.screenshotBase64) {
    files.screenshot = `${name}.failure.png`;
    await fs.writeFile(path.join(dir, files.screenshot), Buffer.from(result.screenshotBase64, 'base64'));
  }
  const step: RecordedStep = {
    index: at,
    instruction: redact(result.instruction, secrets),
    ...(identity?.source !== undefined && { source: redact(identity.source, secrets) }),
    ...(identity?.section !== undefined && { section: identity.section }),
    ...(identity?.occurrence !== undefined && { occurrence: identity.occurrence }),
    ...(identity?.file !== undefined && { file: identity.file }),
    recordedAt,
    status: result.status,
    ...(result.error !== undefined && { error: redact(result.error, secrets) }),
    ...(result.fromCodeBehind && { fromCodeBehind: true }),
    ...(result.codeBehindStale && { codeBehindStale: result.codeBehindStale }),
    ...(ctx?.urlBefore !== undefined && { urlBefore: ctx.urlBefore }),
    ...(ctx?.urlAfter !== undefined && { urlAfter: ctx.urlAfter }),
    ...(result.pageUrl !== undefined && { pageUrl: result.pageUrl }),
    actions: actionsOf(result).map((a) => redactDeep(a, secrets)),
    ...(result.assertions && { assertions: result.assertions }),
    ...(result.outputs && { outputs: redactMap(result.outputs, secrets) }),
    durationMs: result.durationMs,
    files,
  };
  // A slot being rewritten may hold files this run does not produce — a
  // screenshot from a step that failed last time and passed now. Left behind
  // they would read as this recording's evidence.
  for (const stale of ['before.html', 'after.html', 'failure.png'] as const) {
    const key = stale === 'before.html' ? 'before' : stale === 'after.html' ? 'after' : 'screenshot';
    if (files[key] === undefined) {
      await fs.rm(path.join(dir, `${name}.${stale}`), { force: true }).catch(() => {});
    }
  }
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(step, null, 2), 'utf-8');
  return step;
}

/**
 * The identity a splice matches a recorded step by: section scope, the
 * authored text, and the occurrence of that pair within its frame — the same
 * three parts the code-behind binding uses, so a spliced step lands in the
 * slot the runtime would bind to. The binding's target FILE is deliberately
 * not part of this key — it is the claim's tie-break (`claimSlot`), so a
 * recording written before the field existed still matches.
 *
 * Falls back to the executed instruction for a recording written before
 * `source` existed, and to occurrence 0 for one written before `occurrence`
 * did: a mixed-provenance dir still splices, it just cannot tell two
 * identical pre-existing steps apart — which is what it could never do.
 */
function identityKey(step: {
  source?: string;
  instruction: string;
  section?: string;
  occurrence?: number;
}): string {
  const nul = String.fromCharCode(0);
  return [step.section ?? '', (step.source ?? step.instruction).trim(), step.occurrence ?? 0].join(nul);
}

/**
 * A comparable form of a `.steps.ts` path.
 *
 * The discriminator is compared across writers that do not agree on drive
 * case — TestBench's paths come from `uri.fsPath`, which lower-cases the
 * drive, while a CLI or MCP caller's usually does not (the same hazard
 * `compileLockKey` folds for the lock). Comparing raw would leave a splice
 * with no slot to claim, and it would append a duplicate rather than replace.
 */
function fileKey(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The slot an incoming step may claim from its identity bucket, or undefined
 * when it must open a new one. Removes the claimed slot from the bucket.
 *
 * The bucket key carries no file, so a skill-body step and a test-frame step
 * with the same text, empty section and occurrence 0 share a bucket — and
 * the first slot in file order used to win, letting a skill-step splice
 * overwrite the test step's evidence. The file settles it: a filed incoming
 * step claims its own file's slot first, then an unfiled (pre-field) slot,
 * and NEVER a slot recorded for a different file. An unfiled incoming step —
 * an older caller — claims the first slot, as it always did.
 */
function claimSlot(
  bucket: Array<{ index: number; file?: string | undefined }> | undefined,
  incomingFile: string | undefined,
): number | undefined {
  if (!bucket || bucket.length === 0) return undefined;
  let pick = 0;
  if (incomingFile !== undefined) {
    const want = fileKey(incomingFile);
    pick = bucket.findIndex((s) => fileKey(s.file) === want);
    if (pick < 0) pick = bucket.findIndex((s) => s.file === undefined);
    if (pick < 0) return undefined;
  }
  return bucket.splice(pick, 1)[0]!.index;
}

/**
 * Splice a short run's steps into the recording that is already on disk
 * (stories/compile-as-you-go.md §The recording).
 *
 * A Run & Compile replaces the recording wholesale — it is a full run, and its
 * recording supersedes the old one entirely. A Compile This Step cannot: it
 * knows only the steps it was sent, and replacing wholesale would delete every
 * other step's recording. So it overwrites the matched step's JSON, DOM files
 * and screenshot, leaves the siblings, and stamps the step with its own
 * `recordedAt`.
 *
 * Matched by identity — authored text plus section scope, the same key the
 * binding uses — never by index. An unmatched step is appended beyond the
 * current highest index rather than guessed at.
 *
 * Never throws, for the reason `writeRecording` does not: the run already
 * happened.
 */
export async function spliceRecording(
  testFilePath: string,
  input: RecordingInput,
): Promise<string | null> {
  const dir = recordingDirFor(testFilePath);
  const secrets = secretValues(input.parameters, input.secrets);
  try {
    await fs.mkdir(dir, { recursive: true });
    const existing = await readManifestAndSteps(dir);
    // Every recorded step, by identity, in file order — each claimed at most
    // once so two sends of the same text splice into two different slots.
    const bySlot = new Map<number, RecordedStep>();
    const unclaimed = new Map<string, Array<{ index: number; file?: string | undefined }>>();
    for (const step of existing.steps) {
      bySlot.set(step.index, step);
      const key = identityKey(step);
      const slot = { index: step.index, file: step.file };
      const bucket = unclaimed.get(key);
      if (bucket) bucket.push(slot);
      else unclaimed.set(key, [slot]);
    }
    let nextFree = existing.steps.reduce((max, s) => Math.max(max, s.index), 0) + 1;

    const recordedAt = new Date().toISOString();
    const spliced: number[] = [];
    for (const result of input.steps) {
      if (result.hookScope || result.interactiveAdHoc || result.interactiveChild) continue;
      const identity = input.identities?.[result.index];
      const key = identityKey({
        instruction: result.instruction,
        ...(identity?.source !== undefined && { source: identity.source }),
        ...(identity?.section !== undefined && { section: identity.section }),
        ...(identity?.occurrence !== undefined && { occurrence: identity.occurrence }),
      });
      const at = claimSlot(unclaimed.get(key), identity?.file) ?? nextFree++;
      const written = await writeRecordedStep(dir, result, {
        at,
        secrets,
        recordedAt,
        ...(identity && { identity }),
      });
      bySlot.set(at, written);
      spliced.push(at);
    }

    // Mixed provenance by construction, so the manifest describes the dir as
    // it now stands rather than this run: the status is the union, and the
    // parameter names are the union too.
    const all = [...bySlot.values()];
    const manifest: RecordingManifest = {
      test: path.resolve(testFilePath),
      startedAt: existing.manifest?.startedAt ?? input.startedAt,
      finishedAt: new Date().toISOString(),
      status: all.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      steps: all.length,
      parameters: [...new Set([...(existing.manifest?.parameters ?? []), ...Object.keys(input.parameters)])],
      source: input.source,
    };
    await fs.writeFile(path.join(dir, 'recording.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    logger.debug(`Spliced ${spliced.length} step(s) into the recording at ${dir}`);
    return dir;
  } catch (err) {
    logger.warn(`Could not splice the recording at ${dir}: ${String(err)}`);
    return null;
  }
}

/** The manifest and step records already in a recording dir, or empty. */
async function readManifestAndSteps(
  dir: string,
): Promise<{ manifest: RecordingManifest | null; steps: RecordedStep[] }> {
  let manifest: RecordingManifest | null = null;
  const steps: RecordedStep[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { manifest, steps };
  }
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'recording.json'), 'utf-8')) as RecordingManifest;
  } catch {
    // A dir with step files and no readable manifest still splices.
  }
  for (const file of names.filter((f) => /^step-\d+\.json$/.test(f)).sort()) {
    try {
      steps.push(JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8')) as RecordedStep);
    } catch {
      // Unreadable step file: leave it alone rather than claiming its slot.
    }
  }
  return { manifest, steps };
}

export interface ReplayFailure {
  round: number;
  /** 1-based expanded step. */
  step: number;
  line?: number;
  error: string;
  url?: string;
  /** The page at the failure, when the run captured it. */
  screenshotBase64?: string;
  /** The DOM at the failure, when the run captured it. */
  dom?: string;
}

/**
 * A replay round's failure, beside the recording: the evidence the repair
 * prompt is given, for the author to see too. Never throws.
 */
export async function writeReplayFailure(
  testFilePath: string,
  failure: ReplayFailure,
  parameters: Record<string, string> = {},
  extraSecrets: string[] = [],
): Promise<void> {
  const dir = recordingDirFor(testFilePath);
  const secrets = secretValues(parameters, extraSecrets);
  const name = `replay-${failure.round}.failure`;
  try {
    await fs.mkdir(dir, { recursive: true });
    const files: { screenshot?: string; dom?: string } = {};
    if (failure.screenshotBase64) {
      files.screenshot = `${name}.png`;
      await fs.writeFile(path.join(dir, files.screenshot), Buffer.from(failure.screenshotBase64, 'base64'));
    }
    if (failure.dom !== undefined) {
      files.dom = `${name}.html`;
      await fs.writeFile(path.join(dir, files.dom), redact(failure.dom, secrets), 'utf-8');
    }
    await fs.writeFile(
      path.join(dir, `${name}.json`),
      JSON.stringify(
        {
          round: failure.round,
          step: failure.step,
          ...(failure.line !== undefined && { line: failure.line }),
          error: redact(failure.error, secrets),
          ...(failure.url !== undefined && { url: failure.url }),
          files,
        },
        null,
        2,
      ),
      'utf-8',
    );
  } catch (err) {
    logger.warn(`Could not write the replay failure at ${dir}: ${String(err)}`);
  }
}

export interface Recording {
  manifest: RecordingManifest;
  /** Indexed by `index - 1`, sparse where the run has nothing. */
  steps: (RecordedStep & { domBefore?: string; domAfter?: string })[];
}

/** Read a recording back, DOM files included. Null when there is none or it
 *  does not parse. */
export async function readRecording(testFilePath: string): Promise<Recording | null> {
  const dir = recordingDirFor(testFilePath);
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'recording.json'), 'utf-8')) as RecordingManifest;
    const names = (await fs.readdir(dir)).filter((f) => /^step-\d+\.json$/.test(f)).sort();
    const steps: Recording['steps'] = [];
    for (const file of names) {
      const step = JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8')) as RecordedStep;
      const domBefore = step.files.before
        ? await fs.readFile(path.join(dir, step.files.before), 'utf-8')
        : undefined;
      const domAfter = step.files.after
        ? await fs.readFile(path.join(dir, step.files.after), 'utf-8')
        : undefined;
      steps[step.index - 1] = {
        ...step,
        ...(domBefore !== undefined && { domBefore }),
        ...(domAfter !== undefined && { domAfter }),
      };
    }
    return { manifest, steps };
  } catch {
    return null;
  }
}

function actionsOf(result: StepResult): AIAction[] {
  return result.turns.flatMap((t) => t.subActions).filter((sa) => !sa.error).map((sa) => sa.action);
}

