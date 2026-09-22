import fs from 'node:fs';
import { defineTool } from 'ai-ui-automation/tools';

/**
 * Assert that a file exists on the machine running the SERVER, and capture its
 * size.
 *
 * Written for the computer-mode fixtures (docs/specs/SPEC-use-computer.md §7):
 * `templates/init/tests/pdf-save-as.md` drives a native Save As dialog with a
 * real mouse and keyboard, and the only evidence that the dialog actually
 * saved anything is a file on disk. Nothing in the browser vocabulary can look
 * at one — the page never sees the file system — so this is a tool.
 *
 * Deliberately server-side, and deliberately not clever:
 *
 *   - It uses `page`/`context` for nothing. A computer-mode test may have no
 *     browser at all (a test whose first step is `[use computer]` never
 *     launches one, §4.6), and a tool that touched `page` would fail on those
 *     for a reason that has nothing to do with the file.
 *   - It fails through `step.expect`, so a missing file is THIS step's failure
 *     with the path in the message, rather than a later step mysteriously
 *     reading nothing. `regex_extract` fails the same way and for the same
 *     reason.
 *   - A directory is a failure, not a pass. `existsSync` says yes to one, and
 *     "the Save As dialog wrote a folder where a file should be" is exactly
 *     the kind of near-miss this is here to catch.
 *
 * Usage:
 *
 *   1. [tool: assert_file_exists path="{{save_dir}}\aiui-statement.pdf"]
 *   2. Verify that {{file_size}} is more than 0
 *
 * The `path` argument is a literal path on the server's file system, usually
 * built from a `## Parameters` value so the test names no machine-specific
 * directory of its own.
 */
export default defineTool({
  name: 'assert_file_exists',
  description:
    'Assert that a file exists on the machine running the server, and capture its size in bytes. Fails the step when the path is missing or is not a regular file.',
  parameters: {
    path: {
      type: 'string',
      description:
        'Absolute path to the file that must exist, e.g. "C:\\Users\\me\\AppData\\Local\\Temp\\aiui-statement.pdf".',
    },
  },
  outputs: {
    file_size: { type: 'number', description: 'Size of the file in bytes.' },
  },
  run({ path: filePath }, { step, log }) {
    let stats: fs.Stats | null = null;
    try {
      stats = fs.statSync(filePath);
    } catch {
      stats = null;
    }

    if (stats === null) {
      step.expect(false, `assert_file_exists: no such file — ${filePath}`);
      return; // unreachable: step.expect threw.
    }
    if (!stats.isFile()) {
      step.expect(
        false,
        `assert_file_exists: ${filePath} exists but is not a regular file (it is a ${
          stats.isDirectory() ? 'directory' : 'special file'
        })`,
      );
      return; // unreachable
    }

    log.info(`assert_file_exists: ${filePath} — ${stats.size} byte(s)`);
    step.setVar('file_size', stats.size);
  },
});
