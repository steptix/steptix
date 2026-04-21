import fs from 'node:fs/promises';
import path from 'node:path';
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

  await fs.writeFile(testFilePath, updated, 'utf-8');
  logger.debug(`Appended run history to ${testFilePath}`);
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
