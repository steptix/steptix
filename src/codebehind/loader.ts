import fs from 'node:fs/promises';
import path from 'node:path';
import { matchText } from '../parser/section-match.js';
import type { ExpandedFrame, ExpandedStepOrigin } from '../skills/expander.js';
import { bundleAndImport } from '../tools/reload.js';
import { logger } from '../utils/logger.js';
import type { StepCodeEntry } from './types.js';

/**
 * Code-behind resolution: which `.steps.ts` each expanded step binds into,
 * which entry it matches, and the variable scope its code runs under.
 * See stories/step-codebehind.md ("Sections and skills", "Execution").
 *
 * Everything here runs once at test load, after skill/section expansion,
 * where both the authored raw text and the origin frames are still in hand.
 * The result is a registry carried into the executor alongside the other
 * per-run state (`structureMemo`, `uploadPaths`).
 */

/** Name of the temp-module cache directory created beside a `.steps.ts`. */
export const CODEBEHIND_CACHE_DIRNAME = '.steptix-codebehind-cache';

/**
 * Where to write temp code-behind modules for a `.steps.ts`: a dot-directory
 * **beside the source file**, for the reason spelled out in
 * [resolveToolCacheDir](../tools/reload.ts) — a `node_modules` path segment
 * makes Node's `LOOKUP_PACKAGE_SCOPE` return null, and the package
 * self-reference `steptix/codebehind` becomes unresolvable.
 */
export function resolveCodeBehindCacheDir(stepsFile: string): string {
  return path.join(path.dirname(path.resolve(stepsFile)), CODEBEHIND_CACHE_DIRNAME);
}

/** `tests/github.md` → `tests/github.steps.ts`. */
export function codeBehindPathFor(markdownFile: string): string {
  const resolved = path.resolve(markdownFile);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved, path.extname(resolved));
  return path.join(dir, `${base}.steps.ts`);
}

/**
 * The variable view a code-behind entry runs under.
 *
 * `renames` is the executing skill frame's `varScope` — authored name to the
 * `__skill<N>_`/alias name the expander rewrote the step text to. `inputs` is
 * that frame's caller-supplied parameter values, which the expander
 * interpolated straight into the text and so exist under no name at all.
 * Both empty for a step at the top level or in a plain section.
 */
export interface CodeBehindVarScope {
  renames: Record<string, string>;
  inputs: Record<string, string>;
}

const EMPTY_SCOPE: CodeBehindVarScope = { renames: {}, inputs: {} };

/**
 * One expanded step's code-behind binding. Mutable in exactly one way: the
 * executor clears `entry` when the code throws, which discards it for the rest
 * of the run (the registry hands out the same object on every lookup, so a
 * re-executed step stays healed). A guard's `condition` entry is discarded the
 * same way by `evaluateGuard`, so a `While` whose code threw on pass 2 asks the
 * model on every later pass rather than throwing again.
 */
export interface CodeBehindBinding {
  /** Absolute path of the `.steps.ts` this step's entry lives in. */
  file: string;
  /** `section` scope an entry must carry to match, or undefined for none. */
  section?: string;
  /** The step's authored raw text — an entry's `source`. */
  source: string;
  /**
   * 0-based occurrence of this (section, source) pair **within this step's
   * own frame instance**. A section or skill body is defined once and inlined
   * many times; every invocation is its own frame and matching restarts, so
   * all invocations bind to the same entries in body order.
   */
  occurrence: number;
  scope: CodeBehindVarScope;
  /** The matched entry, or undefined (no entry, or discarded after failure). */
  entry?: StepCodeEntry | undefined;
}

/** Bindings already warned about by {@link warnBindingOnce}. Weak, because a
 *  binding lives exactly as long as its run's registry. */
const warnedBindings = new WeakSet<CodeBehindBinding>();

/**
 * Warn about a binding once per run, however many times its line is visited.
 *
 * For an entry in the wrong place — a `condition` entry on an ordinary step, a
 * `run` entry on a guard (stories/codebehind-loops-and-conditions.md). The
 * entry is not broken, so it is not discarded, and a `While` visited 25 times
 * would otherwise say the same sentence 25 times. Keyed by the binding object,
 * which the registry hands out unchanged on every lookup and rebuilds for
 * every run.
 */
export function warnBindingOnce(
  binding: CodeBehindBinding,
  message: string,
  warn: (message: string) => void = (m) => logger.warn(m),
): void {
  if (warnedBindings.has(binding)) return;
  warnedBindings.add(binding);
  warn(message);
}

/**
 * Per-run code-behind lookup, parallel to the expanded step list.
 *
 * A binding exists for every step whose defining file is known — even when no
 * entry matched, because generation needs the target file, scope and
 * occurrence to write to.
 */
export class CodeBehindRegistry {
  constructor(
    private readonly bindings: (CodeBehindBinding | undefined)[],
    /**
     * Code-behind files that exist but could not be loaded — a syntax error,
     * an import that does not resolve. Each is also warned about, and its
     * steps fall back to AI, which is right for a run and wrong for a strict
     * replay: a compile asking "does this code work on its own" must not get
     * "yes" because the code never ran. Caught live: a project with no
     * `node_modules` replayed 4/4 "as code" under AI and the compile went green.
     */
    readonly loadErrors: ReadonlyArray<{ file: string; error: string }> = [],
  ) {}

  /** The binding for expanded step `index` (0-based), if any. */
  bindingFor(index: number): CodeBehindBinding | undefined {
    return this.bindings[index];
  }

  /** True when at least one step matched an executable entry. */
  get hasEntries(): boolean {
    return this.bindings.some((b) => b?.entry !== undefined);
  }

  /** Empty registry — nothing binds. Used where code-behind is not wired. */
  static empty(): CodeBehindRegistry {
    return new CodeBehindRegistry([]);
  }
}

/** The expansion facts binding needs. Satisfied by `SkillExpansion` and by
 *  `ParsedTest.expansion` + `steps`. */
export interface CodeBehindExpansion {
  steps: string[];
  /** Parallel to `steps` — authored match-side text (`SkillExpansion.rawSteps`). */
  rawSteps: string[];
  origins: ExpandedStepOrigin[];
  frames: Record<string, ExpandedFrame>;
}

export interface BuildRegistryOptions {
  /** Absolute path of the test file. Steps at the top level bind into its
   *  sibling `.steps.ts`; without it those steps get no binding. */
  testFilePath?: string | undefined;
  /** Warning sink; defaults to `logger.warn`. */
  onWarn?: ((message: string) => void) | undefined;
  /**
   * Load some code-behind from somewhere else: canonical `.steps.ts` path →
   * the path to import in its place (stories/codebehind-compile.md, "Replay").
   *
   * Compile's replay proves a candidate runs as pure code *before* anything is
   * written, so it needs the registry pointed at a file the author's tree does
   * not contain. Bindings keep reporting the canonical `file`, because that is
   * where an entry would be written and what the report should name — only the
   * import target moves.
   *
   * The override must be a `.ts` path esbuild can bundle, and must not sit
   * under a `node_modules` segment (see `resolveCodeBehindCacheDir`).
   */
  candidateFiles?: Record<string, string> | undefined;
}

/**
 * Resolve every expanded step to its defining file + scope, load each distinct
 * `.steps.ts` once, and align entries to steps.
 *
 * Never throws for a missing or broken code-behind file: a file that won't
 * load is reported and the whole test falls back to AI, which is the same
 * outcome as not having written one.
 */
export async function buildCodeBehindRegistry(
  expansion: CodeBehindExpansion,
  options: BuildRegistryOptions = {},
): Promise<CodeBehindRegistry> {
  const warn = options.onWarn ?? ((m: string) => logger.warn(m));
  const testFilePath = options.testFilePath
    ? path.resolve(options.testFilePath)
    : undefined;

  // Pass 1 — target (file, section, occurrence, scope) per step. Occurrence
  // counting is keyed by the frame INSTANCE, so it restarts for every
  // inlining of a section or skill body (issue 037's instability, avoided by
  // construction).
  const perFrameCounts = new Map<string, number>();
  const targets: (Omit<CodeBehindBinding, 'entry'> | undefined)[] = [];
  const filesNeeded = new Set<string>();

  for (let i = 0; i < expansion.steps.length; i++) {
    const origin = expansion.origins[i];
    const frameId = origin?.frameId ?? '';
    const site = resolveDefiningSite(frameId, expansion.frames, testFilePath);
    if (!site) {
      targets.push(undefined);
      continue;
    }
    const source = (expansion.rawSteps[i] ?? expansion.steps[i] ?? '').trim();
    const scopeKey = site.section ? matchText(site.section) : '';
    const counterKey = `${frameId}\u0000${scopeKey}\u0000${source}`;
    const seen = perFrameCounts.get(counterKey) ?? 0;
    perFrameCounts.set(counterKey, seen + 1);
    // A selection that narrows a section's body drops steps this frame would
    // otherwise have counted. `occurrenceOffset` is how many of the dropped
    // ones carried this same text ahead of this step, so the sum is the slot
    // it holds in the AUTHORED body: a body whose third `Click Next` is the
    // only one selected still binds the third entry, not the first. Absent
    // (and zero) everywhere else, which is every run that narrows nothing.
    const occurrence = seen + (origin?.occurrenceOffset ?? 0);

    const stepsFile = codeBehindPathFor(site.file);
    filesNeeded.add(stepsFile);
    targets.push({
      file: stepsFile,
      ...(site.section !== undefined && { section: site.section }),
      source,
      occurrence,
      scope: varScopeFor(frameId, expansion.frames),
    });
  }

  // Pass 2 — load each distinct file once, however many frames resolve to it.
  // A candidate override swaps only what gets imported; every binding still
  // names the canonical file.
  const loaded = new Map<string, LoadedCodeBehind>();
  for (const file of filesNeeded) {
    const from = options.candidateFiles?.[file];
    loaded.set(
      file,
      await loadCodeBehindFile(
        from ? path.resolve(from) : file,
        warn,
        // Temp modules always land in the CANONICAL file's cache dir, so a
        // candidate living inside that dir doesn't nest another one.
        resolveCodeBehindCacheDir(file),
      ),
    );
  }

  // Pass 3 — align. An entry is claimed at most once per (frame, scope,
  // source, occurrence); leftovers are reported so a renamed step doesn't
  // leave dead code sitting unnoticed in a committed file.
  const claimed = new Map<string, Set<StepCodeEntry>>();
  const bindings: (CodeBehindBinding | undefined)[] = targets.map((target) => {
    if (!target) return undefined;
    const file = loaded.get(target.file);
    const entry = file?.lookup(target.section, target.source, target.occurrence);
    if (entry) {
      let set = claimed.get(target.file);
      if (!set) { set = new Set(); claimed.set(target.file, set); }
      set.add(entry);
    }
    return { ...target, ...(entry !== undefined && { entry }) };
  });

  for (const [file, load] of loaded) {
    const used = claimed.get(file) ?? new Set<StepCodeEntry>();
    for (const entry of load.entries) {
      if (used.has(entry)) continue;
      warn(
        `Code-behind entry in ${file} matches no step: ${describeEntry(entry)}. ` +
          `It is ignored at runtime and never deleted — if the step text was ` +
          `edited, the entry is stale and can be removed by hand.`,
      );
    }
  }

  const loadErrors: Array<{ file: string; error: string }> = [];
  for (const [file, load] of loaded) {
    if (load.error !== undefined) loadErrors.push({ file, error: load.error });
  }
  return new CodeBehindRegistry(bindings, loadErrors);
}

/**
 * The nearest-enclosing-frame rule (stories/step-codebehind.md):
 *
 * | Nearest frame | Defining file | Scope |
 * |---|---|---|
 * | top level (`''`) | the test file | none |
 * | `kind: 'skill'`  | that skill's file | none |
 * | `kind: 'section'`| the frame's `uri` | the section's name |
 *
 * A section frame's `uri` is already the file that *defines* it — the test
 * file, or the skill file for a skill-internal section — so nothing extra is
 * needed to make a skill-internal section land in the skill's `.steps.ts`.
 */
function resolveDefiningSite(
  frameId: string,
  frames: Record<string, ExpandedFrame>,
  testFilePath: string | undefined,
): { file: string; section?: string } | undefined {
  const frame = frameId ? frames[frameId] : undefined;
  if (!frame) {
    // Top level, or a frame id with no record (a caller that supplied origins
    // without frames). Either way the step belongs to the test file.
    return testFilePath ? { file: testFilePath } : undefined;
  }
  if (frame.kind === 'section') {
    return frame.skillName !== undefined
      ? { file: frame.uri, section: frame.skillName }
      : { file: frame.uri };
  }
  return { file: frame.uri };
}

/**
 * Variable view for a step, composed along its frame chain.
 *
 * Two different rules, because the two things a scope carries answer
 * different questions:
 *
 *  - `renames` come from the nearest ancestor **skill** frame alone. They are
 *    that skill instance's `__skill<N>_` namespace, and an outer skill's
 *    namespace is not this one's.
 *  - `inputs` are merged from **every** enclosing frame that has them,
 *    innermost winning. A looped section binds its row as `inputs`
 *    (stories/data-driven-rows.md, part B), and a body step inside one needs
 *    to read that row — including from inside a skill the body calls, and
 *    including the enclosing row of an outer loop, which is what makes a
 *    nested loop's `{{account}}` resolve.
 *
 * Before section rows this walked to the nearest skill frame and returned an
 * empty scope for anything else, so a looped body's `{{file}}` reached the
 * generator with no name→value pair at all: it would inline row 1's literal
 * with the leak guard blind, and `getVar('file')` would read `undefined` at
 * replay.
 */
function varScopeFor(
  frameId: string,
  frames: Record<string, ExpandedFrame>,
): CodeBehindVarScope {
  let current: ExpandedFrame | undefined = frameId ? frames[frameId] : undefined;
  const seen = new Set<string>();
  let renames: Record<string, string> | undefined;
  /** Innermost-first, so the merge below can let the innermost win. */
  const inputLayers: Array<Record<string, string>> = [];

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.inputs) inputLayers.push(current.inputs);
    // First skill ancestor wins the namespace, but the walk continues: an
    // outer looped section's row is still in scope for a step inside it.
    if (renames === undefined && current.kind === 'skill') {
      renames = current.varScope ?? {};
    }
    current = current.parentId ? frames[current.parentId] : undefined;
  }

  if (renames === undefined && inputLayers.length === 0) return EMPTY_SCOPE;

  const inputs: Record<string, string> = {};
  // Outermost first, so an inner layer overwrites an outer one of the same
  // name — the shadowing rule a nested loop needs.
  for (const layer of inputLayers.reverse()) Object.assign(inputs, layer);

  return { renames: renames ?? {}, inputs };
}

interface LoadedCodeBehind {
  entries: StepCodeEntry[];
  lookup(
    section: string | undefined,
    source: string,
    occurrence: number,
  ): StepCodeEntry | undefined;
  /** Why the file yielded no entries, when it exists and failed to load. */
  error?: string;
}

const EMPTY_LOAD: LoadedCodeBehind = { entries: [], lookup: () => undefined };

/**
 * Import one `.steps.ts` and index its entries by (section scope, source).
 *
 * Uses the tool layer's esbuild bundle-per-load so an edited file on a
 * long-lived server is re-read rather than served from tsx's path-keyed
 * transpile cache (issue 033), and so sourcemaps let a debugger step into the
 * author's `.ts`.
 */
async function loadCodeBehindFile(
  file: string,
  warn: (message: string) => void,
  cacheDir: string = resolveCodeBehindCacheDir(file),
): Promise<LoadedCodeBehind> {
  // Stat first. Most tests have no code-behind, and without this every step
  // batch would pay an esbuild load to discover that — and `bundleToolModule`
  // would create an `.steptix-codebehind-cache` dir beside every test file on the
  // way to failing.
  try {
    await fs.access(file);
  } catch {
    return EMPTY_LOAD;
  }

  let entries: StepCodeEntry[];
  try {
    const { module } = await bundleAndImport(file, cacheDir);
    const exported = module['default'];
    if (!Array.isArray(exported)) {
      warn(
        `Code-behind file ${file} must default-export defineSteps([...]) — ` +
          `got ${exported === undefined ? 'no default export' : typeof exported}. Ignoring it.`,
      );
      return EMPTY_LOAD;
    }
    entries = exported as StepCodeEntry[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A missing sibling file is the normal case, not a problem: most tests
    // have no code-behind. Anything else is worth saying out loud — and
    // recording, so a strict replay can refuse to pretend.
    if (!isMissingFile(err)) {
      warn(`Failed to load code-behind file ${file}: ${message}. Steps fall back to AI.`);
      return { ...EMPTY_LOAD, error: message };
    }
    return EMPTY_LOAD;
  }

  const index = new Map<string, StepCodeEntry[]>();
  const kept: StepCodeEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.source !== 'string') {
      warn(`Ignoring malformed code-behind entry in ${file} (no string \`source\`).`);
      continue;
    }
    const hasRun = typeof entry.run === 'function';
    const hasCondition = typeof entry.condition === 'function';
    if (hasRun && hasCondition) {
      // A `run` acts and a `condition` answers; one entry cannot mean both
      // (stories/codebehind-loops-and-conditions.md, decision 4). Guessing
      // which half the author meant would run the wrong one on half the lines
      // this could bind to, so the entry is dropped and the line runs under AI.
      warn(
        `Code-behind entry in ${file} for "${entry.source}" has both a \`run\` ` +
          `and a \`condition\` function — an entry is one or the other. Ignoring ` +
          `it, so the line runs under AI.`,
      );
      continue;
    }
    if (entry.ai !== true && !hasRun && !hasCondition) {
      // Half-written entry: no code and no opt-out. Dropping it from the
      // index makes the step miss, so it runs under AI and regenerates —
      // strictly better than executing nothing and calling the step done.
      //
      // Loading does not know which lines are guards, so a `condition` entry
      // is kept whatever it binds to. A mismatch — a `condition` on an
      // ordinary step, a `run` on a guard — is caught where the entry is
      // used, which warns once and runs the line under AI.
      warn(
        `Code-behind entry in ${file} for "${entry.source}" has neither a ` +
          `\`run\` function, a \`condition\` function nor \`ai: true\` — ignoring ` +
          `it, so the step runs under AI.`,
      );
      continue;
    }
    kept.push(entry);
    const key = entryKey(entry);
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  }

  return {
    entries: kept,
    lookup(section, source, occurrence) {
      const key = `${section ? matchText(section) : ''}\u0000${source}`;
      return index.get(key)?.[occurrence];
    },
  };
}

/** Index key: section scope (via the contract's `matchText`) + exact source.
 *  Source comparison is case-SENSITIVE after trimming — an edited step should
 *  miss and regenerate, not fuzzily match. NUL joins the parts because it is
 *  the one character neither a section name nor step text can contain. */
function entryKey(entry: StepCodeEntry): string {
  const scope = entry.section ? matchText(entry.section) : '';
  return `${scope}\u0000${entry.source.trim()}`;
}

function describeEntry(entry: StepCodeEntry): string {
  return entry.section
    ? `{ section: "${entry.section}", source: "${entry.source}" }`
    : `"${entry.source}"`;
}

function isMissingFile(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    (err as NodeJS.ErrnoException)?.code === 'ENOENT' ||
    /ENOENT|no such file or directory|could not resolve/i.test(message)
  );
}
