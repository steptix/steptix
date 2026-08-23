/**
 * The per-run log file gets the same masking as the console
 * (stories/secret-redaction.md): log lines as text, trace payloads as
 * objects before they are serialized — so a secret JSON would escape is
 * still found.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { openRunLogFile, attachRunLogBridges } from '../src/utils/run-log.js';
import { logger, setLogLevel, getLogLevel } from '../src/utils/logger.js';

async function withRunLog(
  mode: 'compact' | 'full',
  secrets: () => string[],
  body: () => void,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-runlog-secrets-'));
  const runLog = openRunLogFile('t', dir);
  if (!runLog) throw new Error('no run log');
  const detach = attachRunLogBridges(runLog, mode, secrets);
  const previous = getLogLevel();
  setLogLevel('silent');
  try {
    body();
  } finally {
    setLogLevel(previous);
    detach();
  }
  const closed = once(runLog.stream, 'finish');
  runLog.dispose();
  await closed;
  const text = await fs.readFile(runLog.path, 'utf-8');
  await fs.rm(dir, { recursive: true, force: true });
  return text;
}

describe('run log — secrets', () => {
  it('masks log lines by value, reading the list at each write', () => {
    const list: string[] = [];
    return withRunLog('compact', () => list, () => {
      logger.info('before capture: tok-1');
      list.push('tok-1');
      logger.info('after capture: tok-1');
    }).then((text) => {
      expect(text).toContain('before capture: tok-1');
      expect(text).toContain('after capture: ***');
    });
  });

  it('masks a trace payload before serializing it, so a value JSON would escape is still caught', async () => {
    const secret = 'hu"nter\\2';
    const text = await withRunLog('full', () => [secret], () => {
      logger.trace('ai:request', {
        messages: [{ role: 'user', content: `Enter the password ${secret}` }],
        image: 'data:image/png;base64,' + Buffer.from(secret).toString('base64'),
      });
    });
    expect(text).toContain('=== [');
    expect(text).toContain('Enter the password ***');
    expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
    // The image part is left alone — a data: URL is never masked.
    expect(text).toContain('data:image/png;base64,' + Buffer.from(secret).toString('base64'));
  });

  it('writes no trace blocks in compact mode, masked or otherwise', async () => {
    const text = await withRunLog('compact', () => ['s3cret'], () => {
      logger.trace('ai:request', { content: 's3cret' });
      logger.warn('warned about s3cret');
    });
    expect(text).not.toContain('=== [');
    expect(text).toContain('warned about ***');
  });
});
