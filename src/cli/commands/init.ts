import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import type { Command } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function registerInitCommand(program: Command): void {
  program
    .command('init [dir]')
    .description('Scaffold a new Steptix project in the target directory (default: current dir)')
    .option('--force', 'Overwrite existing files', false)
    .action(async (dir: string | undefined, opts: { force: boolean }) => {
      await initCommand(dir ?? '.', opts.force);
    });
}

/**
 * The `steptix.config.json` a new project starts with.
 *
 * Written from here rather than copied from `templates/init/steptix.config.json`,
 * because that file is not a starter config: `templates/init` is also the live
 * integration suite's fixture workspace, and its config carries what the
 * FIXTURES need — `desktop.enabled: true` for `pdf-dialog-cancel.md`,
 * `browser.launchArgs: ["--disable-print-preview"]` for the same test, and a
 * `tests.toolsDir` that climbs out to `../../fixtures/tools/src`. Copied, the
 * first switched computer mode on in every project `steptix init` ever created,
 * which is the opt-in SPEC-use-computer.md §5.1 item 1 exists to require: a
 * test file in a shared project must not be able to move the mouse on a
 * machine whose owner did not say so. The toolsDir pointed at a directory no
 * new project has.
 *
 * So the two files are kept apart on purpose. This one names only what a new
 * project has to decide — the model, the directories — and leaves everything
 * else, `desktop` included, at its default. Exported for the test that pins
 * that.
 */
export const SCAFFOLD_CONFIG = `{
  "ai": {
    "model": "openai/gpt-5.6-luna"
  },
  "browser": {
    "headed": true
  },
  "tests": {
    "dir": "./tests",
    "dataDir": "./data",
    "contextDir": "./context",
    "skillsDir": "./skills",
    "toolsDir": "./tools/src"
  },
  "reports": {
    "outputDir": "./reports"
  }
}
`;

export async function initCommand(targetDir: string, force: boolean): Promise<void> {
  const absTarget = path.resolve(targetDir);

  console.log(chalk.bold(`\nInitialising Steptix project in: ${chalk.cyan(absTarget)}\n`));

  // Resolve templates directory relative to this module
  // In source: src/cli/commands/ -> ../../.. -> project root -> templates/init
  // In dist:   dist/cli/commands/ -> ../../.. -> project root -> templates/init
  const templatesDir = path.join(__dirname, '../../../templates/init');

  // Ensure target directory exists
  await fs.mkdir(absTarget, { recursive: true });

  // Create standard project directories
  const dirs = ['tests', 'context', 'reports'];
  for (const dir of dirs) {
    const dirPath = path.join(absTarget, dir);
    await fs.mkdir(dirPath, { recursive: true });
    console.log(chalk.green('  ✓') + ` Created ${dir}/`);
  }

  // Copy template files. `steptix.config.json` is not among them: it is written
  // from SCAFFOLD_CONFIG, never from the fixture workspace's own config.
  const templateFiles: Array<{ src: string | null; dest: string }> = [
    { src: null, dest: 'steptix.config.json' },
    { src: 'tests/example.md', dest: 'tests/example.md' },
    { src: 'tests/sections-demo.md', dest: 'tests/sections-demo.md' },
    { src: 'context/app.md', dest: 'context/app.md' },
  ];

  for (const { src, dest } of templateFiles) {
    const destPath = path.join(absTarget, dest);

    // Check if destination exists
    if (!force) {
      try {
        await fs.access(destPath);
        console.log(chalk.yellow('  ⚠') + ` Skipping ${dest} (already exists — use --force to overwrite)`);
        continue;
      } catch {
        // File does not exist — proceed
      }
    }

    if (src === null) {
      await writeDefaultTemplate(dest, destPath);
      continue;
    }

    try {
      const content = await fs.readFile(path.join(templatesDir, src), 'utf-8');
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, content, 'utf-8');
      console.log(chalk.green('  ✓') + ` Created ${dest}`);
    } catch (err) {
      // Templates not found (e.g. running from source before build) — write inline defaults
      await writeDefaultTemplate(dest, destPath);
    }
  }

  console.log(chalk.bold(`\n${'─'.repeat(50)}`));
  console.log(chalk.bold('  Next steps:'));
  console.log('');
  console.log(`  1. Edit ${chalk.cyan('steptix.config.json')} — set your base URL and AI gateway`);
  console.log(`  2. Edit ${chalk.cyan('tests/example.md')}   — write your first test`);
  console.log(`  3. Edit ${chalk.cyan('context/app.md')}     — describe your application`);
  console.log(`  4. Run   ${chalk.cyan('steptix run')}     — execute the tests`);
  console.log(chalk.bold(`${'─'.repeat(50)}\n`));
}

async function writeDefaultTemplate(templateName: string, destPath: string): Promise<void> {
  const defaults: Record<string, string> = {
    'steptix.config.json': SCAFFOLD_CONFIG,
    'tests/example.md': `---
tags: [smoke]
---

# Example Login Test

## Config
- baseUrl: http://localhost:3000

## Parameters
- email: user@example.com
- password: $TEST_PASSWORD

## Steps
1. Navigate to the login page
2. Enter "{{email}}" in the email field
3. Enter "{{password}}" in the password field
4. Click the Sign In button
5. Assert that the dashboard is visible
`,
    'context/app.md': `# Application Context

This is a web application with the following structure:

## Pages
- **Login** (\`/\`): Email and password login form
- **Dashboard** (\`/dashboard\`): Main overview with key metrics
- **Transactions** (\`/transactions\`): Transaction history table

## Authentication
- Login form at root URL
- Session persists via cookie
- Logout button in the top navigation

## Notes
- Cookie consent banner appears on first visit
`,
  };

  const content = defaults[templateName] ?? `# ${templateName}\n`;
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, content, 'utf-8');
  console.log(chalk.green('  ✓') + ` Created ${templateName}`);
}
