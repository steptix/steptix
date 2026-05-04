import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { marked, type Token, type Tokens } from 'marked';
import { parseFrontmatter } from './frontmatter.js';
import type { ParsedSkill, ParsedTest, TestConfig, TestHooks } from './types.js';
import { expandSkills } from '../skills/expander.js';
import { parseToolCall } from '../tools/tool-call-parser.js';
import type { ToolCall } from '../tools/types.js';
import { interpolateEnvData, type EnvDataContext } from './interpolate-env-data.js';
import { loadDataFromPath, type DataObject } from '../env/data-loader.js';
import { logger } from '../utils/logger.js';

/** Prefix marker on a step that opts out of beforeEach / afterEach hooks. */
const NO_HOOKS_MARKER = /^\[no-hooks\]\s*/i;

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

  if (options.skillsDir) {
    const stepsExp = await expandSkills(parsed.steps, options.skillsDir);
    parsed.steps = stepsExp.steps;
    parsed.sourceSkills = stepsExp.sourceSkills;

    const beforeExp = await expandSkills(parsed.hooks.before, options.skillsDir);
    const beforeEachExp = await expandSkills(parsed.hooks.beforeEach, options.skillsDir);
    const afterEachExp = await expandSkills(parsed.hooks.afterEach, options.skillsDir);
    const afterExp = await expandSkills(parsed.hooks.after, options.skillsDir);

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
    while (parsed.skipHooks.length < parsed.steps.length) {
      parsed.skipHooks.push(false);
    }
    if (parsed.skipHooks.length > parsed.steps.length) {
      parsed.skipHooks.length = parsed.steps.length;
    }
  }

  if (options.envData) {
    const extraData = await loadFrontmatterDataSources(
      parsed.frontmatter.dataSources,
      absPath,
    );
    const ctx: EnvDataContext = {
      ...options.envData,
      ...(extraData && { extraData }),
      filePath: absPath,
    };
    applyEnvDataInterpolation(parsed, ctx);
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
): Promise<Record<string, DataObject> | undefined> {
  if (!sources || Object.keys(sources).length === 0) return undefined;

  const testDir = path.dirname(testFileAbsPath);
  const out: Record<string, DataObject> = {};
  for (const [name, declaredPath] of Object.entries(sources)) {
    const absPath = resolveDataSourcePath(declaredPath, testDir);
    out[name] = await loadDataFromPath(absPath);
  }
  return out;
}

/** Expand `~` and resolve relative paths against `testDir`. */
function resolveDataSourcePath(declaredPath: string, testDir: string): string {
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
 * Tool-call argument strings ARE interpolated (so `[tool: foo bar="${env.X}"]`
 * works), but the parsed `ToolCall.args` map is rebuilt by re-parsing the
 * interpolated step text rather than mutating each value individually.
 */
function applyEnvDataInterpolation(parsed: ParsedTest, ctx: EnvDataContext): void {
  parsed.steps = parsed.steps.map((s) => interpolateEnvData(s, ctx));
  parsed.toolCalls = parsed.steps.map((s) => parseToolCall(s));

  parsed.hooks = {
    before: parsed.hooks.before.map((s) => interpolateEnvData(s, ctx)),
    beforeEach: parsed.hooks.beforeEach.map((s) => interpolateEnvData(s, ctx)),
    afterEach: parsed.hooks.afterEach.map((s) => interpolateEnvData(s, ctx)),
    after: parsed.hooks.after.map((s) => interpolateEnvData(s, ctx)),
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

  // TestConfig is a flat key-value map; only the string fields need substitution.
  const cfg = parsed.config as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'string') cfg[k] = interpolateEnvData(v, ctx);
  }
}

/**
 * Parse a Markdown skill file. Skills share the same parser as tests but
 * additionally read the `## Outputs` section and use the H1 as the skill name.
 */
export async function parseSkillFile(filePath: string): Promise<ParsedSkill> {
  const absPath = path.resolve(filePath);
  const rawContent = await fs.readFile(absPath, 'utf-8');
  return parseSkillContent(rawContent, absPath);
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
    skipHooks: sections.skipHooks,
    toolCalls: sections.toolCalls,
    // Pre-skill-expansion: every step is inline (no source skill yet). Will be
    // re-populated by parseTestFile after expandSkills() runs.
    sourceSkills: sections.steps.map(() => null),
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
  const { sections, title } = parseSections(rawContent, filePath);

  return {
    filePath,
    name: title || path.basename(filePath, '.md'),
    parameters: sections.parameters,
    outputs: sections.outputs,
    steps: sections.steps,
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
  hooks: TestHooks;
}

function parseSections(rawContent: string, filePath: string): {
  sections: ParsedSections;
  frontmatter: ReturnType<typeof parseFrontmatter>['frontmatter'];
  title: string;
} {
  const { frontmatter, body } = parseFrontmatter(rawContent);

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

  for (const token of tokens) {
    if (token.type === 'heading') {
      const headingToken = token as Tokens.Heading;
      const text = headingToken.text.trim();

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

    if (currentSection === 'steps' && token.type === 'list') {
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

  return {
    sections: { config, parameters, outputs, steps, skipHooks, toolCalls, hooks },
    frontmatter,
    title,
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
