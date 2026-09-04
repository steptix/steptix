import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseTestFile, parseTestContent } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';

/**
 * A table under a `### Section` loops that section's body, in the same
 * session, once per row (stories/data-driven-rows.md, part B).
 *
 * Everything goes through `parseTestFile` rather than a hand-built
 * `SectionDefs`, per the contract's §2.3 lesson: hand-built inputs skip the
 * transforms that cause the bugs.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'row-sections-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function parse(md: string) {
  const file = path.join(tmpDir, 'test.md');
  await fs.writeFile(file, md);
  return parseTestFile(file, { skillsDir: path.join(tmpDir, 'skills') });
}

const UPLOAD = `# Upload

## Steps
1. Open the documents page
2. Upload each statement
3. Count the rows

### Upload each statement
| file        | status            |
|-------------|-------------------|
| logo.png    | Uploaded logo     |
| receipt.png | Uploaded receipt  |
1. Upload file {{file}}
2. Assert the status says "{{status}}"
`;

describe('rows under a ### Section', () => {
  it('lands on the section, not on the run', () => {
    // The two loops are told apart by which heading the table sits under.
    const parsed = parseTestContent(UPLOAD);
    expect(parsed.dataRows).toBeUndefined();
    const section = parsed.sections['upload each statement'];
    expect(section?.rows).toEqual([
      { file: 'logo.png', status: 'Uploaded logo' },
      { file: 'receipt.png', status: 'Uploaded receipt' },
    ]);
    // The body's own steps are still found, past the table.
    expect(section?.steps).toEqual([
      'Upload file {{file}}',
      'Assert the status says "{{status}}"',
    ]);
  });

  it('expands the body once per row, with the row interpolated', async () => {
    const parsed = await parse(UPLOAD);
    expect(parsed.steps).toEqual([
      'Open the documents page',
      'Upload file logo.png',
      'Assert the status says "Uploaded logo"',
      'Upload file receipt.png',
      'Assert the status says "Uploaded receipt"',
      'Count the rows',
    ]);
  });

  it('gives each iteration its own frame, carrying the row', async () => {
    const parsed = await parse(UPLOAD);
    const frames = Object.values(parsed.expansion!.frames).filter(
      (f) => f.kind === 'section',
    );
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => [f.iteration, f.iterationCount])).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(frames[0]!.inputs).toEqual({ file: 'logo.png', status: 'Uploaded logo' });
    // Each iteration is a distinct frame — the Variables view and the report
    // both key off that.
    expect(frames[0]!.id).not.toBe(frames[1]!.id);
  });

  it('keeps the authored text as the match side', async () => {
    // The wire carries no `rawSteps`, so if the interpolated text became the
    // match side the code-behind binding `source` would differ between the
    // CLI and the server, binding entries on one path and not the other.
    const parsed = await parse(UPLOAD);
    expect(parsed.expansion!.rawSteps).toEqual([
      'Open the documents page',
      'Upload file {{file}}',
      'Assert the status says "{{status}}"',
      'Upload file {{file}}',
      'Assert the status says "{{status}}"',
      'Count the rows',
    ]);
  });

  it('attributes every iteration to the same section', async () => {
    const parsed = await parse(UPLOAD);
    expect(parsed.sourceSections).toEqual([
      null,
      'Upload each statement',
      'Upload each statement',
      'Upload each statement',
      'Upload each statement',
      null,
    ]);
  });

  it('leaves a section without a table expanding exactly as before', async () => {
    const parsed = await parse(`# T

## Steps
1. Sign in
2. Sign in

### Sign in
1. Enter the email
`);
    expect(parsed.steps).toEqual(['Enter the email', 'Enter the email']);
    const frames = Object.values(parsed.expansion!.frames);
    expect(frames.every((f) => f.iteration === undefined)).toBe(true);
  });

  it('multiplies nested loops, and an inner body reads the outer row', async () => {
    const parsed = await parse(`# T

## Steps
1. Per account

### Per account
| account |
|---------|
| Everyday |
| Savings  |
1. Select {{account}}
2. Per month

### Per month
| month |
|-------|
| Jan   |
| Feb   |
1. Check {{account}} in {{month}}
`);
    expect(parsed.steps).toEqual([
      'Select Everyday',
      'Check Everyday in Jan',
      'Check Everyday in Feb',
      'Select Savings',
      'Check Savings in Jan',
      'Check Savings in Feb',
    ]);
  });

  it('substitutes a column into a skill call before the call is parsed', async () => {
    await fs.mkdir(path.join(tmpDir, 'skills'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'skills', 'enter_email.md'),
      '---\ntype: skill\n---\n\n# enter_email\n\n## Parameters\n- email: the address\n\n## Steps\n1. Enter "{{email}}"\n',
    );
    const parsed = await parse(`# T

## Steps
1. Try each spelling

### Try each spelling
| email |
|-------|
| a@b.c |
| A@B.C |
1. [skill: enter_email email="{{email}}"]
`);
    expect(parsed.steps).toEqual(['Enter "a@b.c"', 'Enter "A@B.C"']);
  });

  it('refuses a table under a section that follows its first step', async () => {
    await expect(
      parse('# T\n\n## Steps\n1. Go\n\n### S\n1. First\n\n| a |\n|---|\n| 1 |\n'),
    ).rejects.toThrow(/comes after a step/);
  });

  it('accepts a table under a skill-internal section', async () => {
    // A skill's own `## Steps` refuses a table — a skill is called with args,
    // not looped — but a section inside it is a flow like any other.
    await fs.mkdir(path.join(tmpDir, 'skills'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'skills', 'looper.md'),
      [
        '---',
        'type: skill',
        '---',
        '',
        '# looper',
        '',
        '## Steps',
        '1. Each thing',
        '',
        '### Each thing',
        '| thing |',
        '|-------|',
        '| one   |',
        '| two   |',
        '1. Handle {{thing}}',
        '',
      ].join('\n'),
    );
    const parsed = await parse('# T\n\n## Steps\n1. [skill: looper]\n');
    expect(parsed.steps).toEqual(['Handle one', 'Handle two']);
  });
});
