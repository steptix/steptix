import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseTestContent, parseTestFile, parseSkillFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { parseControlLine } from '../src/parser/control-line.js';
import { logger } from '../src/utils/logger.js';

/**
 * Parse-time validation of control flow (stories/control-flow.md §Parser).
 *
 * Two rules with two different reaches, and the split matters:
 *
 *  - `controlLineError` runs over every step line of every flow — main flow
 *    and every section body, of tests AND skills — because a claim that does
 *    not complete has to be an error wherever it is written.
 *  - the STRUCTURE rules (a chain is consecutive lines of ONE flow, one
 *    `Otherwise` and it comes last, what a tail may be) are checked per flow,
 *    which is what makes a chain running off the end of `## Steps` into a
 *    `### Section` a refusal rather than a chain nobody can see.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-parse-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content);
  return p;
}

const doc = (...lines: string[]): string => ['# T', '', '## Steps', '', ...lines].join('\n');

describe('a claim that does not complete is refused, wherever it is written', () => {
  it('in the main flow, with the file and line', () => {
    expect(() => parseTestContent(doc('1. Otherwise'), 'tests/t.md')).toThrow(
      /Cannot parse the step "Otherwise" in tests\/t\.md at line 5/,
    );
  });

  it('in a section body', () => {
    expect(() =>
      parseTestContent(
        doc('1. Login', '', '### Login', '', '1. Click Sign in', '2. While the spinner shows'),
        'tests/t.md',
      ),
    ).toThrow(/separates its condition from the step it repeats with a comma/);
  });

  it('in a skill body', async () => {
    const file = await write('s.md', ['# s', '', '## Steps', '', '1. For each {{a}}, Check it'].join('\n'));
    await expect(parseSkillFile(file)).rejects.toThrow(/The list is missing/);
  });

  it('and a well-formed line passes', () => {
    const parsed = parseTestContent(
      doc('1. If the box is ticked, then Pay with cash', '', '### Pay with cash', '', '1. Click Pay now'),
      'tests/t.md',
    );
    expect(parsed.steps).toEqual(['If the box is ticked, then Pay with cash']);
  });
});

describe('chain structure', () => {
  it('an Otherwise with nothing above it', () => {
    expect(() => parseTestContent(doc('1. Sign in', '2. Otherwise, Pay by card'), 'tests/t.md')).toThrow(
      /has no decision to be the alternative of/,
    );
  });

  it('an Otherwise as the very first step', () => {
    expect(() => parseTestContent(doc('1. Otherwise, Pay by card'), 'tests/t.md')).toThrow(
      /has no decision to be the alternative of/,
    );
  });

  it('two Otherwises', () => {
    expect(() =>
      parseTestContent(
        doc('1. If a, then X', '2. Otherwise, Y', '3. Otherwise, Z'),
        'tests/t.md',
      ),
    ).toThrow(/follows an `Otherwise`, which ends a chain/);
  });

  it('an Else if after an Otherwise', () => {
    expect(() =>
      parseTestContent(
        doc('1. If a, then X', '2. Otherwise, Y', '3. Else if b, then Z'),
        'tests/t.md',
      ),
    ).toThrow(/follows an `Otherwise`, which ends a chain/);
  });

  it('an ordinary step between the members breaks the chain', () => {
    expect(() =>
      parseTestContent(
        doc('1. If a, then X', '2. Click Save', '3. Otherwise, Y'),
        'tests/t.md',
      ),
    ).toThrow(/has no decision to be the alternative of/);
  });

  it('a chain may not run across a section boundary', () => {
    expect(() =>
      parseTestContent(
        doc('1. If a, then X', '', '### Helper', '', '1. Otherwise, Y'),
        'tests/t.md',
      ),
    ).toThrow(/same flow \(### Helper\)/);
  });

  it('a chain INSIDE a section body is fine', () => {
    const parsed = parseTestContent(
      doc(
        '1. Helper',
        '',
        '### Helper',
        '',
        '1. If a, then Click A',
        '2. Else if b, then Click B',
        '3. Otherwise, Click C',
      ),
      'tests/t.md',
    );
    expect(parsed.sections['helper']?.steps).toHaveLength(3);
  });

  it('two independent chains in one flow', () => {
    const parsed = parseTestContent(
      doc('1. If a, then X', '2. Otherwise, Y', '3. Click Save', '4. If b, then Z', '5. Otherwise, W'),
      'tests/t.md',
    );
    expect(parsed.steps).toHaveLength(5);
  });

  it('blank lines and prose between members do not break the chain', () => {
    const parsed = parseTestContent(
      [
        '# T',
        '',
        '## Steps',
        '',
        '1. If a, then X',
        '',
        'Some prose about the decision.',
        '',
        '2. Otherwise, Y',
      ].join('\n'),
      'tests/t.md',
    );
    expect(parsed.steps).toHaveLength(2);
  });
});

describe('what a tail may not be', () => {
  it('another control line', () => {
    expect(() =>
      parseTestContent(doc('1. If a, then If b, then X'), 'tests/t.md'),
    ).toThrow(/names another control line as the step to run/);
  });

  it('a loop as the tail of a loop', () => {
    expect(() =>
      parseTestContent(doc('1. While a, While b, X'), 'tests/t.md'),
    ).toThrow(/names another control line as the step to run/);
  });

  it('an [input:] step', () => {
    expect(() =>
      parseTestContent(doc('1. If a, then [input: pin] Enter your PIN'), 'tests/t.md'),
    ).toThrow(/names `\[input: …\]` as the step to run/);
  });

  it('an [interactive] step', () => {
    expect(() =>
      parseTestContent(doc('1. While a, [interactive]'), 'tests/t.md'),
    ).toThrow(/names `\[interactive\]` as the step to run/);
  });

  it('but a [skill:] / [tool:] / Set tail is fine', () => {
    const parsed = parseTestContent(
      doc(
        '1. If a, then [skill: login]',
        '2. Else if b, then [tool: fetch_orders]',
        '3. Otherwise, Set {{plan}} to "free"',
      ),
      'tests/t.md',
    );
    expect(parsed.steps).toHaveLength(3);
  });
});

describe('the bare-name section match resolves first (decision 3)', () => {
  const md = doc(
    '1. While waiting',
    '',
    '### While waiting',
    '',
    '1. Verify the spinner is gone',
  );

  it('a step equal to a section name is a call, not a broken While', () => {
    // `While waiting` claims the `While` form and has no comma, so judged as a
    // control line it would be a parse error. It is a section call.
    const parsed = parseTestContent(md, 'tests/t.md');
    expect(parsed.rawSteps[0]).toBe('While waiting');
  });

  it('and running it expands the section rather than a loop', async () => {
    const file = await write('t.md', md);
    const parsed = await parseTestFile(file);
    expect(parsed.steps).toEqual(['Verify the spinner is gone']);
    expect(parsed.expansion?.controls).toEqual([null]);
  });

  it('a tail that names such a section is a call too', async () => {
    const file = await write(
      't2.md',
      doc('1. If a, then While waiting', '', '### While waiting', '', '1. Verify the spinner is gone'),
    );
    const parsed = await parseTestFile(file);
    expect(parsed.steps).toEqual(['If a, then While waiting', 'Verify the spinner is gone']);
  });
});

describe('the two bake-over refusals', () => {
  it('For each over a declared skill parameter', async () => {
    const file = await write(
      'sk.md',
      [
        '---',
        'type: skill',
        '---',
        '# sk',
        '',
        '## Parameters',
        '',
        '- account: demo',
        '',
        '## Steps',
        '',
        '1. For each {{account}} in {{accounts}}, Check the account',
      ].join('\n'),
    );
    await expect(parseSkillFile(file)).rejects.toThrow(
      /Cannot loop over \{\{account\}\}.*parameter of this skill/s,
    );
  });

  it('…including one written in a skill-internal section body', async () => {
    const file = await write(
      'sk2.md',
      [
        '---',
        'type: skill',
        '---',
        '# sk2',
        '',
        '## Parameters',
        '',
        '- account: demo',
        '',
        '## Steps',
        '',
        '1. Helper',
        '',
        '### Helper',
        '',
        '1. For each {{account}} in {{accounts}}, Check the account',
      ].join('\n'),
    );
    await expect(parseSkillFile(file)).rejects.toThrow(/Cannot loop over \{\{account\}\}/);
  });

  it('but the LIST name is not refused — passing a placeholder through is legitimate', async () => {
    const file = await write(
      'sk3.md',
      [
        '---',
        'type: skill',
        '---',
        '# sk3',
        '',
        '## Parameters',
        '',
        '- accounts: "{{found}}"',
        '',
        '## Steps',
        '',
        '1. For each {{account}} in {{accounts}}, Check the account',
      ].join('\n'),
    );
    await expect(parseSkillFile(file)).resolves.toBeTruthy();
  });

  it('For each over a column of the table the enclosing section loops over', () => {
    expect(() =>
      parseTestContent(
        doc(
          '1. Check them',
          '',
          '### Check them',
          '',
          '| account |',
          '| --- |',
          '| Savings |',
          '',
          '1. For each {{account}} in {{accounts}}, Check the account',
        ),
        'tests/t.md',
      ),
    ).toThrow(/Cannot loop over \{\{account\}\}.*column of the table/s);
  });

  it('For each over a row column as the LIST, too', () => {
    // The item side leaves a line that claims the form and fails it; the list
    // side leaves `For each {{account}} in Savings, …`, which claims nothing
    // and runs as one prose step with the record still naming `accounts`.
    // A row value is a literal, which is the whole difference from the skill
    // parameter above.
    expect(() =>
      parseTestContent(
        doc(
          '1. Check them',
          '',
          '### Check them',
          '',
          '| accounts |',
          '| --- |',
          '| Savings |',
          '',
          '1. For each {{account}} in {{accounts}}, Check the account',
        ),
        'tests/t.md',
      ),
    ).toThrow(/Cannot loop over the items of \{\{accounts\}\}.*column of the table/s);
  });

  it('…and a list that is NOT a column of that table is fine', () => {
    expect(() =>
      parseTestContent(
        doc(
          '1. Check them',
          '',
          '### Check them',
          '',
          '| owner |',
          '| --- |',
          '| Ada |',
          '',
          '1. For each {{account}} in {{accounts}}, Check the account',
        ),
        'tests/t.md',
      ),
    ).not.toThrow();
  });

  it('…and the Set version of the same refusal still fires', () => {
    expect(() =>
      parseTestContent(
        doc(
          '1. Check them',
          '',
          '### Check them',
          '',
          '| account |',
          '| --- |',
          '| Savings |',
          '',
          '1. Set {{account}} to "x"',
        ),
        'tests/t.md',
      ),
    ).toThrow(/Cannot assign to \{\{account\}\}/);
  });
});

describe('hooks are outside the feature', () => {
  it('a control line in a hook stays one prose step', async () => {
    const file = await write(
      'h.md',
      [
        '# T',
        '',
        '## Hooks',
        '',
        '- before: If a cookie banner appears, then Dismiss it',
        '',
        '## Steps',
        '',
        '1. Click Login',
      ].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.hooks.before).toEqual(['If a cookie banner appears, then Dismiss it']);
  });
});

describe('what parseTestFile hands the runner', () => {
  it('populates expansion.controls alongside the flat step list', async () => {
    const file = await write(
      'c.md',
      doc(
        '1. If cash, then Pay with cash',
        '2. Otherwise, Click Pay by card',
        '',
        '### Pay with cash',
        '',
        '1. Click Pay now',
      ),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.steps).toEqual([
      'If cash, then Pay with cash',
      'Click Pay now',
      'Otherwise, Click Pay by card',
      'Click Pay by card',
    ]);
    expect(parsed.expansion?.controls?.map((c) => c?.kind ?? null)).toEqual([
      'if',
      null,
      'else',
      null,
    ]);
    // Line attribution is unchanged by the feature: a tail step points at the
    // guard's line in the test file, the way a section body points at its call.
    expect(parsed.stepLines).toEqual([5, 5, 6, 6]);
  });

  it('[no-hooks] on a guard covers its whole tail, via origin mapping', async () => {
    const file = await write(
      'nh.md',
      doc(
        '1. [no-hooks] If cash, then Pay with cash',
        '2. Click Done',
        '',
        '### Pay with cash',
        '',
        '1. Click Pay now',
        '2. Verify the receipt',
      ),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.steps).toHaveLength(4);
    expect(parsed.skipHooks).toEqual([true, true, true, false]);
  });

  it('a guard is never a tool call, however its tail is written', async () => {
    const file = await write('tc.md', doc('1. If cash, then [tool: pay_now]'));
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.toolCalls[0]).toBeNull();
    expect(parsed.toolCalls[1]).toMatchObject({ name: 'pay_now' });
  });
});

/**
 * Every control-flow example in the two authoring documents actually parses.
 *
 * The story promises this guard, and the reason is specific: `docs/` is what an
 * AI agent is handed when it is asked to write a test, and a fence that the
 * parser refuses teaches it a form that does not exist. The class of bug is
 * real and cheap to make — a `While` example missing its comma reads fine to a
 * human and is a parse error to everything else.
 *
 * PR #134's general fence guard (`tests/docs-handbook-examples.test.ts`) is not
 * on this branch, so this checks the fences this feature added rather than
 * every fence in the file. A fence without an H1 gets one, exactly as the
 * documents' own readers supply the surrounding file.
 */
describe('the control-flow examples in docs/ parse', () => {
  const DOCS = ['docs/test-writing-handbook.md', 'docs/ai-test-authoring-guide.md'];
  /** A fenced markdown block that holds at least one numbered control line. */
  const CONTROL_LINE_RE = /(^|\n)\s*\d+\.\s*(?:\[no-hooks\]\s*)?(if|else|otherwise|while|repeat|for each)\b/i;

  async function controlFences(): Promise<{ doc: string; index: number; body: string }[]> {
    const out: { doc: string; index: number; body: string }[] = [];
    for (const rel of DOCS) {
      const text = await fs.readFile(path.join(process.cwd(), rel), 'utf8');
      let index = 0;
      for (const match of text.matchAll(/```markdown\n([\s\S]*?)```/g)) {
        index++;
        const body = match[1]!;
        // Only whole-test fences: a fragment showing one line in isolation has
        // no `## Steps` and is not a document anything would parse.
        if (!/##\s*Steps/.test(body)) continue;
        if (!CONTROL_LINE_RE.test(body)) continue;
        out.push({ doc: rel, index, body });
      }
    }
    return out;
  }

  it('finds the fences it is meant to be checking', async () => {
    const fences = await controlFences();
    // Guards against the regex quietly matching nothing after a docs rewrite,
    // which would leave this suite passing while checking no examples at all.
    expect(fences.length).toBeGreaterThanOrEqual(5);
    expect(new Set(fences.map((f) => f.doc)).size).toBe(DOCS.length);
  });

  it('and every one of them parses', async () => {
    for (const fence of await controlFences()) {
      // An H1 only when the fence omits one: the guide's examples start at
      // `## Steps`, and a missing title is a WARN rather than an error, so
      // without this the suite would pass while logging noise.
      const md = /^\s*#\s/m.test(fence.body) ? fence.body : `# Example\n\n${fence.body}`;
      const where = `${fence.doc} fence ${fence.index}`;
      expect(() => parseTestContent(md, where), where).not.toThrow();
    }
  });

  it('and between them they demonstrate all six forms', async () => {
    // Not every matched fence holds a control line — the watch examples open
    // `If …` with no `then`, and staying prose is the point of them. What the
    // documents must do BETWEEN them is show each of the six forms as the
    // parser really reads it: an example the parser reads as prose is an
    // example that teaches a form which does not exist.
    const kinds = new Set<string>();
    for (const fence of await controlFences()) {
      const md = /^\s*#\s/m.test(fence.body) ? fence.body : `# Example\n\n${fence.body}`;
      const parsed = parseTestContent(md, `${fence.doc} fence ${fence.index}`);
      const flows = [parsed.rawSteps, ...Object.values(parsed.sections).map((s) => s.rawSteps)];
      for (const step of flows.flat()) {
        const control = parseControlLine(step);
        if (control) kinds.add(control.kind);
      }
    }
    expect([...kinds].sort()).toEqual(['else', 'elseif', 'foreach', 'if', 'repeat', 'while']);
  });
});

// ─── A section named like a control line ────────────────────────────────────

/**
 * `### Else if b, then S2` is a legal section NAME, and a step reading exactly
 * that resolves to it by bare name — rung 2 of the expander's order, which
 * beats the control split on purpose (review 1's blocker 3). So the member
 * becomes an unconditional call and its condition is never asked, identically
 * on all three enforcers, which is exactly why nothing could tell the author.
 *
 * Resolution is unchanged. The parse now says so once, out loud.
 */
describe('a section whose name parses as a control line', () => {
  it('warns at parse time, naming the heading and its line', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const parsed = parseTestContent(
        [
          '# T',
          '',
          '## Steps',
          '1. If a, then S1',
          '2. Else if b, then S2',
          '',
          '### S1',
          '1. A',
          '',
          '### Else if b, then S2',
          '1. B',
        ].join('\n'),
        'tests/t.md',
      );

      const said = warn.mock.calls.map((c) => String(c[0]));
      const about = said.filter((m) => m.includes('named like a control line'));
      expect(about).toHaveLength(1);
      expect(about[0]).toContain('"Else if b, then S2"');
      expect(about[0]).toContain('tests/t.md:10');

      // …and nothing about how the file resolves has moved: the heading is
      // still a section, and step 2 is still the call that finds it.
      expect(Object.keys(parsed.sections)).toContain('else if b, then s2');
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing about an ordinary section name', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      parseTestContent(
        ['# T', '', '## Steps', '1. If a, then Pay with cash', '', '### Pay with cash', '1. A'].join('\n'),
        'tests/t.md',
      );
      expect(
        warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('named like a control line')),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
