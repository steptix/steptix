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

    let count = 0;
    for (const result of input.steps) {
      if (result.hookScope || result.interactiveAdHoc || result.interactiveChild) continue;
      const name = `step-${String(result.index).padStart(2, '0')}`;
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
        index: result.index,
        instruction: redact(result.instruction, secrets),
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
      await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(step, null, 2), 'utf-8');
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

