/**
 * `step.filePath` and the static backstop that keeps a path out of a committed
 * file — stories/upload-action.md §8.
 *
 * A compiled entry must never carry an absolute path: the file it names lives
 * beside the TEST, and the entry has to work on whatever machine replays it.
 * That is the whole reason paths go through `step.filePath` rather than
 * straight into `setInputFiles`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page, BrowserContext, Browser } from 'playwright';
import { runCodeBehindEntry } from '../src/codebehind/execute.js';
import type { CodeBehindContext } from '../src/codebehind/types.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { literalUploadPathComplaint, staticEntryComplaint } from '../src/codebehind/generate.js';
import type { RecordedAction } from '../src/codebehind/recording.js';

const BS = String.fromCharCode(92);
const noPage = {} as unknown as Page;
const noContext = {} as unknown as BrowserContext;
const noBrowser = {} as unknown as Browser;

let root: string;
let testDir: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-cb-upload-'));
  testDir = path.join(root, 'tests');
  await fs.mkdir(path.join(testDir, 'attachments'), { recursive: true });
  await fs.writeFile(path.join(root, 'steptix.config.json'), '{}');
  await fs.writeFile(path.join(testDir, 'attachments', 'logo.png'), 'png');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const binding = (): CodeBehindBinding =>
  ({
    file: path.join(testDir, 'demo.steps.ts'),
    source: 'Upload file attachments/logo.png',
    scope: { renames: {}, inputs: {} },
  }) as unknown as CodeBehindBinding;

/** Run `body` as the entry, with the upload context a real run would supply. */
function run(
  body: (ctx: CodeBehindContext) => unknown,
  params: Record<string, string> = {},
  uploadPaths: { baseDir?: string; projectRoot?: string | null } = {
    baseDir: testDir,
    projectRoot: root,
  },
): ReturnType<typeof runCodeBehindEntry> {
  const b = binding();
  return runCodeBehindEntry({
    binding: { ...b, entry: { source: b.source, run: body as never } },
    page: noPage,
    context: noContext,
    browser: noBrowser,
    resolvedParameters: params,
    uploadPaths,
    label: 'codebehind:test',
  });
}

describe('step.filePath', () => {
  it('resolves a step path against the test file folder', async () => {
    let seen: string | undefined;
    const outcome = await run(({ step }) => { seen = step.filePath('attachments/logo.png'); });

    expect(outcome.status, outcome.error).toBe('passed');
    expect(seen).toBe(path.join(testDir, 'attachments', 'logo.png'));
  });

  it('accepts the backslash spelling a parameter carries', async () => {
    // `step.filePath(step.getVar('statement'))` hands over the parameter's RAW
    // value, which the author may well have written with backslashes.
    let seen: string | undefined;
    const outcome = await run(
      ({ step }) => { seen = step.filePath(step.getVar('statement')!); },
      { statement: `${BS}attachments${BS}logo.png` },
    );

    expect(outcome.status, outcome.error).toBe('passed');
    expect(seen).toBe(path.join(testDir, 'attachments', 'logo.png'));
  });

  // The load-bearing case for the heal path: the entry is fine, the file is
  // missing. Healing would spend an AI turn and throw away working code.
  it('fails NON-RETRYABLY when the file is missing', async () => {
    const outcome = await run(({ step }) => { step.filePath('attachments/nope.png'); });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('Upload file not found');
    expect(outcome.nonRetryable).toBe(true);
    // Not an expectation failure — that is a different kind of red.
    expect(outcome.expectationFailed).toBe(false);
  });

  it('fails non-retryably outside the project fence', async () => {
    const outcome = await run(({ step }) => { step.filePath('../../../../outside.png'); });
    expect(outcome.error).toContain('outside the project folder');
    expect(outcome.nonRetryable).toBe(true);
  });

  it('says so when the run has no test file to resolve against', async () => {
    const outcome = await run(({ step }) => { step.filePath('attachments/logo.png'); }, {}, {});
    expect(outcome.error).toContain('no test file to resolve it against');
    expect(outcome.nonRetryable).toBe(true);
  });

  it('explains an undefined argument rather than building "undefined" into a path', async () => {
    // `step.getVar` answers undefined for a name this run has no value for.
    const outcome = await run(({ step }) => {
      step.filePath(step.getVar('missing-param') as unknown as string);
    });
    expect(outcome.error).toContain('step.filePath needs a path');
    expect(outcome.nonRetryable).toBe(true);
  });

  // Ordinary broken code must STILL heal — the guard above must not have made
  // every code-behind failure non-retryable.
  it('leaves an ordinary crash retryable', async () => {
    const outcome = await run(() => { throw new Error('genuinely broken'); });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('genuinely broken');
    expect(outcome.nonRetryable).toBeUndefined();
  });
});

describe('the static backstop against literal paths', () => {
  const uploadAction: RecordedAction[] = [
    { action: 'upload', selector: '#f', filePath: 'attachments/logo.png', description: 'd' },
  ];

  it('complains about a relative literal', () => {
    const code = "await page.locator('#f').setInputFiles('attachments/logo.png');";
    expect(literalUploadPathComplaint(code, uploadAction)).toContain('step.filePath');
  });

  it('complains about an absolute literal', () => {
    const code = `await page.locator('#f').setInputFiles('C:${BS}${BS}tests${BS}${BS}logo.png');`;
    expect(literalUploadPathComplaint(code, uploadAction)).toBeDefined();
  });

  it('complains about an array of literals', () => {
    const code = "await page.locator('#f').setInputFiles(['a.png', 'b.png']);";
    expect(literalUploadPathComplaint(code, uploadAction)).toBeDefined();
  });

  it('complains about a literal handed to a file chooser', () => {
    const code = "await (await chooser).setFiles('attachments/logo.png');";
    expect(literalUploadPathComplaint(code, uploadAction)).toBeDefined();
  });

  it('accepts a path routed through step.filePath', () => {
    const code = "await page.locator('#f').setInputFiles(step.filePath('attachments/logo.png'));";
    expect(literalUploadPathComplaint(code, uploadAction)).toBeUndefined();
  });

  it('accepts a parameterised path', () => {
    const code = "await page.locator('#f').setInputFiles(step.filePath(step.getVar('statement')));";
    expect(literalUploadPathComplaint(code, uploadAction)).toBeUndefined();
  });

  // The check is scoped to steps that actually uploaded, so an unrelated
  // entry that happens to call setInputFiles is not second-guessed.
  it('says nothing when the step recorded no upload', () => {
    const code = "await page.locator('#f').setInputFiles('a.png');";
    const clicked: RecordedAction[] = [{ action: 'click', selector: '#f', description: 'd' }];
    expect(literalUploadPathComplaint(code, clicked)).toBeUndefined();
  });

  // Selector ambiguity is checked first: it throws on replay, where a literal
  // path merely breaks on the next machine.
  it('reports the ambiguous selector first when an entry has both faults', () => {
    const both: RecordedAction[] = [
      {
        action: 'upload',
        selector: '.field',
        filePath: 'attachments/logo.png',
        description: 'd',
        targeting: { matchCount: 3 },
      },
    ];
    const code = "await page.locator('.field').setInputFiles('attachments/logo.png');";
    expect(staticEntryComplaint(code, both)).toContain('measured 3 elements');
  });
});
