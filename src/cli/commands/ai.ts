/**
 * `steptix ai`: choosing the AI from a terminal (docs/specs/SPEC-install.md
 * §7.2). The same questions as the VS Code extension's AI step, and the same
 * files written: a provider, a key checked with that provider, a model with
 * the provider's recommended model first, and where to save it. GitHub
 * Copilot is not offered, because it works only inside VS Code.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { Command } from 'commander';
import {
  AI_PROVIDERS,
  checkProviderKey,
  envValueBlank,
  maskKey,
  modelChoices,
  projectAiOverrides,
  providerEnvText,
  providerInfo,
  withEnvIgnored,
  type ProviderFetch,
  type ProviderId,
} from '../../ai/provider-setup.js';
import { PRIVATE_FILE_MODE, userRootEnvPath } from '../../env/user-root.js';
import { canAskUser, createLineReader } from '../../utils/ask-user.js';

/** What `steptix ai` needs from the world, so a test can stand in for it. */
export interface AiCommandIo {
  /** Ask, and resolve to the answer. `hidden` for the key, which is not echoed. */
  ask(question: string, opts?: { hidden?: boolean }): Promise<string>;
  out(line: string): void;
  err(line: string): void;
  fetch: ProviderFetch;
  /** The machine .env: "All my projects" (§7.2). */
  machineEnvPath: string;
  /** Where "Only this project" writes: the project's .env. */
  projectDir: string;
  /** Where `.env` in `projectDir` stands with git: {@link EnvGitState}. */
  envGitState(projectDir: string): EnvGitState;
  platform: NodeJS.Platform;
}

/**
 * Where a project's `.env` stands with git: `safe` outside a repository or
 * ignored, `not-ignored` when a commit would pick it up, and `committed` when
 * git already tracks it, which a .gitignore line no longer changes.
 */
export type EnvGitState = 'safe' | 'not-ignored' | 'committed';

/** Where a company proxy is set for this command. Node's fetch reads
 *  HTTPS_PROXY only with NODE_USE_ENV_PROXY=1. */
const TERMINAL_PROXY = 'this terminal (HTTPS_PROXY, with NODE_USE_ENV_PROXY=1)';

const ATTEMPTS = 3;

/** The answer as a 1-based index into `count` items, or null. */
function pickIndex(answer: string, count: number): number | null {
  const n = Number(answer.trim());
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : null;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

export async function chooseAi(io: AiCommandIo): Promise<number> {
  io.out('(GitHub Copilot works only inside VS Code. To use it, choose it in the Steptix extension.)');

  // 1. The provider.
  const labels = AI_PROVIDERS.map((p, i) => `${i + 1}) ${p.label}`).join('  ');
  let providerIndex: number | null = null;
  for (let i = 0; i < ATTEMPTS && providerIndex === null; i++) {
    const answer = await io.ask(`Which provider? ${labels} [1]: `);
    providerIndex = answer.trim() === '' ? 0 : pickIndex(answer, AI_PROVIDERS.length);
  }
  if (providerIndex === null) {
    io.err('No provider chosen; nothing was saved.');
    return 1;
  }
  const provider: ProviderId = AI_PROVIDERS[providerIndex]!.id;
  const info = providerInfo(provider);

  // 2. The key, checked before anything is saved.
  let key = '';
  let models: string[] | null = null;
  io.out(`Make a key at ${info.keyPage} if you have none.`);
  for (let tries = 0, blanks = 0; tries < ATTEMPTS && blanks < ATTEMPTS && models === null; ) {
    key = (await io.ask(`${info.label} API key: `, { hidden: true })).trim();
    if (key === '') {
      // Not a key the provider refused, so it does not use up a try.
      blanks++;
      io.err('Paste the key, then press Enter.');
      continue;
    }
    tries++;
    const check = await checkProviderKey(provider, key, io.fetch, TERMINAL_PROXY);
    if (check.ok) {
      models = check.models;
      io.out('Key works.');
    } else {
      io.err(check.message);
      if (check.reason === 'unreachable') break;
    }
  }
  if (models === null) {
    io.err('Nothing was saved.');
    return 1;
  }

  // 3. The model, Steptix's recommended one first.
  const choices = modelChoices(provider, models);
  const shown = choices.slice(0, 15);
  shown.forEach((m, i) => io.out(`  ${i + 1}) ${m.label}`));
  if (choices.length > shown.length) io.out(`  … and ${choices.length - shown.length} more: type a model id`);
  const modelAnswer = (await io.ask('Model? Its number, or type a model id [1]: ')).trim();
  const index = modelAnswer === '' ? 0 : pickIndex(modelAnswer, shown.length);
  const modelId = index !== null ? shown[index]?.id : modelAnswer;
  if (!modelId) {
    io.err('No model chosen; nothing was saved.');
    return 1;
  }

  // 4. Where it is saved.
  const projectEnv = path.join(io.projectDir, '.env');
  const where = (await io.ask(`Save for 1) all your projects  2) only this project (${io.projectDir}) [1]: `)).trim();
  const forProject = where === '2';
  const target = forProject ? projectEnv : io.machineEnvPath;
  const git = forProject ? io.envGitState(io.projectDir) : 'safe';
  if (git === 'committed') {
    io.err(
      `${projectEnv} is already committed to git, so a key saved there goes into the next commit; .gitignore cannot stop that. ` +
        'Run git rm --cached .env first, or save for all your projects.',
    );
    io.err('Nothing was saved.');
    return 1;
  }
  if (git === 'not-ignored') {
    const add = (await io.ask(`${projectEnv} is not in .gitignore, and it will hold your key. Add it? [Y/n]: `)).trim();
    if (!/^n/i.test(add)) {
      const gitignore = path.join(io.projectDir, '.gitignore');
      fs.writeFileSync(gitignore, withEnvIgnored(readText(gitignore)));
      io.out('Added .env to .gitignore.');
    }
  }
  if (!forProject) {
    const projectText = readText(projectEnv);
    const own = projectAiOverrides(projectText);
    if (envValueBlank(projectText, 'AI_API_KEY')) {
      io.err(
        `${projectEnv} has an empty AI_API_KEY= line, which keeps the all-projects key from reaching this project. ` +
          'Remove that line, or run steptix ai again and save for only this project.',
      );
    } else if (own.length > 0) {
      io.err(
        `${projectEnv} sets its own ${own.join(' and ')}, which this project uses instead of the all-projects choice. ` +
          'Remove those lines to use it here, or run steptix ai again and save for only this project.',
      );
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, providerEnvText(readText(target), provider, modelId, key), { mode: PRIVATE_FILE_MODE });
  if (io.platform !== 'win32') fs.chmodSync(target, PRIVATE_FILE_MODE);
  io.out(
    `${forProject ? 'Saved for this project' : 'Saved for all your projects'}: ${info.label}, ${modelId}, key ending ${maskKey(key)}.`,
  );
  return 0;
}

/** Where `.env` in `dir` stands with git ({@link EnvGitState}). */
function envGitStateOf(dir: string): EnvGitState {
  const git = (args: string[]): boolean => {
    try {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (!git(['rev-parse', '--is-inside-work-tree'])) return 'safe';
  if (git(['ls-files', '--error-unmatch', '.env'])) return 'committed';
  return git(['check-ignore', '-q', '.env']) ? 'safe' : 'not-ignored';
}

/** The project the terminal is in: the nearest folder up with a steptix.config.json, else this one. */
function projectDirFrom(cwd: string): string {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'steptix.config.json'))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(cwd);
  }
}

/** A terminal that does not echo what is typed while `muted` is on. */
class MutableOutput extends Writable {
  muted = false;
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    if (!this.muted) process.stdout.write(chunk);
    done();
  }
}

export function registerAiCommand(program: Command): void {
  program
    .command('ai')
    .description('Choose the AI: a provider, your key and a model, for all your projects or this one')
    .action(async () => {
      if (!canAskUser()) {
        process.stderr.write('steptix ai asks questions, so run it in a terminal.\n');
        process.exitCode = 1;
        return;
      }
      const output = new MutableOutput();
      const reader = createLineReader({ output, terminal: true });
      try {
        process.exitCode = await chooseAi({
          ask: async (question, opts) => {
            process.stdout.write(question);
            output.muted = opts?.hidden === true;
            try {
              return await reader.question('');
            } finally {
              if (output.muted) process.stdout.write('\n');
              output.muted = false;
            }
          },
          out: (line) => process.stdout.write(`${line}\n`),
          err: (line) => process.stderr.write(`${line}\n`),
          fetch: (url, init) => fetch(url, init),
          machineEnvPath: userRootEnvPath(),
          projectDir: projectDirFrom(process.cwd()),
          envGitState: envGitStateOf,
          platform: process.platform,
        });
      } finally {
        reader.close();
      }
    });
}
