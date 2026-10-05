import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

const START_MARKER = '<!-- latest-runs:start -->';
const END_MARKER = '<!-- latest-runs:end -->';
const MAX_ENTRIES = 10;

/**
 * Append (or update) a "Latest runs" section at the bottom of a test .md file,
 * linking to the generated HTML report. The section is delimited by HTML
 * comment markers so it can be safely rewritten on each run. Keeps the most
 * recent MAX_ENTRIES entries.
 */
export async function appendRunHistory(
  testFilePath: string,
  reportPath: string,
  status: string,
  date: string,
  model?: string,
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(testFilePath, 'utf-8');
  } catch (err) {
    logger.warn(`Could not read test file to append run history: ${String(err)}`);
    return;
  }

  const absReport = path.resolve(reportPath).split(path.sep).join('/');
  const reportUrl = absReport.startsWith('/') ? `file://${absReport}` : `file:///${absReport}`;

  const timestamp = formatTimestamp(date);
  const modelSuffix = model ? ` — ${model}` : '';
  const newEntry = `- [${timestamp} — ${status}${modelSuffix}](${reportUrl})`;

  const existingEntries = extractEntries(content);
  const entries = [newEntry, ...existingEntries].slice(0, MAX_ENTRIES);

  const section = [
    START_MARKER,
    '## Latest runs',
    '',
    ...entries,
    END_MARKER,
  ].join('\n');

  const stripped = stripExistingSection(content).replace(/\s+$/, '');
  const updated = `${stripped}\n\n${section}\n`;

  await writeAtomically(testFilePath, updated);
  logger.debug(`Appended run history to ${testFilePath}`);
}

/**
 * Replace `file` with `contents` so that a reader sees the old text or the new,
 * never a truncated file: write a temp file beside it, then rename over it
 * (same directory, so same filesystem, so the rename is atomic).
 *
 * The test file being rewritten is one other things read while a run is going
 * — the editor, the extension's providers, and unit suites that read the
 * acceptance tests under templates/ as their corpus. A plain `writeFile`
 * truncates first, and a read in that window sees an empty or partial test.
 *
 * The temp name starts with a dot and ends in `.tmp`, so nothing that lists
 * `*.md` test files picks it up in the moment it exists.
 *
 * Otherwise it behaves as writing the file in place would: a symlinked test
 * file is updated at its target and stays a link, a read-only one is refused
 * with the error a write would give (on Windows `W_OK` checks the read-only
 * attribute) rather than replaced, and the file keeps its mode.
 */
async function writeAtomically(file: string, contents: string): Promise<void> {
  const target = await fs.realpath(file);
  await fs.access(target, fs.constants.W_OK);
  const { mode } = await fs.stat(target);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, contents, 'utf-8');
    if (process.platform !== 'win32') await fs.chmod(temp, mode & 0o7777);
    await renameOver(temp, target);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** The codes Windows answers a rename with while another process — a reader,
 *  a virus scanner, the search indexer — has the target open. */
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** `fs.rename` over an existing file. Windows refuses to replace a file that
 *  another process has open, for as long as it has it open — usually a few
 *  milliseconds — so a refusal there is tried again for up to two seconds
 *  before it counts. Elsewhere a rename replaces an open file. */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !LOCKED.has(code) || attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function extractEntries(content: string): string[] {
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) return [];
  const inner = content.slice(start + START_MARKER.length, end);
  return inner
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ['));
}

function stripExistingSection(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) return content;
  return content.slice(0, start) + content.slice(end + END_MARKER.length);
}

function formatTimestamp(date: string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toISOString().replace('T', ' ').substring(0, 19) + 'Z';
}
