import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseTestContent, parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-parser-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('parseTestContent — tool-call detection', () => {
  it('records a parallel toolCalls array of nulls for a test with no tools', () => {
    const parsed = parseTestContent(
      `# T\n## Steps\n1. Click login\n2. Type "alice" into the username field\n`,
    );
    expect(parsed.steps).toEqual([
      'Click login',
      'Type "alice" into the username field',
    ]);
    expect(parsed.toolCalls).toEqual([null, null]);
  });

  it('parses a [tool: ...] line into a ToolCall in the parallel array', () => {
    const parsed = parseTestContent(
      `# T\n## Steps\n1. Navigate to /\n2. [tool: read_title]\n3. Verify the title was "{{title}}"\n`,
    );
    expect(parsed.steps).toEqual([
      'Navigate to /',
      '[tool: read_title]',
      'Verify the title was "{{title}}"',
    ]);
    expect(parsed.toolCalls[0]).toBeNull();
    expect(parsed.toolCalls[1]).toEqual({
      name: 'read_title',
      args: {},
      outputAliases: {},
    });
    expect(parsed.toolCalls[2]).toBeNull();
  });

  it('captures shorthand and out-aliases on tool calls', () => {
    const parsed = parseTestContent(
      `# T\n## Steps\n1. [tool: fetch_csrf baseUrl out.csrf]\n`,
    );
    expect(parsed.toolCalls[0]).toEqual({
      name: 'fetch_csrf',
      args: { baseUrl: '{{baseUrl}}' },
      outputAliases: { csrf: 'csrf' },
    });
  });

  it('throws ToolCallSyntaxError on malformed tool calls (parse-time failure)', () => {
    expect(() =>
      parseTestContent(`# T\n## Steps\n1. [tool: foo bar=baz]\n`),
    ).toThrow(/expected '"', '\[', a number, or true\/false after '=' for argument 'bar'/);
  });
});

describe('parseTestFile — tool-call detection survives skill expansion', () => {
  it('re-derives toolCalls after skill expansion exposes a [tool: ...] inside a skill body', async () => {
    const skillsDir = path.join(tmpDir, 'skills');
    await fs.mkdir(skillsDir);
    await fs.writeFile(
      path.join(skillsDir, 'wrap_tool.md'),
      `---
type: skill
---
# wrap_tool
## Steps
1. Navigate somewhere
2. [tool: read_title]
`,
    );
    const testPath = path.join(tmpDir, 'mytest.md');
    await fs.writeFile(
      testPath,
      `# T\n## Steps\n1. [skill: wrap_tool]\n2. Done\n`,
    );

    const parsed = await parseTestFile(testPath, { skillsDir });
    expect(parsed.steps).toEqual([
      'Navigate somewhere',
      '[tool: read_title]',
      'Done',
    ]);
    expect(parsed.toolCalls[0]).toBeNull();
    expect(parsed.toolCalls[1]).toEqual({
      name: 'read_title',
      args: {},
      outputAliases: {},
    });
    expect(parsed.toolCalls[2]).toBeNull();
    expect(parsed.skipHooks.length).toBe(parsed.steps.length);
  });
});
