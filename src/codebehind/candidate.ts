import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StepResult } from '../report/types.js';
import { logger } from '../utils/logger.js';
import { aiEntryFor, type GeneratedEntry } from './generate.js';
import type { CodeBehindBinding } from './loader.js';
import { resolveCodeBehindCacheDir } from './loader.js';
import {
  createFile,
  entryTextIn,
  formatCodeBehindSource,
  listEntries,
  spliceEntry,
  withoutEntry,
  type WriteEntryRequest,
} from './writer.js';

/**
 * The proposed `.steps.ts` files, in memory, and the small pieces every
 * generation path needs around them.
 *
 * Extracted from `compile.ts` so the boxed pipeline (`compileTest`, the CLI's
 * `steptix compile`) and the live one (`live-compile.ts`, driven by a Run &
 * Compile or a Compile This Step — stories/compile-as-you-go.md) splice
 * entries through **one** implementation. Two copies of "how an entry becomes
 * a file" would only have to disagree once for the diff to propose something
 * the runtime cannot bind.
 */

export type CompilePhase =
  | 'record'
  | 'select'
  | 'generate'
  | 'review'
  | 'replay'
  | 'repair'
  | 'write';

/**
 * One step's place in a compile.
 *
 * `key` identifies the *entry*, not the step: a section or skill body is
 * defined once and inlined many times, so several expanded steps can share one
 * entry. Generation is keyed by entry, which is why the same body compiles once
 * however many times it is called.
 */
export interface CompileStep {
  /** 0-based expanded index. */
  index: number;
  /** 1-based display number. */
  number: number;
  /** Authored text — an entry's `source`. */
  text: string;
  binding?: CodeBehindBinding | undefined;
  key?: string | undefined;
  hasEntry: boolean;
  isAiEntry: boolean;
  /** Why this step can never be in S, when it can't. */
  ineligible?: string | undefined;
  /**
   * `'condition'` for a guard line whose condition the model decides — `If`,
   * `Else if`, `While`, `Repeat … until` — which compiles to a `condition`
   * entry generated from the pages the judge decided on, not from a transcript
   * (stories/codebehind-loops-and-conditions.md, decision 4). Absent on every
   * other step, which compiles to a `run` entry.
   */
  kind?: 'condition' | undefined;
}

/** Joins the parts of an entry key. NUL because it is the one character
 *  neither a path, a section name nor step text can contain — the same choice
 *  the loader's own index makes, built rather than typed so the source file
 *  stays text as far as git is concerned. */
const KEY_SEP = String.fromCharCode(0);

/** Identifies the entry a step binds to. Two inlinings of one body share it. */
export function entryKeyOf(binding: CodeBehindBinding): string {
  return [binding.file, binding.section ?? '', binding.source, binding.occurrence].join(KEY_SEP);
}

/**
 * The proposed `.steps.ts` files, in memory.
 *
 * Nothing here touches the author's tree. Entries are spliced with the same
 * writer the runtime used to use, so hand edits elsewhere in a file survive
 * byte-for-byte; the files only reach disk in the Write phase, and the
 * gitignored `.candidate` copy only when a compile ends red.
 */
export class Candidate {
  private readonly original = new Map<string, string | null>();
  private readonly current = new Map<string, string>();
  private readonly entryText = new Map<string, string>();
  private materialised: string[] = [];
  private persisted: string[] = [];

  /** The file as it stands, loading the on-disk original the first time. */
  async read(file: string): Promise<string | null> {
    if (!this.original.has(file)) {
      this.original.set(file, await readIfExists(file));
    }
    return this.current.get(file) ?? this.original.get(file) ?? null;
  }

  contentOf(file: string): string | undefined {
    return this.current.get(file);
  }

  touchedFiles(): string[] {
    return [...this.current.keys()];
  }

  /** Splice one entry in (or create the file), then format the whole file
   *  (`formatCodeBehindSource`). The section scope is the runner's, stamped
   *  by the writer — never the model's. */
  async apply(step: CompileStep, entryCode: string): Promise<void> {
    const binding = step.binding!;
    const request: WriteEntryRequest = {
      file: binding.file,
      source: binding.source,
      ...(binding.section !== undefined && { section: binding.section }),
      occurrence: binding.occurrence,
      entryCode,
      // The header names the file this code-behind belongs to — which for a
      // skill's entries is the skill, not the test that pulled it in.
      markdownFile: binding.file.replace(/\.steps\.ts$/, '.md'),
    };
    const before = this.current.get(binding.file) ?? this.original.get(binding.file) ?? null;
    this.current.set(
      binding.file,
      await formatCodeBehindSource(
        before === null ? createFile(request) : spliceEntry(before, request).text,
        binding.file,
      ),
    );
    this.entryText.set(entryKeyOf(binding), entryCode);
  }

  /** The entry as last written into the candidate — the repair prompt's input. */
  entryTextFor(step: CompileStep): string | undefined {
    return step.key ? this.entryText.get(step.key) : undefined;
  }

  /**
   * Take back what this compile proposed for one step: put the entry the file
   * on disk had back, or — when it had none — take the compile's entry out
   * (docs/specs/SPEC-codebehind-robustness.md §6.2, a step left without code).
   * Never touches an entry the author has on disk beyond restoring it.
   *
   * False when there was nothing to take back, or when taking it out would let
   * a later identically-worded entry slide into its slot (`withoutEntry`); the
   * caller then falls back to what it did before this existed.
   */
  async retract(step: CompileStep): Promise<boolean> {
    const binding = step.binding;
    if (!binding) return false;
    const current = this.current.get(binding.file);
    if (current === undefined) return false;
    const original = this.original.get(binding.file) ?? null;
    const onDisk =
      original === null
        ? undefined
        : entryTextIn(original, binding.source, binding.section, binding.occurrence);
    const next =
      onDisk !== undefined
        ? spliceEntry(current, {
            file: binding.file,
            source: binding.source,
            ...(binding.section !== undefined && { section: binding.section }),
            occurrence: binding.occurrence,
            entryCode: onDisk,
          }).text
        : withoutEntry(current, binding.source, binding.section, binding.occurrence);
    if (next === undefined) return false;
    const key = entryKeyOf(binding);
    if (onDisk !== undefined) this.entryText.set(key, onDisk);
    else this.entryText.delete(key);
    // A file the compile created and has now emptied is no proposal at all.
    if (original === null && listEntries(next).length === 0) {
      this.current.delete(binding.file);
      return true;
    }
    this.current.set(binding.file, await formatCodeBehindSource(next, binding.file));
    return true;
  }

  async replaceFile(file: string, content: string): Promise<void> {
    this.current.set(file, await formatCodeBehindSource(content, file));
  }

  /** Files whose content differs from what is on disk today. */
  changedFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [file, content] of this.current) {
      if (content !== this.original.get(file)) out[file] = content;
    }
    return out;
  }

  /**
   * Write the candidates somewhere the loader can import them, and return the
   * override map. `.ts` because esbuild picks its loader by extension; inside
   * the gitignored cache dir beside the real file, because a `node_modules`
   * path segment would break the `steptix/codebehind` self-reference.
   */
  async materialise(): Promise<Record<string, string>> {
    const overrides: Record<string, string> = {};
    for (const [file, content] of this.current) {
      const dir = resolveCodeBehindCacheDir(file);
      const target = path.join(
        dir,
        `${path.basename(file, '.ts')}.${randomUUID().slice(0, 8)}.candidate.ts`,
      );
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
      overrides[file] = target;
      this.materialised.push(target);
    }
    return overrides;
  }

  /** Remove the transient copies a replay round imported. */
  async clearMaterialised(): Promise<void> {
    for (const file of this.materialised) {
      await fs.rm(file, { force: true }).catch(() => {});
    }
    this.materialised = [];
  }

  /**
   * Write the candidate where the author can read it — the recording dir,
   * under the name the story gives it — and return the first path (what the
   * summary points at). Called after every stage, so the file is always the
   * compile's latest proposal; after Apply it is identical to the real file.
   */
  async persist(): Promise<string | undefined> {
    this.persisted = [];
    for (const [file, content] of this.current) {
      const target = path.join(
        resolveCodeBehindCacheDir(file),
        `${path.basename(file)}.candidate`,
      );
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
        this.persisted.push(target);
      } catch (err) {
        logger.debug(`Could not write the compile candidate at ${target}: ${String(err)}`);
      }
    }
    return this.persisted[0];
  }
}

export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Splice one generation answer into the candidate and say what happened.
 *
 * Returns the answer, except that a splice the writer refuses — an entry that
 * is not an object literal, a file with no `defineSteps([...])` to append to —
 * becomes an `error`, which every caller already treats as "stop, leave the
 * candidate, report". A throw here would escape `compileTest` entirely.
 */
export async function applyGenerated(
  candidate: Candidate,
  step: CompileStep,
  generated: GeneratedEntry,
  stepEvent: (phase: CompilePhase, step: CompileStep, message: string) => void,
  phase: CompilePhase,
): Promise<GeneratedEntry> {
  try {
    if (generated.kind === 'entry') {
      await candidate.apply(step, generated.code);
      stepEvent(phase, step, phase === 'repair' ? 'repaired' : 'generated');
    } else if (generated.kind === 'declined') {
      await candidate.apply(step, aiEntryFor(step.text, generated.reason));
      stepEvent(phase, step, `kept as AI: ${generated.reason}`);
    }
    return generated;
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
}

/**
 * The step's transcript as the generator reads it — the actions that ran, each
 * carrying the `targeting` the runtime measured for it.
 *
 * Defined in `recording.ts` and re-exported here, where every generation path
 * already imports it from. One implementation, because the merge has to happen
 * before `redactDeep` on the recording path and before the prompt on this one;
 * two copies would only have to disagree once to leak a secret out of a
 * `resolvedSelector`.
 */
export { actionsOf, type RecordedAction } from './recording.js';

/** The page either side of the step, from the run's `stepContext`. */
export function contextOf(result: StepResult | undefined): {
  domBefore?: string;
  urlBefore?: string;
  domAfter?: string;
  urlAfter?: string;
} {
  const ctx = result?.stepContext;
  if (!ctx) return {};
  return {
    ...(ctx.domBefore !== undefined && { domBefore: ctx.domBefore }),
    ...(ctx.urlBefore !== undefined && { urlBefore: ctx.urlBefore }),
    ...(ctx.domAfter !== undefined && { domAfter: ctx.domAfter }),
    ...(ctx.urlAfter !== undefined && { urlAfter: ctx.urlAfter }),
  };
}

/** The whole-test block for one generation prompt. */
export function wholeTestFor(
  steps: CompileStep[],
  inScope: Set<string>,
  current: CompileStep,
): Array<{ index: number; text: string; inScope: boolean; isThisStep: boolean }> {
  return steps.map((s) => ({
    index: s.number,
    text: s.text,
    inScope: s.key !== undefined && inScope.has(s.key),
    isThisStep: s.index === current.index,
  }));
}
