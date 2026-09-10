import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseTestFile, parseTestContent } from '../src/parser/markdown.js';
import { clearSkillCache, expandSkills } from '../src/skills/expander.js';
// The CLIENT's producers — nothing else in the repo can answer "what does
// TestBench actually put on the wire".
//
// From `src/`, not `dist/`. Nothing in the root's `npm run build` compiles
// runner-core (only testbench-native's `build:runner-core` and runner-core's
// own `prepare` do), so a guard reading `dist/` asserts against whatever bytes
// were last built there — which can be older than the source the extension is
// about to bundle. A regression in step-lines.ts would then ship green.
// Vitest transpiles the TypeScript, and runner-core's sources need no
// build-time transform (plain relative imports, no path aliases).
import { extractSections, extractSteps } from '../runner-core/src/step-lines.ts';
import { parseSectionDataRows } from '../runner-core/src/data-rows.ts';
import { matchText } from '../runner-core/src/section-match.ts';

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

/**
 * The same loop, written in the two shapes where the CLI parser's `steps` and
 * its `rawSteps` are different strings — the only shapes that can tell a
 * producer reading the wrong one apart from a producer reading the right one.
 *
 * The body list is LOOSE (a blank line between its items), because
 * `extractPlainText` only strips inline markdown there: in a tight list
 * `item.tokens[0]` is a text token and the function short-circuits on its raw
 * source, so `**Save**` survives and the test would pass either way
 * (contract §2.3, "the tight-list trap"). `[no-hooks]` needs no such care —
 * the parser strips it from `steps` at any looseness.
 */
const RICH = `# Rich

## Steps
1. Open the documents page
2. Upload each file
3. Count the rows

### Upload each file
| file  |
|-------|
| a.png |
| b.png |

1. Click **Save** for {{file}}

2. [no-hooks] Type \`hello\`
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

  it('keeps the authored text as the match side on the WIRE shape too', async () => {
    // The half the test above cannot reach, and the half that was wrong. A
    // client sends `sections` with no `rawSteps` (contract §3.2), so the
    // expander's fallback is `steps[i]` — and `steps` is the very array the row
    // is interpolated INTO. Left to the fallback, the same three-row body bound
    // three entries on the server (`Upload file logo.png`, …) and one on the
    // CLI, so a compile proposed one entry per row and none of them matched a
    // later run whose rows had changed.
    const wireSections = {
      'upload each statement': {
        name: 'Upload each statement',
        headingLine: 8,
        // Exactly what `extractSections` ships: the raw body line, list marker
        // stripped and trimmed — which is what the CLI parser puts in
        // `ParsedSection.rawSteps`.
        steps: ['Upload file {{file}}', 'Assert the status says "{{status}}"'],
        stepLines: [13, 14],
        rows: [
          { file: 'logo.png', status: 'Uploaded logo' },
          { file: 'receipt.png', status: 'Uploaded receipt' },
        ],
      },
    };
    const expanded = await expandSkills(
      ['Open the documents page', 'Upload each statement', 'Count the rows'],
      undefined,
      undefined,
      '/t/upload.md',
      [4, 5, 6],
      { sections: wireSections, warnDeadSections: false },
    );
    // What the runner executes: the row, baked into the body's text.
    expect(expanded.steps).toEqual([
      'Open the documents page',
      'Upload file logo.png',
      'Assert the status says "Uploaded logo"',
      'Upload file receipt.png',
      'Assert the status says "Uploaded receipt"',
      'Count the rows',
    ]);
    // What an entry binds to: byte-identical to the CLI parser's answer in the
    // test above, which is the whole point of the parity.
    expect(expanded.rawSteps).toEqual([
      'Open the documents page',
      'Upload file {{file}}',
      'Assert the status says "{{status}}"',
      'Upload file {{file}}',
      'Assert the status says "{{status}}"',
      'Count the rows',
    ]);
  });

  /**
   * The parity the test above hand-asserts, measured against the real
   * producer instead of a literal.
   *
   * The hand-built `wireSections` above is only as honest as whoever typed it,
   * and the shapes where the two sides diverge are exactly the ones nobody
   * types into a fixture by accident: a `[no-hooks]` marker (which the CLI's
   * `steps` strips and its `rawSteps` keeps) and inline markdown in a LOOSE
   * list (which `extractPlainText` strips, and only there — contract §2.3).
   *
   * So this builds the wire section the way the client really does — from
   * runner-core's `extractSections` + `parseSectionDataRows`, the two calls
   * `buildSectionsPayload` makes — parses the same markdown with the CLI
   * parser, expands both, and requires the match sides to be the same bytes.
   * That is the invariant the code-behind binding rides on: `entryKeyOf` is
   * (file, section, authored text, occurrence), so a producer one character
   * out binds entries nothing else can find.
   */
  it('ships the same match side as the CLI parser, for the shapes that diverge', async () => {
    const file = path.join(tmpDir, 'rich.md');
    await fs.writeFile(file, RICH);

    // The CLI's answer.
    const parsed = await parseTestFile(file, { skillsDir: path.join(tmpDir, 'skills') });

    // The client's. `extractSections` returns `{line, instruction}` pairs and
    // no rows — `buildSectionsPayload` splits them into the two parallel
    // arrays and asks `parseSectionDataRows` for the table, which is what is
    // replicated here rather than imported: the extension's copy lives in the
    // VS Code package and importing it would drag the whole extension in.
    const rowsByName = parseSectionDataRows(RICH);
    const wireSections = Object.create(null) as Record<string, unknown>;
    for (const section of extractSections(RICH)) {
      const rows = rowsByName.get(section.name);
      wireSections[matchText(section.name)] = {
        name: section.name,
        headingLine: section.headingLine,
        steps: section.steps.map((s) => s.instruction),
        stepLines: section.steps.map((s) => s.line),
        ...(rows !== undefined && { rows }),
      };
    }
    // The body line as authored, marker and asterisks intact — this is the
    // assertion that fails first if a producer starts sending a marked
    // reading.
    expect((wireSections['upload each file'] as { steps: string[] }).steps).toEqual(
      parsed.sections['upload each file']!.rawSteps,
    );

    const mainSteps = extractSteps(RICH);
    const expanded = await expandSkills(
      mainSteps.map((s) => s.instruction),
      undefined,
      undefined,
      file,
      mainSteps.map((s) => s.line),
      { sections: wireSections as never, warnDeadSections: false },
    );

    expect(expanded.rawSteps).toEqual(parsed.expansion!.rawSteps);
    // Said again as a literal, so a change that moved BOTH sides together
    // still has to be looked at: the marker is kept on the match side and
    // stripped from what runs, and the bold survives on both.
    expect(expanded.rawSteps).toEqual([
      'Open the documents page',
      'Click **Save** for {{file}}',
      '[no-hooks] Type `hello`',
      'Click **Save** for {{file}}',
      '[no-hooks] Type `hello`',
      'Count the rows',
    ]);

    // What the two paths EXECUTE is not the same string, and deliberately not
    // asserted equal: the wire carries one string per step and the contract
    // says it is the raw one, so a loose-list body step reaches the model with
    // its markdown syntax intact where the CLI's `extractPlainText` had
    // removed it. Measured, so the difference is on the record rather than
    // discovered again; it is the same divergence as the MAIN flow's, tracked
    // as issues/053. The `[no-hooks]` marker is NOT part of it — the expander
    // strips that as it inlines the body, which is why only the backticks and
    // asterisks survive here.
    expect(expanded.steps).toEqual([
      'Open the documents page',
      'Click **Save** for a.png',
      'Type `hello`',
      'Click **Save** for b.png',
      'Type `hello`',
      'Count the rows',
    ]);
    expect(parsed.steps).toEqual([
      'Open the documents page',
      'Click Save for a.png',
      'Type hello',
      'Click Save for b.png',
      'Type hello',
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
