import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import type { Command } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * The sample project `steptix init` creates, and the VS Code extension's
 * Create a sample project too (docs/specs/SPEC-install.md §7.3): one source
 * for both, so the two ways in start from the same files. `src/cli/commands/`
 * and `dist/cli/commands/` both sit three levels under the package root.
 */
export const SAMPLE_DIR = path.join(__dirname, '../../../templates/sample');

/** The sample's test, which the closing message tells the user to run. */
export const SAMPLE_TEST = 'tests/first-test.md';

export function registerInitCommand(program: Command): void {
  program
    .command('init [dir]')
    .description('Create a sample Steptix project in the target directory (default: current dir)')
    .option('--force', 'Overwrite existing files', false)
    .action(async (dir: string | undefined, opts: { force: boolean }) => {
      await initCommand(dir ?? '.', opts.force);
    });
}

/**
 * The `steptix.config.json` a new project starts with: the sample's own,
 * `templates/sample/steptix.config.json`.
 *
 * Never `templates/init/steptix.config.json`, because that file is not a
 * starter config: `templates/init` is the live integration suite's fixture
 * workspace, and its config carries what the FIXTURES need —
 * `desktop.enabled: true` for `pdf-dialog-cancel.md`,
 * `browser.launchArgs: ["--disable-print-preview"]` for the same test, and a
 * `tests.toolsDir` that climbs out to `../../fixtures/tools/src`. Copied, the
 * first switched computer mode on in every project `steptix init` ever created,
 * which is the opt-in SPEC-use-computer.md §5.1 item 1 exists to require: a
 * test file in a shared project must not be able to move the mouse on a
 * machine whose owner did not say so. The toolsDir pointed at a directory no
 * new project has.
 *
 * So the two files are kept apart on purpose. This one names only what a new
 * project has to decide — the directories, a visible browser — and leaves
 * everything else, `desktop` included, at its default. It names no AI model
 * either: a project's model wins over the one chosen for all projects
 * (SPEC-install.md §7.2), so one written here would set that choice aside.
 * Exported for the test that pins all of that. Read when asked, not when the
 * CLI loads: every command loads this module, and only `init` needs the file.
 */
export function scaffoldConfig(): string {
  return readFileSync(path.join(SAMPLE_DIR, 'steptix.config.json'), 'utf-8');
}

/** Every file in the sample, as paths relative to it with `/` separators.
 *  Dot entries, such as a compile cache, are not part of it. */
export async function sampleFiles(dir: string = SAMPLE_DIR): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  await walk('');
  return out.sort();
}

export async function initCommand(targetDir: string, force: boolean): Promise<void> {
  const absTarget = path.resolve(targetDir);

  console.log(chalk.bold(`\nCreating a Steptix project in: ${chalk.cyan(absTarget)}\n`));

  await fs.mkdir(absTarget, { recursive: true });

  // The standard project folders, empty ones included.
  for (const dir of ['tests', 'context', 'reports']) {
    await fs.mkdir(path.join(absTarget, dir), { recursive: true });
    console.log(chalk.green('  ✓') + ` Created ${dir}/`);
  }

  for (const file of await sampleFiles()) {
    const destPath = path.join(absTarget, ...file.split('/'));
    if (!force) {
      try {
        await fs.access(destPath);
        console.log(chalk.yellow('  ⚠') + ` Skipping ${file} (already exists — use --force to overwrite)`);
        continue;
      } catch {
        // Not there yet.
      }
    }
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(path.join(SAMPLE_DIR, ...file.split('/')), destPath);
    console.log(chalk.green('  ✓') + ` Created ${file}`);
  }

  console.log(chalk.bold(`\n${'─'.repeat(50)}`));
  console.log(`  ${chalk.cyan(SAMPLE_TEST)} is a test of the page in ${chalk.cyan('pages/')}, with its`);
  console.log('  steps already compiled, so it runs as it is: no AI, no network.');
  console.log('');
  console.log(`  Run it: ${chalk.cyan(`steptix run ${SAMPLE_TEST}`)}`);
  console.log(chalk.bold(`${'─'.repeat(50)}\n`));
}
