import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { marked, type Token, type Tokens } from 'marked';
import { parseFrontmatter } from './frontmatter.js';
import type { ParsedSection, ParsedSkill, ParsedTest, TestConfig, TestHooks } from './types.js';
import {
  NO_HOOKS_MARKER,
  matchInput,
  matchText,
  validateSectionName,
} from './section-match.js';
import { expandSkills } from '../skills/expander.js';
import { parseToolCall } from '../tools/tool-call-parser.js';
import { parseSetStep, setStepError, substitutePreservingSet } from './set-step.js';
import { parseFlowControlStep, flowControlInHookError } from './flow-control-step.js';
import type { ToolCall } from '../tools/types.js';
import {
  interpolateDataSourcePath,
  interpolateEnvData,
  type EnvDataContext,
} from './interpolate-env-data.js';
import { loadDataFromPath, type DataObject } from '../env/data-loader.js';
import { scanDataTable, type DataTableScan } from './data-rows.js';
import {
  ANY_HEADING_RE,
  HASHES_ONLY_RE,
  STEP_LINE_RE,
  STEPS_HEADING_RE,
} from './line-grammar.js';
import { logger } from '../utils/logger.js';

/** Valid `## Hooks` scope prefixes — case-insensitive match, stored lowercase. */
const HOOK_SCOPES = new Set(['before', 'beforeeach', 'aftereach', 'after']);

export interface ParseOptions {
  /** Directory to resolve `[skill: name]` references from. Omit to disable. */
  skillsDir?: string;
  /**
   * Env + structured-data context for `${env.X}` / `${data.X.Y}` interpolation.
   * Applied after skill expansion to every step, hook entry, parameter value,
   * and config value. Throws on unknown references so the runner fails fast
   * with a precise file pointer rather than sending a `${...}` literal to the AI.
   * Omit to disable env-data interpolation.
   */
  envData?: EnvDataContext;
}

/**
 * Parse a Markdown test file into a structured ParsedTest object.
 * Handles: frontmatter, H1 title, ## Config, ## Parameters, ## Steps sections.
 * If `skillsDir` is provided, `[skill: name ...]` step references are
 * expanded inline before the test is returned.
 */
export async function parseTestFile(
  filePath: string,
  options: ParseOptions = {},
): Promise<ParsedTest> {
  const absPath = path.resolve(filePath);
  const rawContent = await fs.readFile(absPath, 'utf-8');
  const parsed = parseTestContentRaw(rawContent, absPath);

  // Expand when there is a skills directory OR the file defines sections.
  // The narrower `if (options.skillsDir)` gate would leave a library caller
  // that omits `skillsDir` with unexpanded bare-name calls shipped to the AI
  // as prose. The CLI always passes its `./skills` default, so this only
  // widens behaviour for direct `parseTestFile` consumers.
  const definesSections = Object.keys(parsed.sections).length > 0;
  if (options.skillsDir || definesSections) {
    // Thread the run-wide env context (env vars + envName) into skill
    // expansion so a skill's own `dataSources` (declared in the skill's
    // frontmatter) can resolve `${envName}` / `${env.X}` in their paths and
    // load env-appropriate JSON files at parse time.
    const envCtxForSkills = options.envData;
    const preExpansionStepLines = parsed.stepLines;
    const preExpansionSkipHooks = parsed.skipHooks;
    const stepsExp = await expandSkills(
      parsed.steps,
      options.skillsDir,
      envCtxForSkills,
      absPath,
      preExpansionStepLines,
      { sections: parsed.sections, rawSteps: parsed.rawSteps },
    );
    parsed.steps = stepsExp.steps;
    parsed.sourceSkills = stepsExp.sourceSkills;
    parsed.sourceSections = stepsExp.sourceSections;
    // Re-align stepLines with the now-flattened step list. For inline
    // entries the inputIndex points to themselves; for skill-expanded
    // entries the inputIndex points to the `[skill: ...]` invocation line
    // in the test file — the only file the user has open when looking at a
    // CLI report, so that's the most useful pointer.
    parsed.stepLines = stepsExp.origins.map(
      (o) => preExpansionStepLines[o.inputIndex] ?? 0,
    );

    const beforeExp = await expandSkills(parsed.hooks.before, options.skillsDir, envCtxForSkills, absPath);
    const beforeEachExp = await expandSkills(parsed.hooks.beforeEach, options.skillsDir, envCtxForSkills, absPath);
    const afterEachExp = await expandSkills(parsed.hooks.afterEach, options.skillsDir, envCtxForSkills, absPath);
    const afterExp = await expandSkills(parsed.hooks.after, options.skillsDir, envCtxForSkills, absPath);

    parsed.hooks = {
      before: beforeExp.steps,
      beforeEach: beforeEachExp.steps,
      afterEach: afterEachExp.steps,
      after: afterExp.steps,
    };
    parsed.hookSourceSkills = {
      before: beforeExp.sourceSkills,
      beforeEach: beforeEachExp.sourceSkills,
      afterEach: afterEachExp.sourceSkills,
      after: afterExp.sourceSkills,
    };
    // Skill bodies may themselves contain `[tool: ...]` lines that surface
    // only after expansion, so re-derive the parallel toolCalls arrays
    // against every expanded step list (test body + each hook scope).
    parsed.toolCalls = parsed.steps.map((s) => parseToolCall(s));
    parsed.hookToolCalls = {
      before: parsed.hooks.before.map((s) => parseToolCall(s)),
      beforeEach: parsed.hooks.beforeEach.map((s) => parseToolCall(s)),
      afterEach: parsed.hooks.afterEach.map((s) => parseToolCall(s)),
      after: parsed.hooks.after.map((s) => parseToolCall(s)),
    };
    // Re-align skipHooks through the same origin mapping stepLines uses.
    //
    // This used to pad with `false` / truncate to the expanded length, which
    // silently misaligned the array whenever an invocation expanded to
    // anything other than exactly one step: `[no-hooks] [skill: multi_step]`
    // applied to roughly the first expanded step and left the rest hooked.
    // Origin mapping is what makes "`[no-hooks]` on the invocation covers the
    // whole expanded body" actually true — for sections, where multi-step
    // expansion is the common case, and for skills, where it was already the
    // documented intent.
    parsed.skipHooks = stepsExp.origins.map(
      (o) => preExpansionSkipHooks[o.inputIndex] ?? false,
    );
    parsed.expansion = {
      rawSteps: stepsExp.rawSteps,
      origins: stepsExp.origins,
      frames: stepsExp.frames,
    };
  }

  // A file with neither skills nor sections never enters the expander, but
  // code-behind binding needs the same shape either way: every step is
  // top-level (frame `''`) and its own match side is `matchInput`.
  parsed.expansion ??= {
    rawSteps: parsed.steps.map((_, i) => matchInput(parsed, i)),
    origins: parsed.steps.map((_, i) => ({ inputIndex: i, frameId: '' })),
    frames: {},
  };

  if (options.envData) {
    const extraData = await loadFrontmatterDataSources(
      parsed.frontmatter.dataSources,
      absPath,
      options.envData.env,
    );
    const ctx: EnvDataContext = {
      ...options.envData,
      ...(extraData && { extraData }),
      filePath: absPath,
    };
    applyEnvDataInterpolation(parsed, ctx);
    // Kept for the run: the same context answers `step.getVar('data.url')`
    // from code-behind, and tells a compile what `${data.url}` resolved to.
    parsed.envData = ctx;
  }

  return parsed;
}

/**
 * Resolve the per-test `dataSources` map declared in frontmatter into a
 * loaded `Record<name, DataObject>` ready to drop into the interpolation
 * context. Returns `undefined` when no sources are declared so the caller can
 * skip the property entirely (keeps the regex narrow when not in use).
 *
 * Path resolution rules (mirrored in stories/data-sources-namespaces.md):
 *  - `~/...` → expanded against the user's home directory.
 *  - Absolute (`/foo`, `C:\foo`) → used as-is.
 *  - Relative (`./foo`, `../shared/foo.json`, `tests/foo.json`) → resolved
 *    relative to the test `.md` file's directory, NOT `process.cwd()` —
 *    keeps tests portable when the suite moves.
 */
async function loadFrontmatterDataSources(
  sources: Record<string, string> | undefined,
  testFileAbsPath: string,
  envMap: Record<string, string | undefined>,
): Promise<Record<string, DataObject> | undefined> {
  if (!sources || Object.keys(sources).length === 0) return undefined;

  const testDir = path.dirname(testFileAbsPath);
  const out: Record<string, DataObject> = {};
  for (const [name, declaredPath] of Object.entries(sources)) {
    const absPath = resolveDataSourcePath(declaredPath, testDir);
    // Resolve `$VAR` leaves against the run's env map (composed bundle), not
    // the global process.env — keeps named-source secret resolution correct on
    // the pure (server) path too.
    out[name] = await loadDataFromPath(absPath, envMap);
  }
  return out;
}

/** Expand `~` and resolve relative paths against `testDir`. Exported so the
 *  server can resolve a test's named dataSource paths the same way the CLI
 *  parse path does. */
export function resolveDataSourcePath(declaredPath: string, testDir: string): string {
  const expanded = expandHome(declaredPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(testDir, expanded);
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Walk every textual surface of a parsed test (steps, hooks, parameters,
 * config) and substitute `${env.X}` / `${data.X.Y}` against the supplied
 * context. Mutates in place — callers always pass freshly-parsed tests.
 *
 * **Steps are VALIDATED here, not rewritten**
 * (stories/placeholder-preserving-actions.md §Environment and data-file
 * references). The model has to see the step as written, `${data.url}` intact,
 * beside a block saying what it resolved to — and `parsed.steps` was the only
 * CLI-side text that could be that form. So the pass still resolves every
 * reference, and still throws with the same file-and-line message when one is
 * unknown (fail-fast is the whole reason it ran at parse time), but it keeps
 * the token-intact text and lets `runTest` substitute per step, as the server
 * already does. Parameters, config, hooks and data rows stay parse-time: none
 * of them is shown to the model as authored text.
 *
 * Tool-call argument strings ARE interpolated (so `[tool: foo bar="${env.X}"]`
 * works), but the parsed `ToolCall.args` map is rebuilt by re-parsing the
 * interpolated step text rather than mutating each value individually — which
 * is why the resolved form is computed here even though it is not kept.
 */
function applyEnvDataInterpolation(parsed: ParsedTest, ctx: EnvDataContext): void {
  const resolvedSteps = parsed.steps.map((s) => interpolateEnvData(s, ctx));
  parsed.toolCalls = resolvedSteps.map((s) => parseToolCall(s));

  // Hooks are still baked at parse time — they are never shown to the model as
  // authored text, so there is nothing for them to preserve — EXCEPT a `Set`
  // step, which is read back by `parseSetStep` at run time
  // (`runHookScope`, src/runner/test-runner.ts). Baking a `${…}` into one
  // destroys exactly that: a data value containing a `"` turns
  // `Set {{g}} to "${data.greeting}"` into a line the value grammar refuses,
  // so the assignment silently became an AI prose step and the variable was
  // never written. The hook path passes `test.envData` into `runSetStep`, so
  // leaving the token intact resolves it per step instead — the same order
  // the main flow uses (stories/variable-assignment.md).
  // Not the shared guard: a hook Set is not BROKEN by baking, it is simply
  // better resolved per run (the hook path passes envData to runSetStep), so
  // the token is preserved rather than the substitution refused.
  const hookEnvData = (s: string): string =>
    parseSetStep(s) ? s : interpolateEnvData(s, ctx);
  parsed.hooks = {
    before: parsed.hooks.before.map(hookEnvData),
    beforeEach: parsed.hooks.beforeEach.map(hookEnvData),
    afterEach: parsed.hooks.afterEach.map(hookEnvData),
    after: parsed.hooks.after.map(hookEnvData),
  };
  parsed.hookToolCalls = {
    before: parsed.hooks.before.map((s) => parseToolCall(s)),
    beforeEach: parsed.hooks.beforeEach.map((s) => parseToolCall(s)),
    afterEach: parsed.hooks.afterEach.map((s) => parseToolCall(s)),
    after: parsed.hooks.after.map((s) => parseToolCall(s)),
  };

  for (const [k, v] of Object.entries(parsed.parameters)) {
    parsed.parameters[k] = interpolateEnvData(v, ctx);
  }

  // Row cells are parameter values that happen to arrive in a table, so they
  // resolve `${env.X}` / `${data.X}` in the same pass and against the same
  // context — otherwise a reference would work in `## Parameters` and reach
  // the model as literal text one line below it.
  if (parsed.dataRows) {
    for (const row of parsed.dataRows) {
      for (const [k, v] of Object.entries(row)) {
        row[k] = interpolateEnvData(v, ctx);
      }
    }
  }

  // TestConfig is a flat key-value map; only the string fields need substitution.
  const cfg = parsed.config as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'string') cfg[k] = interpolateEnvData(v, ctx);
  }
}

/**
 * Parse a Markdown skill file. Skills share the same parser as tests but
 * additionally read the `## Outputs` section and use the H1 as the skill name.
 *
 * When `envCtx` is supplied, the skill's own `dataSources` (frontmatter) are
 * resolved here — paths are interpolated via `${env.X}` / `${envName}`,
 * loaded, and then the skill body / parameters / outputs are interpolated
 * against the env + skill-private namespaces. The resulting `ParsedSkill`
 * has skill-private placeholders already resolved, so by the time the
 * expander inlines it the caller's interpolation pass sees only literals
 * and `{{paramName}}` placeholders.
 */
export async function parseSkillFile(
  filePath: string,
  envCtx?: EnvDataContext,
): Promise<ParsedSkill> {
  const absPath = path.resolve(filePath);
  const rawContent = await fs.readFile(absPath, 'utf-8');
  const parsed = parseSkillContent(rawContent, absPath);
  if (envCtx) {
    await applySkillEnvDataInterpolation(parsed, absPath, envCtx);
  } else if (parsed.dataSources && Object.keys(parsed.dataSources).length > 0) {
    // Skill declares dataSources but no env context was provided — the
    // skill-private `${<source>.X}` placeholders won't be resolved here, and
    // they'll fall through to caller-level interpolation which doesn't know
    // about them. Warn loudly so the footgun surfaces at parse time rather
    // than as an unresolved literal in a step at runtime.
    logger.warn(
      `Skill "${parsed.name}" at ${absPath} declares dataSources but was parsed ` +
      `without an env context — its \${<source>.X} placeholders will pass through ` +
      `unresolved. Pass envCtx into parseSkillFile / expandSkills to fix.`,
    );
  }
  return parsed;
}

/**
 * Resolve skill-private `dataSources` paths, load the JSON files, then
 * interpolate the skill body / parameters / outputs against a context that
 * includes the env, the active envName, and the skill's own namespaces —
 * but NOT `data` (the caller's env-default file). Skill-private namespaces
 * are private to the skill: a colliding name in the calling test resolves
 * against the test's file in test scope, not the skill's.
 */
async function applySkillEnvDataInterpolation(
  parsed: ParsedSkill,
  skillAbsPath: string,
  envCtx: EnvDataContext,
): Promise<void> {
  const skillDir = path.dirname(skillAbsPath);
  const extraData: Record<string, DataObject> = {};
  if (parsed.dataSources) {
    for (const [name, declaredPath] of Object.entries(parsed.dataSources)) {
      const resolvedPathStr = interpolateDataSourcePath(declaredPath, {
        env: envCtx.env,
        envName: envCtx.envName ?? null,
        filePath: skillAbsPath,
      });
      const absDataPath = resolveDataSourcePath(resolvedPathStr, skillDir);
      extraData[name] = await loadDataFromPath(absDataPath, envCtx.env);
    }
  }

  const skillCtx: EnvDataContext = {
    env: envCtx.env,
    // Deliberately omit `data` — skills don't reach into the caller's
    // env-default data file. `${data.X}` in a skill body passes through
    // and is resolved later by test-level interpolation if the test owns it.
    ...(Object.keys(extraData).length > 0 && { extraData }),
    ...(envCtx.envName !== undefined && { envName: envCtx.envName }),
    filePath: skillAbsPath,
  };

  // A skill's own `${…}` bake, guarded like every other site that writes into
  // step text: a value holding a `"` would otherwise turn a body `Set` into a
  // line the value grammar refuses, and it would run as AI prose having
  // assigned nothing. This was the fifth consecutive round to find that
  // defect one substitution site further along — see `substitutePreservingSet`.
  const skillEnvData = (s: string): string =>
    substitutePreservingSet(
      s,
      (text) => interpolateEnvData(text, skillCtx),
      (target) =>
        `A value substituted into skill "${parsed.name}" makes ` +
        `"Set {{${target}}} to …" unparseable — almost always a \`${'${env.X}'}\` ` +
        `or \`${'${<source>.x}'}\` whose value contains a double quote, which ` +
        `the assigned value may not. Left to run, the assignment would ` +
        `silently not happen.`,
    );

  parsed.steps = parsed.steps.map(skillEnvData);
  for (const [k, v] of Object.entries(parsed.parameters)) {
    parsed.parameters[k] = interpolateEnvData(v, skillCtx);
  }
  parsed.outputs = parsed.outputs.map((o) => interpolateEnvData(o, skillCtx));

  // Section bodies get the same pass as the main body, or a `${env.X}` used
  // only inside a section would survive as a literal and either fail later
  // with a wrong-file error or ship raw to the AI.
  //
  // `rawSteps` is deliberately NOT interpolated: it is the match side, and
  // section resolution must stay decidable from the file as authored (the
  // editor's links and dead-section diagnostic have nothing else to work
  // with). `applySkillScope` leaves it alone for the same reason. See the
  // contract §3.1.
  for (const section of Object.values(parsed.sections)) {
    section.steps = section.steps.map(skillEnvData);
  }
}

/** Parse test content from a string (steps returned verbatim — no skill expansion) */
export function parseTestContent(rawContent: string, filePath = '<inline>'): ParsedTest {
  return parseTestContentRaw(rawContent, filePath);
}

function parseTestContentRaw(rawContent: string, filePath: string): ParsedTest {
  const { sections, frontmatter, title } = parseSections(rawContent, filePath);

  return {
    filePath,
    title,
    frontmatter,
    config: sections.config,
    parameters: sections.parameters,
    steps: sections.steps,
    stepLines: sections.stepLines,
    skipHooks: sections.skipHooks,
    toolCalls: sections.toolCalls,
    // Pre-skill-expansion: every step is inline (no source skill yet). Will be
    // re-populated by parseTestFile after expandSkills() runs.
    sourceSkills: sections.steps.map(() => null),
    sourceSections: sections.steps.map(() => null),
    sections: sections.sectionDefs,
    rawSteps: sections.rawSteps,
    ...(sections.dataRows && { dataRows: sections.dataRows }),
    hooks: sections.hooks,
    hookToolCalls: {
      before: sections.hooks.before.map(() => null),
      beforeEach: sections.hooks.beforeEach.map(() => null),
      afterEach: sections.hooks.afterEach.map(() => null),
      after: sections.hooks.after.map(() => null),
    },
    hookSourceSkills: {
      before: sections.hooks.before.map(() => null),
      beforeEach: sections.hooks.beforeEach.map(() => null),
      afterEach: sections.hooks.afterEach.map(() => null),
      after: sections.hooks.after.map(() => null),
    },
  };
}

function parseSkillContent(rawContent: string, filePath: string): ParsedSkill {
  const { sections, frontmatter, title } = parseSections(rawContent, filePath);

  // A skill's parameters are not runtime variables: `applySkillScope`
  // interpolates the caller's arguments into the body TEXT, so a `Set
  // {{username}} to "…"` in a skill body would reach the runner as
  // `Set demo@securebank.com to "…"`. Refused by name, here, where the name
  // still exists (stories/variable-assignment.md §Locked). A test's
  // `## Parameters` are the opposite case — they live in
  // `resolvedParameters` and are assignable like anything else — which is
  // why this check is skill-only and not in `parseSections`.
  const declared = new Set(Object.keys(sections.parameters));
  if (declared.size > 0) {
    const bodies = [
      sections.steps,
      ...Object.values(sections.sectionDefs).map((s) => s.steps),
    ];
    for (const body of bodies) {
      for (const step of body) {
        const setStep = parseSetStep(step);
        if (setStep && declared.has(setStep.name)) {
          throw new Error(
            `Cannot assign to {{${setStep.name}}} in ${filePath}: it is a ` +
              `parameter of this skill, and a caller's arguments are written ` +
              `into the step text rather than kept as variables. Assign to a ` +
              `declared \`## Outputs\` name, or to an internal one.`,
          );
        }
      }
    }
  }

  return {
    filePath,
    name: title || path.basename(filePath, '.md'),
    parameters: sections.parameters,
    outputs: sections.outputs,
    steps: sections.steps,
    stepLines: sections.stepLines,
    sections: sections.sectionDefs,
    rawSteps: sections.rawSteps,
    ...(frontmatter.dataSources && { dataSources: frontmatter.dataSources }),
  };
}

interface ParsedSections {
  config: TestConfig;
  parameters: Record<string, string>;
  outputs: string[];
  steps: string[];
  /** Parallel to `steps` — true when the authored line began with `[no-hooks]`. */
  skipHooks: boolean[];
  /** Parallel to `steps` — non-null when the line is a `[tool: ...]` invocation. */
  toolCalls: (ToolCall | null)[];
  /**
   * Parallel to `steps` — 1-based source line in the original raw content
   * (including frontmatter). Populated by `extractStepLinesFromRaw`. Used by
   * the step-into protocol so frame events can carry origin file+line.
   */
  stepLines: number[];
  /** Parallel to `steps` — raw line text (number prefix stripped, trimmed,
   *  `[no-hooks]` markers preserved). The match side for section calls. */
  rawSteps: string[];
  /** Inline sections defined in this file, keyed by `matchText(name)`.
   *  Named `sectionDefs` rather than `sections` because the enclosing return
   *  type already uses `sections` for the whole reserved-H2 bundle. */
  sectionDefs: Record<string, ParsedSection>;
  hooks: TestHooks;
  /** Rows from a table under `## Steps` — absent, never empty, when the file
   *  has none. See `ParsedTest.dataRows`. */
  dataRows?: Array<Record<string, string>>;
}

function parseSections(rawContent: string, filePath: string): {
  sections: ParsedSections;
  frontmatter: ReturnType<typeof parseFrontmatter>['frontmatter'];
  title: string;
} {
  const { frontmatter, body } = parseFrontmatter(rawContent);

  // Pre-compute the structure of the `## Steps` span from the raw text: which
  // lines are numbered items, and which `### Name` section each belongs to.
  // The marked AST throws away line positions, so this second pass supplies
  // them — and now section membership too. Throws on an invalid section name.
  const scan = scanStepSpans(rawContent, filePath);

  const tokens = marked.lexer(body);

  let title = '';
  const config: TestConfig = {};
  const parameters: Record<string, string> = {};
  const outputs: string[] = [];
  const steps: string[] = [];
  const skipHooks: boolean[] = [];
  const toolCalls: (ToolCall | null)[] = [];
  const hooks: TestHooks = {
    before: [],
    beforeEach: [],
    afterEach: [],
    after: [],
  };

  let currentSection: 'config' | 'parameters' | 'outputs' | 'steps' | 'hooks' | null = null;
  /**
   * Inside a depth->=4 heading's ignored region within `## Steps`
   * (contract §5 rule 4a). The raw line scan drops the same items, and the
   * two are zipped by index downstream — so if only one of them dropped
   * them the file would fail its own step/line mismatch check.
   */
  let stepsIgnored = false;

  for (const token of tokens) {
    if (token.type === 'heading') {
      const headingToken = token as Tokens.Heading;
      const text = headingToken.text.trim();
      stepsIgnored = headingToken.depth >= 4 && text !== '';

      if (headingToken.depth === 1) {
        title = text;
        currentSection = null;
      } else if (headingToken.depth === 2) {
        const lower = text.toLowerCase();
        if (lower === 'config') {
          currentSection = 'config';
        } else if (lower === 'parameters') {
          currentSection = 'parameters';
        } else if (lower === 'outputs') {
          currentSection = 'outputs';
        } else if (lower === 'steps') {
          currentSection = 'steps';
        } else if (lower === 'hooks') {
          currentSection = 'hooks';
        } else {
          currentSection = null;
        }
      }
      continue;
    }

    if (currentSection === 'config' && token.type === 'list') {
      parseKeyValueList(token as Tokens.List, config as Record<string, string>);
    }

    if (currentSection === 'parameters' && token.type === 'list') {
      parseKeyValueList(token as Tokens.List, parameters);
    }

    if (currentSection === 'outputs' && token.type === 'list') {
      extractOutputs(token as Tokens.List, outputs);
    }

    if (currentSection === 'steps' && token.type === 'list' && !stepsIgnored) {
      extractSteps(token as Tokens.List, steps, skipHooks, toolCalls);
    }

    if (currentSection === 'hooks' && token.type === 'list') {
      extractHooks(token as Tokens.List, hooks, filePath);
    }
  }

  if (!title) {
    if (frontmatter.type !== 'skill') {
      logger.warn(`Test file ${filePath} has no H1 title heading`);
    }
    title = path.basename(filePath, '.md');
  }

  if (steps.length === 0) {
    logger.warn(`File ${filePath} has no steps defined in ## Steps section`);
  }

  // Zip the marked pass (text) against the raw scan (lines + section
  // membership). Both walk the document in the same order, so entry `i`
  // describes step `i`.
  //
  // For a file that defines sections the correspondence must hold exactly, so
  // a mismatch throws: once the raw text is the match side, a one-off shift
  // silently flips which steps are section calls. Perfect replication is
  // impossible in general — the raw scan sees text where marked sees rendered
  // tokens, so a numbered line inside a fenced code block diverges — hence
  // the hard failure rather than a guess.
  //
  // Files with no sections keep the historic lenient behaviour (pair by index,
  // fall back to line 0), so every file written before this feature parses
  // exactly as it did.
  // The match side per step: the scanned raw line by default, but the full
  // step text for a multi-line item (see `classifyReading`).
  const matchSides: string[] = steps.map((s, i) => scan.entries[i]?.raw ?? s);

  if (scan.heads.length > 0) {
    const causes =
      `Usual causes: a numbered line the markdown parser doesn't treat as a ` +
      `step (inside a fenced code block or an HTML comment), or one the line ` +
      `scanner doesn't (indented by 1-3 spaces, or using \`1)\` instead of ` +
      `\`1.\`).`;

    if (scan.entries.length !== steps.length) {
      throw new Error(
        `Step/line mismatch in ${filePath}: the markdown parser found ` +
          `${steps.length} step(s) in \`## Steps\` but the line scanner found ` +
          `${scan.entries.length}. Because this file defines sections, the two ` +
          `must agree exactly — a shift would change which steps count as ` +
          `section calls. ${causes}`,
      );
    }

    // Equal counts are NOT enough. Two divergences in opposite directions
    // cancel out, and the resulting pairing is silently wrong in the worst
    // possible way: `rawSteps` is the match side, so a step can inherit an
    // unrelated line's text, resolve to a section the author never called,
    // and drop the real instruction without a word. Verify per index.
    for (let i = 0; i < steps.length; i++) {
      const entry = scan.entries[i]!;
      const reading = classifyReading(steps[i]!, entry.raw);
      if (reading === 'drift') {
        throw new Error(
          `Step/line mismatch in ${filePath} at step ${i + 1}: the markdown ` +
            `parser read "${steps[i]}" where the line scanner read ` +
            `"${entry.raw}" (line ${entry.line}). The two passes have drifted ` +
            `out of step, so section calls would resolve against the wrong ` +
            `text. ${causes}`,
        );
      }
      if (reading === 'continued') {
        // The scanned line is only this item's first physical line. Matching
        // on it would compare a truncation — so match on the whole step.
        matchSides[i] = steps[i]!;
      }
    }
  }

  const mainSteps: string[] = [];
  const mainSkipHooks: boolean[] = [];
  const mainToolCalls: (ToolCall | null)[] = [];
  const mainStepLines: number[] = [];
  const mainRawSteps: string[] = [];

  const sectionAcc: ParsedSection[] = scan.heads.map((h, index) => {
    const table = scan.sectionTables?.get(index);
    return {
      name: h.name,
      headingLine: h.headingLine,
      steps: [],
      rawSteps: [],
      stepLines: [],
      ...(table && { rows: table.rows }),
    };
  });

  for (let i = 0; i < steps.length; i++) {
    const entry = scan.entries[i];
    const target = entry?.sectionIndex != null ? sectionAcc[entry.sectionIndex] : null;

    // `Set {{name}} to "…"` (stories/variable-assignment.md). Validated here
    // because this is the one loop every authored step line of every file —
    // test or skill, main flow or section body — passes through.
    const where = ` in ${filePath}${entry ? ` at line ${entry.line}` : ''}`;
    const setError = setStepError(steps[i]!, where);
    if (setError) throw new Error(setError);

    // A section that loops over a table has its row values interpolated into
    // the body text at EXPANSION time (`interpolateQuiet`, expander.ts), so a
    // Set target sharing a column name would arrive at the runner already
    // replaced by a value — `Set 42 to "…"`, a parse error naming a number
    // nobody typed. Refused here, where the name is still a name.
    const setStep = parseSetStep(steps[i]!);
    const columns = target?.rows?.[0];
    if (setStep && columns && Object.hasOwn(columns, setStep.name)) {
      throw new Error(
        `Cannot assign to {{${setStep.name}}}${where}: it is a column of the ` +
          `table under "### ${target.name}", and a looped section's row values ` +
          `are written into its step text rather than kept as variables. ` +
          `Assign to a different name.`,
      );
    }

    if (target) {
      // Body steps carry no skipHooks/toolCalls parallel: `[no-hooks]` on a
      // body line is stripped and ignored (the invocation's marker covers the
      // whole body, via origin mapping), and toolCalls are re-derived from
      // the flat list after expansion.
      target.steps.push(steps[i]!);
      target.rawSteps.push(matchSides[i]!);
      target.stepLines.push(entry!.line);
    } else {
      mainSteps.push(steps[i]!);
      mainSkipHooks.push(skipHooks[i] ?? false);
      mainToolCalls.push(toolCalls[i] ?? null);
      mainStepLines.push(entry?.line ?? 0);
      mainRawSteps.push(matchSides[i]!);
    }
  }

  // Null-prototype: a section may legally be named `__proto__` (§2.5 bans
  // only reserved keywords, a leading `[`, `{{` and the empty string), and on
  // a normal object literal that assignment hits the prototype setter instead
  // of creating an own key — the definition would silently vanish and the
  // call would run as a literal AI instruction.
  const sectionMap: Record<string, ParsedSection> = Object.create(null) as Record<string, ParsedSection>;
  for (const section of sectionAcc) {
    sectionMap[matchText(section.name)] = section;
  }

  // A table under `## Steps` loops the run. Two files can't have one: a skill
  // is invoked with arguments rather than looped, and `dataFile:` already
  // names an external set of rows — two sources of rows for one flow is an
  // ambiguity with no sensible resolution, so it is refused rather than
  // silently ranked.
  if (scan.dataTable) {
    if (frontmatter.type === 'skill') {
      throw new Error(
        `${filePath}:${scan.dataTable.headerLine} — a skill's own \`## Steps\` ` +
          `cannot carry a data table. A skill is invoked with arguments, not ` +
          `looped; put the table under the \`## Steps\` of the test that calls ` +
          `it, or under a \`### Section\`.`,
      );
    }
    if (frontmatter.dataFile) {
      throw new Error(
        `${filePath}:${scan.dataTable.headerLine} — the file has both a data ` +
          `table under \`## Steps\` and \`dataFile: ${frontmatter.dataFile}\` ` +
          `in its frontmatter. A run loops over one set of rows; keep the ` +
          `table or the file, not both.`,
      );
    }
  }

  return {
    sections: {
      config,
      parameters,
      outputs,
      steps: mainSteps,
      skipHooks: mainSkipHooks,
      toolCalls: mainToolCalls,
      stepLines: mainStepLines,
      rawSteps: mainRawSteps,
      sectionDefs: sectionMap,
      hooks,
      ...(scan.dataTable && { dataRows: scan.dataTable.rows }),
    },
    frontmatter,
    title,
  };
}

/**
 * True when the marked pass's text for a step is a legitimate reading of the
 * raw line the scan found at the same index.
 *
 * A raw line has exactly two possible readings, and they are *derived* rather
 * than approximated:
 *
 *  - **tight list** — `extractPlainText` short-circuits on the raw inline
 *    source, so the text is the line itself (marker stripped, trimmed);
 *  - **loose list** — marked emits a `paragraph`, `extractPlainText` recurses
 *    through it and unwraps `strong` / `em` / `codespan`.
 *
 * Computing the loose reading with `extractPlainText` itself is the point: an
 * earlier version approximated it by deleting `*`, `_` and backticks and
 * collapsing whitespace, which made the tripwire *more* permissive than
 * `matchText`. Drift landing in that gap — `Login as  admin` against a
 * `Login as admin` section, or a bold step against a plain one — passed the
 * check and still resolved to a section the author never called, which is the
 * whole failure being guarded against. Anything `matchText` would treat as
 * different must be treated as different here too, so the comparison is
 * exact and the coupling to `extractPlainText` is structural.
 */
function classifyReading(
  stepText: string,
  rawLine: string,
): 'exact' | 'continued' | 'drift' {
  const tight = rawLine.replace(NO_HOOKS_MARKER, '').trim();
  if (stepText === tight) return 'exact';
  const loose = extractPlainText(marked.lexer(tight)).trim();
  if (stepText === loose) return 'exact';

  // A list item may span several physical lines — a wrapped instruction, a
  // hard line break, a nested bullet list. marked folds the whole item into
  // one step; the raw scan only ever sees the first line. That is legitimate
  // markdown and must not be refused.
  //
  // But it means `entry.raw` is now a TRUNCATION of the step, and truncations
  // are dangerous precisely here: a step reading
  //
  //     1. Login
  //        and then confirm the dashboard shows the correct tenant
  //
  // truncates to "Login", which would resolve against a `### Login` section
  // the author never called and drop the real instruction. So the caller
  // switches the match side to the full step text for these — which can never
  // equal a bare section name. That is the contract §2.1 fallback
  // (`rawSteps?.[i] ?? steps[i]`), not a new rule.
  if (stepText.startsWith(tight)) return 'continued';
  // `loose` can be empty — a codespan of only whitespace (`` ` ` ``) lexes to
  // empty text, and `startsWith('')` is true of everything, which would
  // silently disable the tripwire for that step. `tight` cannot be empty
  // (`scanStepSpans` culls empty-after-strip items), so only this branch
  // needs the guard. Such a line IS a genuine divergence — marked culls it,
  // the scan keeps it — so falling through to `drift` is the right answer.
  if (loose !== '' && stepText.startsWith(loose)) return 'continued';

  return 'drift';
}

/** One numbered item found by the raw scan inside the `## Steps` span. */
export interface StepSpanEntry {
  /** 1-based line in the *raw* content, frontmatter included — so it matches
   *  what the user sees in their editor. */
  line: number;
  /** Line text with the `N. ` prefix removed and trimmed. `[no-hooks]`
   *  markers are preserved: this is the match side, and `matchText` strips
   *  them itself. */
  raw: string;
  /** Index into `heads`, or null when the item is a main-flow step. */
  sectionIndex: number | null;
}

/** Result of the raw scan: the section structure of a file's `## Steps` span. */
export interface StepSpanScan {
  /** Numbered items in document order, main flow and section bodies alike,
   *  with the same cull rules `extractSteps` applies. */
  entries: StepSpanEntry[];
  /** `### Name` headings in document order. */
  heads: { name: string; headingLine: number }[];
  /**
   * The data table at the head of the main flow, when the file has one — the
   * rows that make the whole run loop (stories/data-driven-rows.md, part A).
   * Absent when there is no table, and recognised only under a depth-2
   * `## Steps`, the same gate sections are behind.
   */
  dataTable?: DataTableScan;
  /** Tables under a `### Section`, keyed by that section's index in `heads` —
   *  the rows that make each call of it loop (part B). */
  sectionTables?: Map<number, DataTableScan>;
}

/**
 * Scan the raw markdown for the structure of its `## Steps` span: which lines
 * are numbered items, and which section (if any) each belongs to.
 *
 * The marked AST throws away line positions, so this is a second pass over
 * the unparsed content. Its Nth entry corresponds 1:1 with the Nth step
 * `extractSteps` pushes, which is what lets `parseSections` zip text (from
 * marked) to lines and section membership (from here). That correspondence is
 * why this scan replicates `extractSteps`' cull rules rather than collecting
 * every matching line: once the raw text is the *match* side, a one-off shift
 * flips call/non-call decisions rather than merely mislabelling a line.
 *
 * Also mirrors the runner-core step-line classifier so server-side parsing
 * agrees with the client's editor-side line model. Kept here (rather than
 * importing runner-core) because the server isn't a runner-core consumer
 * today — see issues/035.
 *
 * Exported for direct unit testing: the two-pass alignment is the single most
 * error-prone part of the sections feature, and testing it only through
 * `parseTestContent` hides which pass disagreed.
 *
 * Throws on an invalid section name (reserved / `[`-prefixed / `{{`-containing
 * / empty / duplicate).
 */
export function scanStepSpans(rawContent: string, filePath: string): StepSpanScan {
  // The four line regexes live in ./line-grammar.js because the data-table
  // scan below reads the same span and has to agree with this pass about what
  // a step line and a heading are (HASHES_ONLY_RE catches a line that is
  // nothing but hashes: ANY_HEADING_RE demands a non-space after them, so
  // without it such a line reads as prose to every parser — the CLI would
  // throw its empty-name error while TestBench ran the "body" items as
  // main-flow steps).
  const lines = rawContent.split(/\r?\n/);
  const entries: StepSpanEntry[] = [];
  const heads: { name: string; headingLine: number }[] = [];

  // Skip leading frontmatter (--- ... ---).
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
  if (i < lines.length && (lines[i] ?? '').trim() === '---') {
    for (let j = i + 1; j < lines.length; j++) {
      if ((lines[j] ?? '').trim() === '---') { i = j + 1; break; }
    }
  } else {
    i = 0;
  }

  // Find the Steps heading. Bail if not present.
  let headingIndex = -1;
  let headingDepth = 0;
  for (; i < lines.length; i++) {
    const m = STEPS_HEADING_RE.exec(lines[i] ?? '');
    if (m) { headingIndex = i; headingDepth = m[1]!.length; break; }
  }
  if (headingIndex < 0) return { entries, heads };

  // Sections are recognised only under a depth-2 `## Steps`. STEPS_HEADING_RE
  // accepts `#{2,}`, and the span closes at `depth <= headingDepth` — so under
  // a `### Steps` heading a `###` line *closes the span* rather than landing
  // in it, and no section can be defined. That matches the CLI token walk
  // below, which dispatches on heading depth 1 and 2 only.
  const sectionsRecognised = headingDepth === 2;

  // The rows that loop the run, read before the steps they feed. `to` is the
  // end of the file rather than the end of the span because the scan stops at
  // the first heading of any depth anyway — which is exactly the head region,
  // and is also what makes "a table after a step" detectable: the scan keeps
  // looking past the first numbered item so it can refuse one, rather than
  // leaving marked to fold it into that step and run the fold.
  const dataTable = sectionsRecognised
    ? scanDataTable({
        lines,
        from: headingIndex + 1,
        to: lines.length,
        filePath,
        flow: (lines[headingIndex] ?? '## Steps').trim(),
      })
    : null;

  /** Index (0-based) where the whole steps span ends — the line of the next
   *  heading at or above its depth, or the end of the file. Needed to bound
   *  the LAST section's table scan. */
  let spanEndIndex = lines.length;

  const seenNames = new Map<string, number>();
  let currentSection: number | null = null;
  /**
   * Inside a depth->=4 heading's ignored region (contract §5 rule 4a).
   *
   * Such a heading used to be called "inert prose", which described the
   * heading and not its consequences: the numbered items beneath it were
   * absorbed — into the main flow when no section was open, into the open
   * section's body when one was — and they RAN. Nothing under a `####` runs
   * now. The region ends at the next `###`-with-text (a real section, which
   * a hashes-only line also is) or the end of the span; a further depth->=4
   * heading renews it.
   */
  let ignoredHeading: { name: string; line: number } | null = null;
  /** Dropped items per ignored heading, for the note below. */
  const dropped: { name: string; line: number; count: number }[] = [];

  for (let j = headingIndex + 1; j < lines.length; j++) {
    const raw = lines[j] ?? '';
    const line = j + 1;

    const heading = ANY_HEADING_RE.exec(raw);
    if (heading && heading[1]!.length <= headingDepth) {
      spanEndIndex = j;
      break;
    }

    if (sectionsRecognised && HASHES_ONLY_RE.test(raw)) {
      // Hashes with no text, at any depth >= 3. Always an error, but raise it
      // through the same validator so the message matches every other refusal.
      validateSectionName('', filePath, line);
    }

    if (heading) {
      if (sectionsRecognised && heading[1]!.length >= 4) {
        // Opens the ignored region, or renews one already open.
        ignoredHeading = { name: raw.replace(/^#+s*/, '').trim(), line };
        continue;
      }
      if (sectionsRecognised && heading[1]!.length === 3) {
        // A real section: an open ignored region ends here.
        ignoredHeading = null;
        const name = raw.replace(/^#{3}\s*/, '').trim();
        validateSectionName(name, filePath, line);
        const key = matchText(name);
        const prior = seenNames.get(key);
        if (prior !== undefined) {
          throw new Error(
            `Duplicate section "${name}" at ${filePath}:${line} — already ` +
              `defined at line ${prior}. Section names are matched ` +
              `case-insensitively, so the two would be indistinguishable at ` +
              `the call site.`,
          );
        }
        seenNames.set(key, line);
        heads.push({ name, headingLine: line });
        currentSection = heads.length - 1;
      }
      // Depth >= 4 headings inside the span are inert prose, per the grammar.
      continue;
    }

    if (!STEP_LINE_RE.test(raw)) continue;

    // Replicate `extractSteps`' culls so the two passes stay index-aligned by
    // construction: an item with no text, and a marker-only item, are dropped
    // from both. (STEP_LINE_RE already requires a non-space after the number,
    // so the first check only fires defensively.)
    const text = raw.replace(/^\d+\.\s+/, '').trim();
    if (!text) continue;
    if (text.replace(NO_HOOKS_MARKER, '').trim() === '') continue;

    if (ignoredHeading) {
      // Counted, not pushed. The marked walk drops the same items, so the
      // two passes stay index-aligned by construction — which is what the
      // step/line mismatch check downstream relies on.
      const last = dropped[dropped.length - 1];
      if (last && last.line === ignoredHeading.line) last.count++;
      else dropped.push({ ...ignoredHeading, count: 1 });
      continue;
    }

    entries.push({ line, raw: text, sectionIndex: currentSection });
  }

  // Said out loud, once per heading. Silently dropping numbered items an
  // author wrote is how the old grammar's absorption went unnoticed; refusing
  // the file would be worse, since the items are prose as far as the grammar
  // is concerned.
  for (const d of dropped) {
    logger.warn(
      `${d.count} step(s) under "${d.name}" (${filePath}:${d.line}) are not run — a ` +
        `heading of depth 4 or more does not define a section. Use "### ${d.name}" ` +
        `and call it by name from the main flow.`,
    );
  }

  // A table under a `### Section` loops that section's body, once per row,
  // in the same session (stories/data-driven-rows.md, part B). Scanned after
  // the main pass because a section's span is only known once the next
  // heading has been seen: it runs from its own heading to the next `###` (or
  // to wherever the whole steps span ended).
  const sectionTables = new Map<number, DataTableScan>();
  if (sectionsRecognised) {
    for (const [index, head] of heads.entries()) {
      const from = head.headingLine; // 1-based heading line == 0-based next line
      const next = heads[index + 1];
      const to = next ? next.headingLine - 1 : spanEndIndex;
      const scan = scanDataTable({
        lines,
        from,
        to,
        filePath,
        flow: `### ${head.name}`,
      });
      if (scan) sectionTables.set(index, scan);
    }
  }

  return {
    entries,
    heads,
    ...(dataTable && { dataTable }),
    ...(sectionTables.size > 0 && { sectionTables }),
  };
}

/** Parse a list of "- key: value" items into a key-value map */
function parseKeyValueList(listToken: Tokens.List, target: Record<string, string>): void {
  for (const item of listToken.items) {
    // Get plain text from the list item
    const text = extractPlainText(item.tokens);
    const colonIndex = text.indexOf(':');
    if (colonIndex === -1) continue;

    const key = text.substring(0, colonIndex).trim();
    const value = text.substring(colonIndex + 1).trim();

    if (key) {
      target[key] = value;
    }
  }
}

/** Extract ordered steps from a list token, stripping `[no-hooks]` markers,
 *  recording their positions in the parallel `skipHooks` array, and parsing
 *  any `[tool: ...]` lines into the parallel `toolCalls` array. Tool-call
 *  syntax errors throw at parse time with a caret diagnostic. */
function extractSteps(
  listToken: Tokens.List,
  steps: string[],
  skipHooks: boolean[],
  toolCalls: (ToolCall | null)[],
): void {
  for (const item of listToken.items) {
    const text = extractPlainText(item.tokens).trim();
    if (!text) continue;
    const noHooks = NO_HOOKS_MARKER.test(text);
    const cleaned = noHooks ? text.replace(NO_HOOKS_MARKER, '').trim() : text;
    if (!cleaned) continue;
    const toolCall = parseToolCall(cleaned);
    steps.push(cleaned);
    skipHooks.push(noHooks);
    toolCalls.push(toolCall);
  }
}

/** Parse `## Hooks` entries of the form `- scope: instruction` into the hooks struct. */
function extractHooks(listToken: Tokens.List, hooks: TestHooks, filePath: string): void {
  for (const item of listToken.items) {
    const text = extractPlainText(item.tokens).trim();
    if (!text) continue;
    const colonIndex = text.indexOf(':');
    if (colonIndex === -1) {
      logger.warn(`Hook entry in ${filePath} is missing a scope prefix: "${text}"`);
      continue;
    }
    const scopeRaw = text.substring(0, colonIndex).trim();
    const scope = scopeRaw.toLowerCase();
    const instruction = text.substring(colonIndex + 1).trim();
    if (!HOOK_SCOPES.has(scope)) {
      logger.warn(
        `Unknown hook scope "${scopeRaw}" in ${filePath} — expected one of: before, beforeEach, afterEach, after`,
      );
      continue;
    }
    if (!instruction || instruction.toLowerCase() === 'none') {
      // Explicit "none" allows a test to declare an empty scope override
      continue;
    }
    // A hook may not return (stories/step-flow-control.md, decision 8). Thrown
    // rather than warned: an unknown scope degrades to "this hook does not
    // run", which is visible, whereas a silently-ignored return would leave
    // the author believing a flow ends where it never does.
    if (parseFlowControlStep(instruction)) {
      throw new Error(flowControlInHookError(instruction, ` in ${filePath}`));
    }
    if (scope === 'before') hooks.before.push(instruction);
    else if (scope === 'beforeeach') hooks.beforeEach.push(instruction);
    else if (scope === 'aftereach') hooks.afterEach.push(instruction);
    else if (scope === 'after') hooks.after.push(instruction);
  }
}

/** Extract output names from a `## Outputs` list. Items may be `- name` or `- name: description`. */
function extractOutputs(listToken: Tokens.List, outputs: string[]): void {
  for (const item of listToken.items) {
    const text = extractPlainText(item.tokens).trim();
    if (!text) continue;
    const colonIndex = text.indexOf(':');
    const name = colonIndex === -1 ? text : text.substring(0, colonIndex).trim();
    if (name) outputs.push(name);
  }
}

/** Extract plain text from a token's children, stripping markdown formatting */
function extractPlainText(tokens: Token[]): string {
  let result = '';

  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'codespan') {
      result += (token as Tokens.Text | Tokens.Codespan).text;
    } else if (token.type === 'paragraph') {
      result += extractPlainText((token as Tokens.Paragraph).tokens ?? []);
    } else if (token.type === 'strong' || token.type === 'em') {
      result += extractPlainText((token as Tokens.Strong | Tokens.Em).tokens ?? []);
    } else if ('raw' in token) {
      // Fallback for unknown token types
      result += (token as { raw: string }).raw;
    }
  }

  return result;
}

/** Discover all .md test files in a directory matching a glob pattern */
export async function discoverTestFiles(
  dir: string,
  pattern: string,
): Promise<string[]> {
  const { glob } = await import('glob');
  const absDir = path.resolve(dir);
  const files = await glob(pattern, {
    cwd: absDir,
    absolute: true,
    ignore: ['**/node_modules/**'],
  });
  return files.sort();
}
