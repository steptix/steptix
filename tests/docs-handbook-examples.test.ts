/**
 * Keeps docs/test-writing-handbook.md honest.
 *
 * The handbook promises that every Markdown example is a complete file the
 * parser accepts and every TypeScript example under a "File `tools/src/…`:"
 * line is a tool the registry loads. A TypeScript example with no File line
 * must be one compiled-step entry (a `.steps.ts` excerpt), and parses as one.
 * This suite extracts each fenced example, materialises it as a small project
 * (tests/, skills/, tools/src/) and pushes it through the real parser, tool
 * registry and tool executor — no AI, no browser, no server.
 *
 * Where the project is materialised matters. The tool examples import the
 * bare specifier `steptix/tools`, which Node resolves by package
 * self-reference: the nearest package.json above the importing file must be
 * this repo's own, whose `exports` map points at dist/tools/index.js. A temp
 * dir under os.tmpdir() has no such ancestor and the import fails, so the
 * project lives in its own `tests/.tmp-handbook-*` directory (gitignored) and
 * is removed afterwards. The same rule makes a built `dist/` a prerequisite —
 * exactly as it already is for the fixtures/tools suites.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Page, BrowserContext, Browser } from 'playwright';
import { parseTestFile, parseSkillFile } from '../src/parser/markdown.js';
import type { ParsedTest } from '../src/parser/types.js';
import { loadToolCatalogue, type ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';

const repoRoot = path.resolve(__dirname, '..');
const handbookPath = path.join(repoRoot, 'docs', 'test-writing-handbook.md');

// ---------------------------------------------------------------------------
// Fence extraction
// ---------------------------------------------------------------------------

interface Fence {
  /** Fence language tag: `markdown`, `ts`, `bash`, … */
  lang: string;
  /** Path from the preceding "File `…`:" line, or null when the fence has none. */
  file: string | null;
  body: string;
  /** 1-based line of the opening fence, for failure messages. */
  line: number;
}

const FILE_LINE = /^File `([^`]+)`:\s*$/;
const FENCE_OPEN = /^```(\w*)\s*$/;

/**
 * Walk the handbook and pair each fence with the `File` line that introduces
 * it. A `File` line binds only when nothing but blank lines separates it from
 * the fence; a `File` line left dangling (prose in between, or no fence at
 * all) is reported, since the handbook's own convention is what this suite
 * relies on to know where an example belongs.
 */
function extractFences(markdown: string): { fences: Fence[]; danglingFileLines: number[] } {
  const lines = markdown.split(/\r?\n/);
  const fences: Fence[] = [];
  const danglingFileLines: number[] = [];
  let pending: { file: string; line: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fileMatch = FILE_LINE.exec(line);
    if (fileMatch) {
      if (pending) danglingFileLines.push(pending.line + 1);
      pending = { file: fileMatch[1]!, line: i };
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (!open) {
      if (pending && line.trim() !== '') {
        danglingFileLines.push(pending.line + 1);
        pending = null;
      }
      continue;
    }
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j] !== '```') {
      body.push(lines[j]!);
      j++;
    }
    fences.push({
      lang: open[1] ?? '',
      file: pending?.file ?? null,
      body: body.join('\n') + '\n',
      line: i + 1,
    });
    pending = null;
    i = j;
  }
  if (pending) danglingFileLines.push(pending.line + 1);
  return { fences, danglingFileLines };
}

function slugOf(fence: Fence): string {
  const title = /^# (.+)$/m.exec(fence.body)?.[1] ?? 'example';
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Materialised project
// ---------------------------------------------------------------------------

interface Example {
  fence: Fence;
  /** Path relative to the project root, e.g. `tests/login.md`. */
  rel: string;
  abs: string;
}

let projectDir: string;
let skillsDir: string;
let toolsDir: string;
const examples: Example[] = [];
/** ```ts fences with no File line: excerpts of a compiled `.steps.ts`, one entry each. */
const entryFragments: Fence[] = [];
/** ```markdown fences with no File line and no H1: excerpts of a test's steps. */
const stepExcerpts: Fence[] = [];
/** An entry excerpt opens as an object literal and names the step it compiles. */
const ENTRY_FRAGMENT = /^\s*\{[\s\S]*\bsource:/;
let danglingFileLines: number[] = [];
let handbook = '';

/** Parsed test files, keyed by their H1 title (stable across generated file names). */
const parsedByTitle = new Map<string, ParsedTest>();

beforeAll(async () => {
  const distTools = path.join(repoRoot, 'dist', 'tools', 'index.js');
  if (!fs.existsSync(distTools)) {
    throw new Error(
      `docs-handbook-examples needs a built dist/ (run \`npm run build\`): the handbook's ` +
        `tool examples import 'steptix/tools', which resolves to ${distTools}`,
    );
  }

  handbook = fs.readFileSync(handbookPath, 'utf8');
  const extracted = extractFences(handbook);
  danglingFileLines = extracted.danglingFileLines;

  projectDir = fs.mkdtempSync(path.join(repoRoot, 'tests', '.tmp-handbook-'));
  skillsDir = path.join(projectDir, 'skills');
  toolsDir = path.join(projectDir, 'tools', 'src');

  let generated = 0;
  for (const fence of extracted.fences) {
    if (fence.lang !== 'markdown' && fence.lang !== 'ts') continue;
    let rel = fence.file;
    if (rel === null) {
      if (fence.lang === 'ts') {
        if (!ENTRY_FRAGMENT.test(fence.body)) {
          throw new Error(
            `handbook line ${fence.line}: a \`\`\`ts fence needs a "File \`tools/src/…\`:" line — a tool's file name is its identity — unless it is one compiled-step entry ({ source: …, run | condition })`,
          );
        }
        entryFragments.push(fence);
        continue;
      }
      if (!/^# /m.test(fence.body)) {
        // A step excerpt (a line or two, or one `### Section`), not a file:
        // checked inside the smallest file that can hold it.
        stepExcerpts.push(fence);
        continue;
      }
      rel = `tests/example-${++generated}-${slugOf(fence)}.md`;
    }
    if (!/^(tests|skills|tools\/src)\//.test(rel)) {
      throw new Error(
        `handbook line ${fence.line}: File \`${rel}\` is outside tests/, skills/ or tools/src/ — extend this suite if the handbook now documents another location`,
      );
    }
    const abs = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, fence.body);
    examples.push({ fence, rel, abs });
  }

  for (const ex of examples.filter((e) => e.rel.startsWith('tests/'))) {
    const parsed = await parseTestFile(ex.abs, { skillsDir });
    parsedByTitle.set(parsed.title, parsed);
  }
});

afterAll(() => {
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5 });
});

const byTitle = (title: string): ParsedTest => {
  const parsed = parsedByTitle.get(title);
  if (!parsed) {
    throw new Error(
      `no handbook example titled "${title}" — known: ${[...parsedByTitle.keys()].join(', ')}`,
    );
  }
  return parsed;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handbook fences', () => {
  it('every "File `…`:" line is followed directly by a fence', () => {
    expect(danglingFileLines, 'handbook lines whose File marker binds to no fence').toEqual([]);
  });

  it('contains Markdown test examples and TypeScript tool examples', () => {
    const md = examples.filter((e) => e.fence.lang === 'markdown');
    const ts = examples.filter((e) => e.fence.lang === 'ts');
    expect(md.length).toBeGreaterThan(0);
    expect(ts.length).toBeGreaterThan(0);
    expect(ts.every((e) => e.rel.startsWith('tools/src/'))).toBe(true);
  });
});

describe('every Markdown test example parses', () => {
  it('yields at least one step per file', () => {
    const tests = examples.filter((e) => e.rel.startsWith('tests/'));
    expect(tests.length).toBeGreaterThan(0);
    expect(parsedByTitle.size, 'two examples share an H1 title').toBe(tests.length);
    for (const parsed of parsedByTitle.values()) {
      expect(parsed.steps.length, `${parsed.title}: no steps parsed`).toBeGreaterThan(0);
    }
  });

  it('login.md: frontmatter, config and parameters survive as the handbook says', () => {
    const p = byTitle('Valid user can sign in');
    expect(p.frontmatter.tags).toEqual(['smoke', 'login']);
    expect(p.frontmatter.timeout).toBe('120s');
    expect(p.config.baseUrl).toBe('https://app.example.test');
    expect(p.config.viewport).toBe('desktop');
    expect(Object.keys(p.parameters)).toEqual(['email', 'password']);
    expect(p.steps).toHaveLength(7);
  });

  it('sign-in-matrix.md: a table under ## Steps becomes data rows', () => {
    const p = byTitle('Sign-in validation');
    expect(p.dataRows).toHaveLength(3);
    for (const row of p.dataRows!) {
      expect(Object.keys(row)).toEqual(['email', 'password', 'outcome']);
    }
    expect(p.steps).toHaveLength(5);
  });

  it('search-products.md: sections expand inline and a section table loops its body', () => {
    const p = byTitle('Search two products');
    expect(Object.keys(p.sections).sort()).toEqual(['search each product', 'sign in', 'sign out']);
    expect(p.sections['search each product']!.rows).toHaveLength(2);
    // 4 (sign in) + 3 × 2 rows (search each product) + 1 (main-flow verify) + 2 (sign out)
    expect(p.steps).toHaveLength(13);
    expect(p.steps).toContain('Verify the Search field is visible');
    expect(p.steps.filter((s) => s.startsWith('Type "blue mug"'))).toHaveLength(1);
    expect(p.steps.filter((s) => s.startsWith('Type "green plate"'))).toHaveLength(1);
    expect(new Set(p.sourceSections.filter(Boolean))).toEqual(
      new Set(['Sign in', 'Search each product', 'Sign out']),
    );
  });

  it('greeting.md: the skill call expands and out.<name>="alias" renames the capture', () => {
    const p = byTitle('Sign-in greeting');
    expect(p.steps.some((s) => s.includes('[skill:'))).toBe(false);
    expect(p.sourceSkills.filter((s) => s === 'auth/sign_in')).toHaveLength(10);
    expect(p.steps).toContain('Read the name shown in the account menu [store as: signed_in_name]');
    expect(p.steps).toContain('Read the name shown in the account menu [store as: second_name]');
    expect(p.steps).toContain('Type "second.user@example.test" into the Email field');
  });

  it('hooks example: the four hook slots fill and [no-hooks] marks its step', () => {
    const p = byTitle('Orders with hooks');
    expect(p.hooks.before).toEqual(['Navigate to /login']);
    expect(p.hooks.beforeEach).toHaveLength(1);
    expect(p.hooks.afterEach).toHaveLength(1);
    expect(p.hooks.after).toHaveLength(1);
    expect(p.steps).toHaveLength(3);
    expect(p.skipHooks).toEqual([false, true, false]);
    expect(p.steps[1]).not.toContain('[no-hooks]');
  });
});

describe('every skill example parses', () => {
  it('sign_in declares the parameters and outputs the handbook shows', async () => {
    const skills = examples.filter((e) => e.rel.startsWith('skills/'));
    expect(skills.length).toBeGreaterThan(0);
    for (const ex of skills) {
      const skill = await parseSkillFile(ex.abs);
      expect(skill.steps.length, `${ex.rel}: no steps`).toBeGreaterThan(0);
    }
    const signIn = await parseSkillFile(path.join(skillsDir, 'auth', 'sign_in.md'));
    expect(signIn.name).toBe('sign_in');
    expect(Object.keys(signIn.parameters)).toEqual(['login_url', 'email', 'password']);
    expect(signIn.outputs).toEqual(['display_name']);
    expect(signIn.steps).toHaveLength(5);
  });
});

describe('every tool example loads and every [tool:] call resolves', () => {
  let catalogue: ToolCatalogue;

  beforeAll(async () => {
    catalogue = await loadToolCatalogue(toolsDir);
  });

  it('the registry indexes one file per TypeScript fence', () => {
    const ts = examples.filter((e) => e.fence.lang === 'ts');
    expect(catalogue.indexedCount).toBe(ts.length);
  });

  it('each [tool:] reference in a Markdown example resolves to a loaded tool', async () => {
    const calls = [...parsedByTitle.values()].flatMap((p) =>
      p.toolCalls
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => ({ title: p.title, call: c })),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const { title, call } of calls) {
      // `resolve` throws with the registry's own diagnostic when a ref is bad.
      const tool = await catalogue.resolve(call.name);
      expect(tool.definition.name, `${title}: [tool: ${call.name}]`).toBe(call.name.split('/').pop());
    }
  });

  describe('the pure tools run against stub Playwright objects', () => {
    // What a tool would see from the app under test. The handbook's tools only
    // touch `context.request.get`, `page.goto` and `page.title`.
    const requests: string[] = [];
    const visited: string[] = [];
    const ORDERS = [{ id: 'O-1003' }, { id: 'O-1007' }];

    const context = {
      request: {
        get: async (url: string) => {
          requests.push(url);
          return {
            ok: () => true,
            status: () => 200,
            statusText: () => 'OK',
            json: async () => (url.includes('/api/orders') ? ORDERS : { status: 'ok' }),
          };
        },
      },
    } as unknown as BrowserContext;
    const page = {
      goto: async (url: string) => {
        visited.push(url);
        return null;
      },
      title: async () => `Title of ${visited[visited.length - 1]}`,
    } as unknown as Page;
    const browser = {} as unknown as Browser;

    // Values that AI-driven steps would have captured before a tool call.
    const AI_CAPTURES: Record<string, string> = {
      order_links: JSON.stringify([
        'https://app.example.test/orders/O-1003',
        'https://app.example.test/orders/O-1007',
      ]),
    };

    /** Run every [tool:] step of an example in order, sharing one variable map. */
    async function runTools(title: string): Promise<Record<string, string>> {
      const p = byTitle(title);
      const params: Record<string, string> = { ...p.parameters, ...AI_CAPTURES };
      // `## Config` baseUrl feeds the bare `baseUrl` argument shorthand.
      const baseUrl = p.config.baseUrl !== undefined ? { baseUrl: p.config.baseUrl } : {};
      for (const [i, call] of p.toolCalls.entries()) {
        if (!call) continue;
        const outcome = await executeToolStep(call, {
          page,
          context,
          browser,
          catalogue,
          resolvedParameters: params,
          ...baseUrl,
        });
        expect(
          outcome.status,
          `${title} step ${i + 1} [tool: ${call.name}]: ${outcome.error ?? ''}`,
        ).toBe('passed');
      }
      return params;
    }

    it('a bare function: the return value is the single output, aliased on the call', async () => {
      const params = await runTools('Bare tool call');
      expect(params['request_id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('tool(): the bare `baseUrl` shorthand reads ## Config and a boolean stores as "true"', async () => {
      requests.length = 0;
      const params = await runTools('Health check');
      expect(requests).toEqual(['https://app.example.test/api/health']);
      expect(params['healthy']).toBe('true');
    });

    it('named exports: file/name refs chain through {{slug}} to the value the handbook asserts', async () => {
      const params = await runTools('Named-export tools');
      expect(params['slug']).toBe('hello-world');
      expect(params['shout']).toBe('HELLO-WORLD');
    });

    it('defineTool: defaults apply, arrays JSON-encode, and a JSON array decodes into string[]', async () => {
      requests.length = 0;
      visited.length = 0;
      const params = await runTools('Orders round trip');
      expect(requests).toEqual(['https://app.example.test/api/orders?sinceDays=30&status=failed']);
      expect(JSON.parse(params['order_ids']!)).toEqual(['O-1003', 'O-1007']);
      expect(params['order_count']).toBe('2');
      expect(visited).toEqual(JSON.parse(AI_CAPTURES['order_links']!));
      expect(JSON.parse(params['page_titles']!)).toEqual([
        'Title of https://app.example.test/orders/O-1003',
        'Title of https://app.example.test/orders/O-1007',
      ]);
    });
  });
});

describe('every step excerpt parses as steps', () => {
  it('each yields at least one step or section inside a minimal test file', async () => {
    expect(stepExcerpts.length).toBeGreaterThan(0);
    for (const fence of stepExcerpts) {
      const abs = path.join(projectDir, 'excerpts', `line-${fence.line}.md`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `# Excerpt at handbook line ${fence.line}\n\n## Steps\n\n${fence.body}\n`);
      const parsed = await parseTestFile(abs, { skillsDir });
      const found = parsed.steps.length + Object.keys(parsed.sections).length;
      expect(found, `handbook line ${fence.line}: no step or section parsed`).toBeGreaterThan(0);
    }
  });
});

describe('every compiled-step excerpt is one well-formed entry', () => {
  it('the handbook shows at least one', () => {
    expect(entryFragments.length).toBeGreaterThan(0);
  });

  it('each parses, names its source, and has exactly one of run or condition', () => {
    for (const fence of entryFragments) {
      const where = `handbook line ${fence.line}`;
      // The excerpt is one element of a `.steps.ts` entries array, trailing
      // comma included, so it is checked in exactly that position.
      const code = `export default [\n${fence.body}\n];\n`;
      const syntax = ts.transpileModule(code, { reportDiagnostics: true }).diagnostics ?? [];
      expect(
        syntax.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
        `${where}: syntax`,
      ).toEqual([]);

      const file = ts.createSourceFile('entry.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const list = (file.statements[0] as ts.ExportAssignment).expression as ts.ArrayLiteralExpression;
      expect(list.elements.length, `${where}: one entry`).toBe(1);
      const entry = list.elements[0]!;
      expect(ts.isObjectLiteralExpression(entry), `${where}: an object literal`).toBe(true);
      const names = (entry as ts.ObjectLiteralExpression).properties.map((p) =>
        p.name && ts.isIdentifier(p.name) ? p.name.text : '',
      );
      expect(names, where).toContain('source');
      expect(
        names.filter((n) => n === 'run' || n === 'condition'),
        `${where}: run or condition, not both`,
      ).toHaveLength(1);
    }
  });
});

describe('handbook links', () => {
  it('every relative Markdown link points at an existing file', () => {
    const prose = handbook
      .replace(/```[\s\S]*?```/g, '') // fenced code
      .replace(/`[^`\n]*`/g, ''); // inline code
    const missing: string[] = [];
    let count = 0;
    for (const m of prose.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const target = m[1]!;
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      count++;
      const file = path.resolve(path.dirname(handbookPath), target.replace(/#.*$/, ''));
      if (!fs.existsSync(file)) missing.push(target);
    }
    expect(count).toBeGreaterThan(0);
    expect(missing, 'links in docs/test-writing-handbook.md with no file behind them').toEqual([]);
  });
});
