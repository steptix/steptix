import fs from 'node:fs/promises';
import path from 'node:path';
import type { AIAction } from '../ai/types.js';
import type { ActionTargeting } from '../browser/actions.js';
import type { ObservedRequest } from '../browser/page-state.js';
import type { AssertionResult, StepResult, StepStatus, SubActionResult } from '../report/types.js';
import { logger } from '../utils/logger.js';
import {
  isSecretName,
  secretValues,
  redact,
  redactDeep,
  redactAuthoredMap,
} from '../utils/secrets.js';
import { resolveCodeBehindCacheDir } from './loader.js';

/**
 * The recording a compile generates from, on disk beside the test
 * (stories/codebehind-recording-on-disk.md).
 *
 * `.steptix-codebehind-cache/<name>.recording/` — one JSON per step with what
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

/**
 * One action as the generator reads it: what the AI asked for, plus what the
 * runtime found when it ran it.
 *
 * `targeting` is absent far more often than not — it is measured only in a
 * compile mode, and only for element-targeting actions — and its absence is
 * first-class: a transcript without it generates exactly as it did before the
 * measurement existed.
 */
export type RecordedAction = AIAction & {
  targeting?: ActionTargeting;
  /** Which route an `upload` took, so generation writes the shape that
   *  worked: `setInputFiles` for `'input'`, the file-chooser pattern for
   *  `'chooser'`. */
  upload?: { via: 'input' | 'chooser' };
  /**
   * The page's URL changed while this action ran: from the page it ran on to
   * the one the run was on after it (docs/specs/SPEC-codebehind-robustness.md
   * §6.7). What tells the generator that the entry must wait for another page
   * before anything after this action — a sign-in's click, a submit.
   */
  navigated?: { from: string; to: string };
  /**
   * The first-party requests the action started, observed on the compile run
   * (docs/specs/SPEC-codebehind-robustness.md §6.9): method, path, status, and
   * how long each took. Evidence of what the action does — never something an
   * entry must wait for by name.
   */
  requests?: ObservedRequest[];
};

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
  /**
   * Why a `skipped` step never ran — the runner's own sentence, `Not run: step
   * 3 returned from "Sign in"` (stories/step-flow-control.md, decisions 4 and
   * 12).
   *
   * A field of its own rather than `error`, because a skipped step did not
   * fail and every reader of `error` renders it as a failure. Absent on every
   * other status — and absent on a recording written before this field
   * existed, which a reader must take as "skipped, cause unrecorded" rather
   * than as some different kind of step.
   */
  skipReason?: string;
  /**
   * The step failed and the run continued past it — its own `otherwise
   * continue` tail (stories/step-failure-outcomes.md, decision 6).
   *
   * Recorded beside `status: 'failed'` rather than instead of it, the shape the
   * wire and the report use. What the flag buys a reader of this file is the
   * roll-up below — a recording whose only failure was tolerated is a PASSED
   * recording — and the compile's "no evidence" rule.
   *
   * Absent on every other step, and on a recording written before the field
   * existed, which reads as "not tolerated" and is right.
   */
  tolerated?: boolean;
  /**
   * The step failed because its own text says to — `If … then fail the test with
   * error "…"`, with the condition true on this run
   * (stories/step-failure-outcomes.md, decisions 1–3).
   *
   * Beside `status: 'failed'` for the reason `tolerated` is, though the run it
   * ended IS red and the manifest says so. What the flag buys a reader is the
   * difference between a recording that broke and one that finished where the
   * test says it finishes — the second has a compilable step AT the end.
   *
   * Absent on every other step, and on a recording written before the field
   * existed, which reads as "not deliberate" and is right.
   */
  deliberate?: boolean;
  /**
   * The surface this step ran on (SPEC-use-computer.md §9).
   *
   * The one fact the compile cannot read off the FILE: a shared `### Section`
   * or a skill body runs on whatever surface its caller was on, so whether a
   * given step's coordinates came from a screen or from a DOM is a fact about
   * the RUN. Recorded here so `computer` can be answered with `ai: true` and
   * the reason "coordinates are not portable".
   *
   * Absent means `browser`, which is every step of every recording written
   * before computer mode and every page step after it.
   */
  surface?: 'browser' | 'computer';
  fromCodeBehind?: boolean;
  codeBehindStale?: { file: string; source: string; error: string };
  /**
   * A guard row's decision (stories/codebehind-loops-and-conditions.md,
   * decision 14): who decided, and what — the member selected, or whether a
   * loop condition held — plus the member whose condition entry broke.
   *
   * The DECISION only, never `StepResult.guard.evidence`: that is the page the
   * judge was shown, and it belongs to the run that generates from it, not to
   * a file anyone with the checkout can read. Absent on every ordinary step
   * and on a recording written before the field.
   */
  guard?: {
    decidedBy: 'model' | 'values' | 'code';
    selected?: number | null;
    holds?: boolean;
    staleMember?: number;
  };
  urlBefore?: string;
  urlAfter?: string;
  pageUrl?: string;
  /** The step's transcript as the generator reads it: the actions that ran,
   *  each with what the runtime found when it ran it (see `actionsOf`). */
  actions: RecordedAction[];
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

/** `tests/checkout.md` → `tests/.steptix-codebehind-cache/checkout.recording`. */
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
    // One row per expanded step — the evidence pass (decision 14). A runtime
    // loop re-runs the same indices, so the run's rows carry each body index
    // once per pass; writing them all put every pass through the same
    // `step-NN` slot and left the LAST on disk — the page where the `While`
    // had just gone false, and the last `For each` item.
    let count = 0;
    for (const result of evidenceRows(input.steps)) {
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

/**
 * One row per expanded step: the EVIDENCE pass
 * (stories/codebehind-loops-and-conditions.md, decisions 1 and 14).
 *
 * A runtime loop — `While`, `Repeat … until`, `For each` — re-runs the same
 * expanded indices, so a run's rows hold a body index once per pass. An entry
 * is generated once per authored line, from the first pass that ran it, so
 * that is the row a recording keeps: the first pass that is usable EVIDENCE
 * ({@link isEvidencePass}) — it passed, or failed as its text says, AND has a
 * transcript to generate from. A table-row `### Section` loop is unrolled at
 * expansion — one index per iteration — so it is untouched by this: every row
 * is its own index already.
 *
 * "Has a transcript" is what makes this more than "the first that passed". A
 * pass that ran cleanly AS CODE passed with no turns at all: its entry needs
 * no evidence, and it is none. When the entry then threw on pass 2 and healed
 * under AI, the step joins a compile as stale — and generating from pass 1's
 * empty transcript said "the recorded run performed no page actions" and wrote
 * `ai: true` over a working entry. The healed pass (`codeBehindStale`) is the
 * one with the transcript, and the page its entry broke on. This is the live
 * compiler's rule too: it refuses a clean code run as "ran as code" and takes
 * the healed pass for its repair.
 *
 * When no pass is usable evidence: the first that passed (a step that only
 * ever ran as code), else the first row of all (a step that never passed is
 * recorded as it first failed or was skipped).
 *
 * Hook rows and interactive rows are dropped, as both writers always did.
 * Returned in the order each index first appears, which is the run's order,
 * so a splice claims identity slots in the order the file is written in.
 *
 * Exported so every writer — the server's and the CLI's through
 * `writeRecording`, a Compile This Step's through `spliceRecording`, and the
 * boxed compile's evidence rows — takes the same row for an index.
 */
export function evidenceRows(steps: readonly StepResult[]): StepResult[] {
  const firstSeen: number[] = [];
  const chosen = new Map<number, StepResult>();
  const rank = (r: StepResult): number => (isEvidencePass(r) ? 2 : r.status === 'passed' ? 1 : 0);
  for (const result of steps) {
    if (result.hookScope || result.interactiveAdHoc || result.interactiveChild) continue;
    const held = chosen.get(result.index);
    if (held === undefined) {
      firstSeen.push(result.index);
      chosen.set(result.index, result);
    } else if (rank(result) > rank(held)) {
      chosen.set(result.index, result);
    }
  }
  return firstSeen.map((index) => chosen.get(index)!);
}

/**
 * Is this pass usable evidence — something an entry can be generated from?
 * It passed (or failed as its own text says: `deliberate`), and it has a
 * transcript: it ran under AI, which a clean code run did not — unless its
 * entry threw first and the step healed under AI (`codeBehindStale`).
 */
export function isEvidencePass(result: StepResult): boolean {
  const worked = result.status === 'passed' || result.deliberate === true;
  const transcript = result.fromCodeBehind !== true || result.codeBehindStale !== undefined;
  return worked && transcript;
}

/**
 * A guard row's decision as it goes to disk: who decided and what, never the
 * page the judge was shown (`evidence` stays in the run that generates from
 * it — see {@link RecordedStep.guard}).
 */
function guardDecisionOf(guard: NonNullable<StepResult['guard']>): NonNullable<RecordedStep['guard']> {
  return {
    decidedBy: guard.decidedBy,
    ...(guard.selected !== undefined && { selected: guard.selected }),
    ...(guard.holds !== undefined && { holds: guard.holds }),
    ...(guard.staleMember !== undefined && { staleMember: guard.staleMember }),
  };
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
    // The reason rides only on a skipped step: on a passed one `aiExplanation`
    // is the model's account of what it did, which the transcript already says
    // better (stories/step-flow-control.md, decision 12).
    ...(result.status === 'skipped'
      && result.aiExplanation !== undefined
      && { skipReason: redact(result.aiExplanation, secrets) }),
    // Carried so the splice roll-up below can tell a failure the author declared
    // survivable from one that took the run down (decision 6).
    ...(result.tolerated === true && { tolerated: true }),
    // And a failure the step's own text asked for, which the roll-up does NOT
    // excuse — a deliberate failure ends the run red (decision 2). Recorded
    // because the step is still COMPILABLE: the compile reads it to tell a
    // recording that ended as written from one that broke.
    ...(result.deliberate === true && { deliberate: true }),
    // §9 — which surface answered it. Only `computer` is written: `browser`
    // is what absence has always meant, and stamping it would churn every
    // recording on disk for a field that says nothing new.
    ...(result.surface === 'computer' && { surface: 'computer' as const }),
    ...(result.fromCodeBehind && { fromCodeBehind: true }),
    ...(result.codeBehindStale && { codeBehindStale: result.codeBehindStale }),
    ...(result.guard && { guard: guardDecisionOf(result.guard) }),
    ...(ctx?.urlBefore !== undefined && { urlBefore: ctx.urlBefore }),
    ...(ctx?.urlAfter !== undefined && { urlAfter: ctx.urlAfter }),
    ...(result.pageUrl !== undefined && { pageUrl: result.pageUrl }),
    actions: actionsOf(result).map((a) => redactDeep(a, secrets)),
    // Redacted like every sibling field on this record. An assertion's
    // `actual` and `expected` are page text — a balance, a message, the value
    // a `[store as: password]` step typed and read back — and this is the one
    // field that was written through untouched, so the recording on disk held
    // it in clear beside an `instruction` that said `***` (§7.6).
    ...(result.assertions && { assertions: redactDeep(result.assertions, secrets) }),
    // By the AUTHOR rule on the whole name: a `[store as:]` output is named
    // end to end by the person who wrote the step, so there is no page-derived
    // half for the variable map's two-segment rule to protect. Asked that way,
    // `api.key` split to `key` — which the narrow record rule deliberately
    // leaves clear — and the recording on disk held the credential.
    ...(result.outputs && { outputs: redactAuthoredMap(result.outputs, secrets) }),
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
 * case — Steptix's paths come from `uri.fsPath`, which lower-cases the
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
    // The same one row per index the wholesale writer takes (decision 14). A
    // pass is not a step: splicing each pass claimed the step's slot with pass
    // 1 and then, its identity bucket empty, APPENDED a new slot for pass 2 and
    // another for pass 3 — three recorded steps for one line.
    for (const result of evidenceRows(input.steps)) {
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
      // A skipped step does not make the recording a failed one: a return ends
      // its flow as a PASS, and the run status is unchanged by it
      // (stories/step-flow-control.md, decision 4). Asking whether any step
      // FAILED, rather than whether every step passed, is what keeps a spliced
      // recording that holds one honest.
      //
      // Nor does a TOLERATED failure: a run whose only failures were tolerated
      // passes (stories/step-failure-outcomes.md, decision 6). The wholesale path
      // above takes `input.status`, which the loops computed with that rule
      // applied; this one recomputes from rows of mixed provenance, so it has to
      // ask here too or the same run's recording reads red after a splice and
      // green before it.
      //
      // A DELIBERATE failure is not excused and must not be: the author wrote a
      // step that fails the run, it did, and the run is red (decision 2).
      status: all.some((s) => s.status === 'failed' && s.tolerated !== true) ? 'failed' : 'passed',
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

/**
 * The step's transcript as the generator reads it: the actions that ran, each
 * carrying what the runtime found when it ran it
 * (stories/codebehind-selector-ambiguity.md §"Where the measurement goes").
 *
 * The merge happens HERE, and that placement is load-bearing rather than
 * incidental. `writeRecordedStep` writes the transcript as
 * `actionsOf(result).map((a) => redactDeep(a, secrets))`, so a `targeting`
 * merged in after that map would skip redaction entirely — and
 * `resolvedSelector` can be built from an `aria-label` or an `href` carrying a
 * secret. Merging anywhere later is a leak.
 *
 * Errored sub-actions are dropped: there is nothing to compile from an action
 * that did not happen, so a timed-out wait — the case where the measurement is
 * absent by design — never reaches generation either way.
 *
 * The one exception is the `fail` sub-action of a DELIBERATE failure
 * (stories/step-failure-outcomes.md, decisions 1–3 and 10): it carries an `error`
 * because the error is its PRODUCT — the author's message — not because it failed
 * to happen. Dropped, it leaves the step with an empty transcript, `refuseReason`
 * answers "the recorded run performed no page actions for this step", and the one
 * step the feature exists for is written off `ai: true`. Kept only for a step the
 * runtime marked `deliberate`, so an UNCLAIMED `fail` the model tried and was
 * refused — which also carries an `error` — stays dropped.
 *
 * Lives in this module rather than in `candidate.ts`, which re-exports it,
 * only because every ordinary run already loads this file while `candidate.ts`
 * pulls in prettier and esbuild through the writer. One implementation, in the
 * cheaper of the two places.
 */
export function actionsOf(result: StepResult | undefined): RecordedAction[] {
  const keepFail = result?.deliberate === true;
  return (result?.turns ?? [])
    .flatMap((t) => t.subActions)
    .filter((sa) => !sa.error || (keepFail && sa.action.action === 'fail'))
    .map((sa) => {
      // Here and not later, for `targeting`'s reason: a URL can carry a
      // secret, and the recording redacts what this returns.
      const navigated = navigationOf(sa);
      const requests = sa.requests !== undefined && sa.requests.length > 0 ? sa.requests : undefined;
      if (sa.targeting === undefined && sa.upload === undefined && navigated === undefined && requests === undefined) {
        return sa.action;
      }
      return {
        ...sa.action,
        ...(sa.targeting !== undefined && { targeting: sa.targeting }),
        ...(sa.upload !== undefined && { upload: sa.upload }),
        ...(navigated !== undefined && { navigated }),
        ...(requests !== undefined && { requests }),
      };
    });
}

/**
 * Where an action moved the page, or undefined when it stayed put
 * (docs/specs/SPEC-codebehind-robustness.md §6.7). The runtime records the URL
 * an action RAN on (`actionPageUrl`) only when it differs from the page's URL
 * after it (`pageUrl`), so the pair is the navigation.
 *
 * `pageUrl` is read after the post-action wait, which gives up at 3.5 s: a
 * navigation slower than that is not seen here.
 */
function navigationOf(sa: SubActionResult): { from: string; to: string } | undefined {
  if (sa.actionPageUrl === undefined || sa.pageUrl === undefined) return undefined;
  if (sa.actionPageUrl === sa.pageUrl) return undefined;
  return { from: sa.actionPageUrl, to: sa.pageUrl };
}

