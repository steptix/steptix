import fs from 'node:fs/promises';
import path from 'node:path';
import { marked, type Token, type Tokens } from 'marked';
import { parseFrontmatter } from './frontmatter.js';
import type { ParsedTest, TestConfig } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Parse a Markdown test file into a structured ParsedTest object.
 * Handles: frontmatter, H1 title, ## Config, ## Parameters, ## Steps sections.
 */
export async function parseTestFile(filePath: string): Promise<ParsedTest> {
  const absPath = path.resolve(filePath);
  const rawContent = await fs.readFile(absPath, 'utf-8');
  return parseTestContent(rawContent, absPath);
}

/** Parse test content from a string (useful for testing) */
export function parseTestContent(rawContent: string, filePath = '<inline>'): ParsedTest {
  const { frontmatter, body } = parseFrontmatter(rawContent);

  const tokens = marked.lexer(body);

  let title = '';
  const config: TestConfig = {};
  const parameters: Record<string, string> = {};
  const steps: string[] = [];

  let currentSection: 'config' | 'parameters' | 'steps' | null = null;

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
        } else if (lower === 'steps') {
          currentSection = 'steps';
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

    if (currentSection === 'steps' && token.type === 'list') {
      extractSteps(token as Tokens.List, steps);
    }
  }

  if (!title) {
    logger.warn(`Test file ${filePath} has no H1 title heading`);
    title = path.basename(filePath, '.md');
  }

  if (steps.length === 0) {
    logger.warn(`Test file ${filePath} has no steps defined in ## Steps section`);
  }

  return {
    filePath,
    title,
    frontmatter,
    config,
    parameters,
    steps,
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

/** Extract ordered steps from a list token */
function extractSteps(listToken: Tokens.List, steps: string[]): void {
  for (const item of listToken.items) {
    const text = extractPlainText(item.tokens).trim();
    if (text) {
      steps.push(text);
    }
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
