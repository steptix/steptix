import fs from 'node:fs/promises';
import path from 'node:path';
import { marked, type Token, type Tokens } from 'marked';
import { parseFrontmatter } from './frontmatter.js';
import type { ParsedSkill, ParsedTest, TestConfig, TestHooks } from './types.js';
import { expandSkills } from '../skills/expander.js';
import { logger } from '../utils/logger.js';

/** Prefix marker on a step that opts out of beforeEach / afterEach hooks. */
const NO_HOOKS_MARKER = /^\[no-hooks\]\s*/i;

/** Valid `## Hooks` scope prefixes — case-insensitive match, stored lowercase. */
const HOOK_SCOPES = new Set(['before', 'beforeeach', 'aftereach', 'after']);

export interface ParseOptions {
  /** Directory to resolve `[skill: name]` references from. Omit to disable. */
  skillsDir?: string;
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
    parsed.steps = await expandSkills(parsed.steps, options.skillsDir);
    parsed.hooks = {
      before: await expandSkills(parsed.hooks.before, options.skillsDir),
      beforeEach: await expandSkills(parsed.hooks.beforeEach, options.skillsDir),
      afterEach: await expandSkills(parsed.hooks.afterEach, options.skillsDir),
      after: await expandSkills(parsed.hooks.after, options.skillsDir),
    };
  }

  return parsed;
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
    hooks: sections.hooks,
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
      extractSteps(token as Tokens.List, steps, skipHooks);
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
    sections: { config, parameters, outputs, steps, skipHooks, hooks },
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

/** Extract ordered steps from a list token, stripping `[no-hooks]` markers and
 *  recording their positions in the parallel `skipHooks` array. */
function extractSteps(
  listToken: Tokens.List,
  steps: string[],
  skipHooks: boolean[],
): void {
  for (const item of listToken.items) {
    const text = extractPlainText(item.tokens).trim();
    if (!text) continue;
    const noHooks = NO_HOOKS_MARKER.test(text);
    const cleaned = noHooks ? text.replace(NO_HOOKS_MARKER, '').trim() : text;
    if (!cleaned) continue;
    steps.push(cleaned);
    skipHooks.push(noHooks);
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
