/**
 * `steptix ai` (docs/specs/SPEC-install.md §7.2), with its terminal and the
 * provider scripted: the questions it asks, the key checked before anything is
 * saved, and the files it writes. Provider answers are constructed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseAi, type AiCommandIo } from '../src/cli/commands/ai.js';
import { COPILOT_IN_TERMINAL, copilotOutOfReach } from '../src/ai/copilot-terminal.js';
import { aiChosen, chromePaths, firstRunLines } from '../src/launcher/first-run.js';
import { chromePaths as extensionChromePaths } from '../steptix-vscode/src/extension/install-core.ts';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'steptix-ai-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

/** A terminal that answers each question in turn, and a provider that takes
 *  only `good-key-test`. */
function terminal(answers: string[], opts: { untracked?: boolean } = {}) {
  const asked: Array<{ question: string; hidden: boolean }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const project = path.join(scratch, 'project');
  mkdirSync(project, { recursive: true });
  const io: AiCommandIo = {
    ask: async (question, o) => {
      asked.push({ question, hidden: o?.hidden === true });
      return answers.shift() ?? '';
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: async (_url, init) => {
      const good = init.headers['x-api-key'] === 'good-key-test';
      return { ok: good, status: good ? 200 : 401, json: async () => ({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5' }] }) };
    },
    machineEnvPath: path.join(scratch, 'home', 'steptix', '.env'),
    projectDir: project,
    envUntracked: () => opts.untracked === true,
    platform: process.platform,
  };
  return { io, asked, out, err, project };
}

describe('steptix ai', () => {
  it('asks for a provider, a hidden key it checks, a model with the recommended first, and saves for all projects', async () => {
    // Anthropic; a wrong key, then the right one; the first model; all projects.
    const t = terminal(['2', 'wrong-key-test', 'good-key-test', '', '']);
    expect(await chooseAi(t.io)).toBe(0);
    expect(t.out[0]).toMatch(/Copilot works only inside VS Code/);
    expect(t.asked.filter((q) => q.hidden).map((q) => q.question)).toEqual(['Anthropic API key: ', 'Anthropic API key: ']);
    expect(t.err).toContain('Anthropic did not accept this key. Check that you copied all of it, or make a new one.');
    expect(t.out).toContain('  1) Claude Sonnet 5.5 · recommended for Steptix');
    const written = readFileSync(t.io.machineEnvPath, 'utf8');
    expect(written).toBe('AI_MODEL=anthropic/claude-sonnet-5-5\nAI_API_KEY=good-key-test\n');
    expect(t.out.at(-1)).toBe('Saved for all your projects: Anthropic, claude-sonnet-5-5, key ending …test.');
    if (process.platform !== 'win32') expect(statSync(t.io.machineEnvPath).mode & 0o777).toBe(0o600);
  });

  it("saves for only this project, offering to keep the key out of git, and drops Copilot's bridge URL", async () => {
    const t = terminal(['2', 'good-key-test', 'claude-haiku-5', '2', ''], { untracked: true });
    writeFileSync(path.join(t.project, '.env'), 'AI_GATEWAY_URL=http://127.0.0.1:18790\nAI_MODEL=gateway/copilot/gpt-6-luna\n');
    expect(await chooseAi(t.io)).toBe(0);
    expect(readFileSync(path.join(t.project, '.env'), 'utf8')).toBe('AI_MODEL=anthropic/claude-haiku-5\nAI_API_KEY=good-key-test\n');
    expect(readFileSync(path.join(t.project, '.gitignore'), 'utf8')).toBe('.env\n');
    expect(existsSync(t.io.machineEnvPath)).toBe(false);
  });

  it("warns when this project's empty AI_API_KEY= line would keep the all-projects key out", async () => {
    const t = terminal(['2', 'good-key-test', '', '1']);
    writeFileSync(path.join(t.project, '.env'), 'AI_API_KEY=\n');
    expect(await chooseAi(t.io)).toBe(0);
    expect(t.err.join('\n')).toMatch(/empty AI_API_KEY= line, which keeps the all-projects key from reaching this project/);
  });

  it('saves nothing when the key never works', async () => {
    const t = terminal(['2', 'a', 'b', 'c']);
    expect(await chooseAi(t.io)).toBe(1);
    expect(existsSync(t.io.machineEnvPath)).toBe(false);
    expect(t.err.at(-1)).toBe('Nothing was saved.');
  });
});

describe('Copilot from a terminal', () => {
  it('says so when the AI is Copilot and the bridge does not answer', async () => {
    const down = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await copilotOutOfReach({ model: 'gateway/copilot/gpt-6-luna', gatewayUrl: 'http://127.0.0.1:18790' }, down)).toBe(true);
    expect(await copilotOutOfReach({ model: 'gateway/copilot/gpt-6-luna', gatewayUrl: 'http://127.0.0.1:18790' }, async () => ({}))).toBe(false);
    expect(await copilotOutOfReach({ model: 'openai/gpt-6-luna' }, down)).toBe(false);
    expect(COPILOT_IN_TERMINAL).toBe('Copilot works only inside VS Code. To use the AI from a terminal, run steptix ai.');
  });
});

describe("the first command's checks", () => {
  it('says whether Chrome was found and, with no AI chosen, how to choose one', () => {
    const machineEnv = path.join(scratch, 'machine.env');
    const lines = (exists: boolean, env: NodeJS.ProcessEnv = {}) =>
      firstRunLines({ cwd: scratch, machineEnv, env, platform: 'linux', exists: () => exists });
    expect(lines(true)).toEqual(['Google Chrome found.', 'No AI chosen yet. Run steptix ai to choose one.']);
    expect(lines(false)[0]).toMatch(/^Google Chrome was not found\./);
    writeFileSync(machineEnv, 'AI_API_KEY=first-run-test-key\n');
    expect(lines(true)).toEqual(['Google Chrome found.']);
  });

  it("counts a key in the project's .env or the environment as chosen", () => {
    const project = path.join(scratch, 'p');
    mkdirSync(path.join(project, 'tests'), { recursive: true });
    writeFileSync(path.join(project, 'steptix.config.json'), '{}');
    writeFileSync(path.join(project, '.env'), 'AI_API_KEY=first-run-test-key\n');
    expect(aiChosen(path.join(project, 'tests'), path.join(scratch, 'none.env'), {})).toBe(true);
    expect(aiChosen(scratch, path.join(scratch, 'none.env'), { AI_API_KEY: 'first-run-test-key' })).toBe(true);
    expect(aiChosen(scratch, path.join(scratch, 'none.env'), {})).toBe(false);
  });

  it("looks for Chrome where the extension's browser step does", () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' };
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(extensionChromePaths(platform, env)).toEqual(chromePaths(platform, env));
    }
  });
});
