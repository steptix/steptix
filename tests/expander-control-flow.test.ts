import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandSkills, clearSkillCache } from '../src/skills/expander.js';
import { parseTestContent } from '../src/parser/markdown.js';
import {
  closedChainMemberMessage,
  chainAfterFlowControlMessage,
  danglingChainMemberMessage,
} from '../src/parser/control-line.js';
import { logger } from '../src/utils/logger.js';

/**
 * Expansion of control lines (stories/control-flow.md §Expander).
 *
 * The whole design rests on one claim: the flat step list does not change
 * shape. A guard is an ordinary step, its tail is expanded IN PLACE as if it
 * were the step at that position — a section tail becoming a section frame
 * exactly as a bare-name call does — and the only new thing is a parallel
 * `controls` array saying which indices belong to which structure. These
 * tests are about that array's ranges and about the tail being genuinely
 * ordinary.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-exp-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const doc = (...lines: string[]): string => ['# T', '', '## Steps', '', ...lines].join('\n');

/** Expand a test file's own sections with no skills directory configured. */
async function expandInline(md: string, skillsDir?: string) {
  const parsed = parseTestContent(md, '/t/inline.md');
  return expandSkills(parsed.steps, skillsDir, undefined, '/t/inline.md', parsed.stepLines, {
    sections: parsed.sections,
    rawSteps: parsed.rawSteps,
    warnDeadSections: false,
  });
}

async function writeSkill(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${name}.md`), content);
}

describe('a chain', () => {
  const md = doc(
    '1. Sign in',
    '2. If cash, then Pay with cash',
    '3. Else if card, then Pay by card',
    '4. Otherwise, Verify the Pay now button is disabled',
    '5. Sign out',
    '',
    '### Pay with cash',
    '',
    '1. Click Pay now',
    '2. Verify the receipt',
    '',
    '### Pay by card',
    '',
    '1. Enter the card details',
    '2. Click Pay now',
  );

  it('expands every tail in place, in authored order', async () => {
    const result = await expandInline(md);
    expect(result.steps).toEqual([
      'Sign in',
      'If cash, then Pay with cash',
      'Click Pay now',
      'Verify the receipt',
      'Else if card, then Pay by card',
      'Enter the card details',
      'Click Pay now',
      'Otherwise, Verify the Pay now button is disabled',
      'Verify the Pay now button is disabled',
      'Sign out',
    ]);
  });

  it('records one chain, with every member sharing a chainId and a chainEnd', async () => {
    const { controls } = await expandInline(md);
    expect(controls.map((c) => c?.kind ?? null)).toEqual([
      null,
      'if',
      null,
      null,
      'elseif',
      null,
      null,
      'else',
      null,
      null,
    ]);
    expect(controls[1]).toEqual({
      kind: 'if',
      chainId: expect.any(String),
      condition: 'cash',
      bodyStart: 2,
      bodyEnd: 3,
      chainEnd: 8,
    });
    expect(controls[4]).toEqual({
      kind: 'elseif',
      chainId: (controls[1] as { chainId: string }).chainId,
      condition: 'card',
      bodyStart: 5,
      bodyEnd: 6,
      chainEnd: 8,
    });
    // The `Otherwise` carries no condition, and its body is the one plain
    // step its tail expanded to.
    expect(controls[7]).toEqual({
      kind: 'else',
      chainId: (controls[1] as { chainId: string }).chainId,
      bodyStart: 8,
      bodyEnd: 8,
      chainEnd: 8,
    });
  });

  it('gives each section tail its own frame, parented where the guard sits', async () => {
    const result = await expandInline(md);
    const cash = result.origins[2]!.frameId;
    const card = result.origins[5]!.frameId;
    expect(cash).not.toBe('');
    expect(card).not.toBe(cash);
    expect(result.frames[cash]).toMatchObject({
      kind: 'section',
      skillName: 'Pay with cash',
      parentId: null, // the guard is at the top level
      invocationLine: 6, // the `If` line, not the heading
    });
    // The guard itself stays in the enclosing frame.
    expect(result.origins[1]!.frameId).toBe('');
  });

  it('attributes every tail step to the guard line, so [no-hooks] covers it', async () => {
    const result = await expandInline(md);
    // Guard 2 (input index 1) and both of its body steps.
    expect(result.origins.slice(1, 4).map((o) => o.inputIndex)).toEqual([1, 1, 1]);
    // The `Otherwise` and its plain tail.
    expect(result.origins.slice(7, 9).map((o) => o.inputIndex)).toEqual([3, 3]);
  });

  it('two chains in one flow get distinct ids', async () => {
    const { controls } = await expandInline(
      doc('1. If a, then X', '2. Otherwise, Y', '3. Click Save', '4. If b, then Z', '5. Otherwise, W'),
    );
    // Indices: If(0) X(1) Otherwise(2) Y(3) Click Save(4) If(5) Z(6) Otherwise(7) W(8)
    const first = (controls[0] as { chainId: string }).chainId;
    const second = (controls[5] as { chainId: string }).chainId;
    expect((controls[2] as { chainId: string }).chainId).toBe(first);
    expect(second).not.toBe(first);
    expect((controls[7] as { chainId: string }).chainId).toBe(second);
    // …and the ordinary step between them belongs to neither.
    expect(controls[4]).toBeNull();
  });
});

describe('a nested chain', () => {
  it('sits strictly inside the outer body`s range', async () => {
    const { steps, controls } = await expandInline(
      doc(
        '1. If cash, then Pay with cash',
        '2. Otherwise, Pay by card',
        '',
        '### Pay with cash',
        '',
        '1. Click Pay now',
        '',
        '### Pay by card',
        '',
        '1. Enter the card details',
        '2. If a 3-D Secure frame appears, then Complete the bank challenge',
        '3. Click Pay now',
        '',
        '### Complete the bank challenge',
        '',
        '1. Click Confirm',
      ),
    );
    expect(steps).toEqual([
      'If cash, then Pay with cash',
      'Click Pay now',
      'Otherwise, Pay by card',
      'Enter the card details',
      'If a 3-D Secure frame appears, then Complete the bank challenge',
      'Click Confirm',
      'Click Pay now',
    ]);
    const outer = controls[2] as { bodyStart: number; bodyEnd: number; chainId: string };
    const inner = controls[4] as { bodyStart: number; bodyEnd: number; chainId: string };
    expect(outer).toMatchObject({ bodyStart: 3, bodyEnd: 6 });
    expect(inner).toMatchObject({ bodyStart: 5, bodyEnd: 5, chainEnd: 5 });
    // Containment, and two different chains.
    expect(inner.bodyStart).toBeGreaterThan(outer.bodyStart);
    expect(inner.bodyEnd).toBeLessThanOrEqual(outer.bodyEnd);
    expect(inner.chainId).not.toBe(outer.chainId);
  });
});

describe('the loops', () => {
  it('While, Repeat and For each each record their body and label', async () => {
    const { steps, controls } = await expandInline(
      doc(
        '1. While the Next button is enabled, Go to the next page',
        '2. Repeat Click Load more until it is gone, up to 20 times',
        '3. For each {{account}} in {{accounts}}, Check the account',
        '',
        '### Go to the next page',
        '',
        '1. Click Next',
        '2. Verify the page changed',
      ),
    );
    expect(steps).toHaveLength(7);
    expect(controls[0]).toEqual({
      kind: 'while',
      condition: 'the Next button is enabled',
      bodyStart: 1,
      bodyEnd: 2,
      label: 'Go to the next page',
    });
    expect(controls[3]).toEqual({
      kind: 'repeat',
      condition: 'it is gone',
      bodyStart: 4,
      bodyEnd: 4,
      cap: 20,
      label: 'Click Load more',
    });
    expect(controls[5]).toEqual({
      kind: 'foreach',
      item: 'account',
      list: 'accounts',
      bodyStart: 6,
      bodyEnd: 6,
      label: 'Check the account',
    });
  });

  it('labels a section tail with the section`s own casing', async () => {
    const { controls } = await expandInline(
      doc('1. While a, go to the NEXT page', '', '### Go to the Next Page', '', '1. Click Next'),
    );
    expect(controls[0]).toMatchObject({ label: 'Go to the Next Page' });
  });

  it('omits cap when the line named none', async () => {
    const { controls } = await expandInline(doc('1. While a, Click Next'));
    expect(controls[0]).not.toHaveProperty('cap');
  });
});

describe('the tail is an ordinary step', () => {
  it('a plain tail is emitted as itself, in the enclosing frame', async () => {
    const result = await expandInline(doc('1. If a, then Click the Pay now button'));
    expect(result.steps).toEqual(['If a, then Click the Pay now button', 'Click the Pay now button']);
    expect(result.origins[1]!.frameId).toBe('');
    // The match side is the AUTHORED TAIL, so a code-behind entry written for
    // `Click the Pay now button` binds whether the step was written on its own
    // line or as a tail.
    expect(result.rawSteps[1]).toBe('Click the Pay now button');
  });

  it('a [skill:] tail goes through skill expansion, with its own frame', async () => {
    await writeSkill(
      'enable_pro',
      ['# enable_pro', '', '## Steps', '', '1. Open Settings', '2. Turn on Pro'].join('\n'),
    );
    const result = await expandInline(
      doc('1. If {{plan}} is "pro", then [skill: enable_pro]'),
      tmpDir,
    );
    expect(result.steps).toEqual([
      'If {{plan}} is "pro", then [skill: enable_pro]',
      'Open Settings',
      'Turn on Pro',
    ]);
    expect(result.controls[0]).toMatchObject({ kind: 'if', bodyStart: 1, bodyEnd: 2 });
    expect(result.sourceSkills).toEqual([null, 'enable_pro', 'enable_pro']);
    expect(result.frames[result.origins[1]!.frameId]).toMatchObject({ kind: 'skill' });
  });

  it('a Set tail is emitted as an assignment, not rewritten', async () => {
    const result = await expandInline(
      doc('1. If a, then Click Pay', '2. Otherwise, Set {{plan}} to "free"'),
    );
    expect(result.steps[3]).toBe('Set {{plan}} to "free"');
  });

  it('a control line inside a skill body works, resolved on the authored text', async () => {
    await writeSkill(
      'pay',
      [
        '# pay',
        '',
        '## Parameters',
        '',
        '- method: cash',
        '',
        '## Steps',
        '',
        '1. If the {{method}} option is shown, then Click Pay now',
      ].join('\n'),
    );
    const result = await expandInline(doc('1. [skill: pay method="card"]'), tmpDir);
    // The caller's argument is interpolated into the guard and its tail is
    // still the tail — the DECISION is made on the authored text.
    expect(result.steps).toEqual([
      'If the card option is shown, then Click Pay now',
      'Click Pay now',
    ]);
    expect(result.controls[0]).toMatchObject({ kind: 'if', bodyStart: 1, bodyEnd: 1 });
  });
});

describe('liveness', () => {
  it('a section named only as a tail is invoked, and gets no dead warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const parsed = parseTestContent(
      doc('1. If cash, then Pay with cash', '', '### Pay with cash', '', '1. Click Pay now'),
      '/t/inline.md',
    );
    await expandSkills(parsed.steps, undefined, undefined, '/t/inline.md', parsed.stepLines, {
      sections: parsed.sections,
      rawSteps: parsed.rawSteps,
    });
    expect(warn.mock.calls.flat().join('\n')).not.toContain('never invoked');
  });

  it('a section named nowhere still warns', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const parsed = parseTestContent(
      doc('1. If cash, then Click Pay now', '', '### Pay with cash', '', '1. Click Pay now'),
      '/t/inline.md',
    );
    await expandSkills(parsed.steps, undefined, undefined, '/t/inline.md', parsed.stepLines, {
      sections: parsed.sections,
      rawSteps: parsed.rawSteps,
    });
    expect(warn.mock.calls.flat().join('\n')).toContain('never invoked');
  });
});

/**
 * Hooks are the one step list control flow deliberately does not reach
 * (`expandControlLines: false`, passed for `## Hooks` and for
 * `execution.defaultHooks`) — and until now it said so to nobody. A hook
 * reading `If the cookie banner is showing, then Dismiss banner` simply became
 * prose the model was asked to perform, which is a decision the author
 * believes they wrote and the run never made.
 */
describe('a control line in a hook scope', () => {
  const asHook = async (steps: string[]) =>
    expandSkills(steps, undefined, undefined, '/t/inline.md', steps.map((_, i) => i + 1), {
      expandControlLines: false,
      warnDeadSections: false,
    });

  it('runs as prose, and says so once', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const result = await asHook(['If the cookie banner is showing, then Dismiss banner']);

    // Still one step, still no control record — the carve-out is unchanged.
    expect(result.steps).toEqual(['If the cookie banner is showing, then Dismiss banner']);
    expect(result.controls).toEqual([null]);

    const said = warn.mock.calls.flat().join('\n');
    expect(said).toContain('hooks do not dispatch control lines');
    expect(said).toContain('If the cookie banner is showing, then Dismiss banner');
    expect(warn.mock.calls).toHaveLength(1);
  });

  it('warns for a loop form too, and once per entry', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await asHook([
      'Navigate to /login',
      'While the spinner is showing, Wait a moment',
      'For each {{a}} in {{b}}, Check it',
    ]);
    expect(warn.mock.calls).toHaveLength(2);
  });

  it('says nothing about an ordinary hook entry', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await asHook(['If a session warning toast is visible, close that toast', 'Sign out']);
    // The watch form is a hook's normal business and is untouched by this.
    expect(warn.mock.calls).toHaveLength(0);
  });
});

describe('control lines inside a looped section', () => {
  it('a For each over an enclosing row column is refused at expansion', async () => {
    // The parse-time guard sees the step's OWN section's columns; this one is
    // bound by the section ENCLOSING it, which only expansion knows.
    await expect(
      expandInline(
        doc(
          '1. Outer',
          '',
          '### Outer',
          '',
          '| account |',
          '| --- |',
          '| Savings |',
          '',
          '1. Inner',
          '',
          '### Inner',
          '',
          '1. For each {{account}} in {{accounts}}, Check it',
        ),
      ),
    ).rejects.toThrow(/Cannot loop over \{\{account\}\}/);
  });

  it('a For each over an enclosing row column as the LIST is refused too', async () => {
    // The item side destroys the loop by leaving a line that claims the form
    // and fails it; the list side is quieter and worse — the line stops
    // claiming anything and runs as one prose step, with the record still
    // naming a variable that no longer appears in the text.
    await expect(
      expandInline(
        doc(
          '1. Outer',
          '',
          '### Outer',
          '',
          '| accounts |',
          '| --- |',
          '| Savings |',
          '',
          '1. Inner',
          '',
          '### Inner',
          '',
          '1. For each {{account}} in {{accounts}}, Check it',
        ),
      ),
    ).rejects.toThrow(/Cannot loop over the items of \{\{accounts\}\}/);
  });

  it('a control line whose condition uses a row column is fine', async () => {
    const { steps, controls } = await expandInline(
      doc(
        '1. Check them',
        '',
        '### Check them',
        '',
        '| owner |',
        '| --- |',
        '| Ada |',
        '| Bob |',
        '',
        '1. If the row for {{owner}} is highlighted, then Click it',
      ),
    );
    expect(steps).toEqual([
      'If the row for Ada is highlighted, then Click it',
      'Click it',
      'If the row for Bob is highlighted, then Click it',
      'Click it',
    ]);
    // …and the RECORDED condition carries the row's value. A row value is
    // baked into the text, not kept as a variable, so `{{owner}}` would reach
    // the judge with no `## Values` entry able to resolve it — and both rows
    // would ask the model the same unanswerable question.
    expect(controls[0]).toMatchObject({ condition: 'the row for Ada is highlighted' });
    expect(controls[2]).toMatchObject({ condition: 'the row for Bob is highlighted' });
  });

  it('a loop band is labelled with the row`s own text, not the placeholder', async () => {
    const { controls } = await expandInline(
      doc(
        '1. Check them',
        '',
        '### Check them',
        '',
        '| status |',
        '| --- |',
        '| Pending |',
        '| Settled |',
        '',
        '1. While {{status}} is shown, Click Refresh {{status}}',
      ),
    );
    expect(controls[0]).toMatchObject({
      kind: 'while',
      condition: 'Pending is shown',
      label: 'Click Refresh Pending',
    });
    expect(controls[2]).toMatchObject({
      kind: 'while',
      condition: 'Settled is shown',
      label: 'Click Refresh Settled',
    });
  });

  it('a section tail is still labelled by its NAME, resolved on the authored text', async () => {
    const { controls } = await expandInline(
      doc(
        '1. Check them',
        '',
        '### Check them',
        '',
        '| status |',
        '| --- |',
        '| Pending |',
        '',
        '1. While {{status}} is shown, Refresh the list',
        '',
        '### Refresh the list',
        '',
        '1. Click Refresh',
      ),
    );
    expect(controls[0]).toMatchObject({ label: 'Refresh the list' });
  });
});

describe('control lines inside a skill body', () => {
  it('a For each records the SCOPED item and the caller`s list', async () => {
    // `applySkillScope` renames a body's own placeholders to `__skill<N>_<name>`
    // and interpolates the caller's arguments, so the step the runtime executes
    // says `For each {{__skill1_item}} in {{accounts}}`. A record naming the
    // authored `item` / `list` would bind and read variables that do not exist:
    // the loop fails with "`{{list}}` has no value" and the body never sees its
    // item.
    await writeSkill(
      'check_accounts',
      [
        '# Check accounts',
        '',
        '## Parameters',
        '',
        '- list: the accounts to check',
        '',
        '## Steps',
        '',
        '1. For each {{item}} in {{list}}, Check it',
        '',
        '### Check it',
        '',
        '1. Verify "{{item}}" is shown',
      ].join('\n'),
    );
    const { steps, controls, rawSteps } = await expandInline(
      doc(
        '1. Read the name of every account [store as: accounts]',
        '2. [skill: check_accounts list="{{accounts}}"]',
      ),
      tmpDir,
    );
    expect(steps[1]).toBe('For each {{__skill1_item}} in {{accounts}}, Check it');
    expect(controls[1]).toMatchObject({
      kind: 'foreach',
      item: '__skill1_item',
      list: 'accounts',
      label: 'Check it',
    });
    // The authored text stays where the editor and code-behind read it.
    expect(rawSteps[1]).toBe('For each {{item}} in {{list}}, Check it');
    expect(steps[2]).toBe('Verify "{{__skill1_item}}" is shown');
  });

  /**
   * The same rename, over an OBJECT row
   * (docs/specs/SPEC-structured-table-reads.md §8.2).
   *
   * `{{item.id}}` names the variable `item` and one of its properties, and the
   * property belongs to the row rather than to this skill's scope. So the
   * rename keys on the ROOT and carries the segment across: the loop binds
   * `__skill1_item` and, per pass, `__skill1_item.id`, which is exactly what
   * the body now asks for.
   *
   * Namespacing `item.id` as a name in its own right would produce
   * `{{__skill1_item.id}}` from a rename of `item.id`, and the same string
   * from the root rename — consistent only by accident, and not at all when a
   * declared parameter shares the root (the root is exempt from renaming, the
   * dotted form is not, and the two halves then disagree).
   */
  it('a dotted reference in a skill body renames by its root, segment intact', async () => {
    await writeSkill(
      'check_orders',
      [
        '# Check orders',
        '',
        '## Parameters',
        '',
        '- list: the orders to check',
        '',
        '## Steps',
        '',
        '1. For each {{item}} in {{list}}, Check it',
        '',
        '### Check it',
        '',
        '1. Verify the row for "{{item.id}}" shows "{{item.status}}" in row {{item._row}}',
      ].join('\n'),
    );
    const { steps, controls } = await expandInline(
      doc(
        '1. Read the Order ID column as id from every row in the Orders table [store as: orders]',
        '2. [skill: check_orders list="{{orders}}"]',
      ),
      tmpDir,
    );
    expect(controls[1]).toMatchObject({ kind: 'foreach', item: '__skill1_item', list: 'orders' });
    expect(steps[2]).toBe(
      'Verify the row for "{{__skill1_item.id}}" shows "{{__skill1_item.status}}" ' +
        'in row {{__skill1_item._row}}',
    );
  });

  it('a declared parameter keeps its name, and so do its properties', async () => {
    await writeSkill(
      'show_order',
      [
        '# Show order',
        '',
        '## Parameters',
        '',
        '- order: the row to show',
        '',
        '## Steps',
        '',
        '1. Verify {{order.id}} is shown',
      ].join('\n'),
    );
    const { steps } = await expandInline(doc('1. [skill: show_order order="{{row}}"]'), tmpDir);
    // The argument is interpolated into the body TEXT, so `{{order}}` itself
    // would be baked — but `{{order.id}}` is not a key of `call.args`, so it
    // survives as a runtime reference rather than becoming `__skill1_order.id`,
    // which nothing would ever bind.
    expect(steps[0]).toBe('Verify {{order.id}} is shown');
  });

  it('a condition records the text the model will be asked, parameters resolved', async () => {
    await writeSkill(
      'upgrade',
      [
        '# Upgrade',
        '',
        '## Parameters',
        '',
        '- plan: the plan name',
        '',
        '## Steps',
        '',
        '1. If {{plan}} is "pro", then Click Upgrade',
      ].join('\n'),
    );
    const { steps, controls, rawSteps } = await expandInline(
      doc('1. [skill: upgrade plan="pro"]'),
      tmpDir,
    );
    expect(steps[0]).toBe('If pro is "pro", then Click Upgrade');
    // Not `{{plan}}`: an argument is baked into the body text, so nothing at
    // run time could resolve it — the judge would be asked about a placeholder.
    expect(controls[0]).toMatchObject({ kind: 'if', condition: 'pro is "pro"' });
    expect(rawSteps[0]).toBe('If {{plan}} is "pro", then Click Upgrade');
  });

  it('and each iteration gets its own records, at its own indices', async () => {
    const { controls } = await expandInline(
      doc(
        '1. Check them',
        '',
        '### Check them',
        '',
        '| owner |',
        '| --- |',
        '| Ada |',
        '| Bob |',
        '',
        '1. If the row for {{owner}} is highlighted, then Click it',
      ),
    );
    expect(controls[0]).toMatchObject({ kind: 'if', bodyStart: 1, bodyEnd: 1, chainEnd: 1 });
    expect(controls[2]).toMatchObject({ kind: 'if', bodyStart: 3, bodyEnd: 3, chainEnd: 3 });
    // Two passes of one authored chain are two chains at runtime — the runtime
    // finds a chain's members by id, and index 0's `Otherwise` must never be
    // index 2's.
    expect((controls[0] as { chainId: string }).chainId).not.toBe(
      (controls[2] as { chainId: string }).chainId,
    );
  });
});

/**
 * A dangling `Else if` / `Otherwise` on the WIRE path.
 *
 * `parseTestContent` is not on that path — TestBench sends steps it scanned
 * itself, and the server expands them — so the expander is the only parser a
 * wire document meets. Left alone, a dangling `Otherwise` opened a chain of
 * its own, became its own fallback, and ran its tail unconditionally: the
 * branch the author wrote as the alternative to something else, performed
 * because the something else was not in the batch.
 */
describe('a dangling chain member is refused here too', () => {
  it('an Otherwise with an ordinary step above it', async () => {
    await expect(
      expandInline(doc('1. If a, then X', '2. Click Save', '3. Otherwise, Y')),
    ).rejects.toThrow(
      /"Otherwise, Y" has no decision to be the alternative of.*\(## Steps\)/s,
    );
  });

  it('an Otherwise as the very first step of a batch', async () => {
    await expect(expandInline(doc('1. Otherwise, Y', '2. Click Save'))).rejects.toThrow(
      /has no decision to be the alternative of/,
    );
  });

  it('an Else if with an [input:] between it and its If', async () => {
    // The shape the client's own pre-flight refuses first. Both refusals now
    // name the same line in the same words.
    await expect(
      expandInline(doc('1. If a, then X', '2. [input: pin] Enter your PIN', '3. Else if b, then Y')),
    ).rejects.toThrow(/"Else if b, then Y" has no decision to be the alternative of/);
  });

  it('in a section body, naming that body as the flow', async () => {
    await expect(
      expandInline(
        doc('1. Pay', '', '### Pay', '', '1. If a, then X', '2. Click Save', '3. Otherwise, Y'),
      ),
    ).rejects.toThrow(/\(### Pay\)/);
  });

  it('the parser`s wording, character for character', async () => {
    const expected = danglingChainMemberMessage({
      line: 'Otherwise, Y',
      word: 'Otherwise',
      flow: '## Steps',
      where: '/t/inline.md:7',
    });
    await expect(
      expandInline(doc('1. If a, then X', '2. Click Save', '3. Otherwise, Y')),
    ).rejects.toThrow(expected);
  });

  it('but a well-formed chain still expands', async () => {
    const { controls } = await expandInline(
      doc('1. If a, then X', '2. Else if b, then Y', '3. Otherwise, Z'),
    );
    const ids = [controls[0], controls[2], controls[4]].map((c) => (c as { chainId: string }).chainId);
    expect(new Set(ids).size).toBe(1);
  });
});

/**
 * An `Else if` / `Otherwise` under an `If … then return`
 * (stories/control-flow.md §"Composition with `If … then return`").
 *
 * The third refusal in this family, and the one an author actually writes: the
 * line above opens `If`, so the plain dangling sentence reads as a parser bug.
 * Refused in the same three places — the CLI parser, here, and runner-core's
 * pre-flight — in one wording, because an author who meets it in TestBench and
 * then again from the CLI must read the same sentence about the same line.
 */
describe('a chain member under a flow-control step is refused here too', () => {
  it('an Otherwise under an `If … then return`', async () => {
    await expect(
      expandInline(doc('1. If the balance is zero, then return', '2. Otherwise, Y')),
    ).rejects.toThrow(/ends the flow rather than choosing a branch/);
  });

  it('an Else if under a `then stop here`', async () => {
    await expect(
      expandInline(doc('1. If the list is empty, then stop here', '2. Else if b, then Y')),
    ).rejects.toThrow(/ends the flow rather than choosing a branch/);
  });

  it('an Otherwise under an unconditional Return', async () => {
    // `Return` is a flow-control step too, and one whose `Otherwise` is even
    // less meaningful — nothing was decided at all.
    await expect(expandInline(doc('1. Return', '2. Otherwise, Y'))).rejects.toThrow(
      /ends the flow rather than choosing a branch/,
    );
  });

  it('the parser`s wording, character for character', async () => {
    const expected = chainAfterFlowControlMessage({
      line: 'Otherwise, Y',
      word: 'Otherwise',
      previous: 'If the balance is zero, then return',
      where: '/t/inline.md:6',
    });
    await expect(
      expandInline(doc('1. If the balance is zero, then return', '2. Otherwise, Y')),
    ).rejects.toThrow(expected);
  });

  it('a near miss is a chain head, so the Otherwise under it expands', async () => {
    // `then return to the dashboard` is a chain whose tail is prose, so this
    // is a well-formed two-member decision.
    const { controls } = await expandInline(
      doc('1. If a, then return to the dashboard', '2. Otherwise, Z'),
    );
    const ids = [controls[0], controls[2]].map((c) => (c as { chainId: string }).chainId);
    expect(new Set(ids).size).toBe(1);
  });
});

/**
 * The other half of the same rule: a member written BELOW the `Otherwise` that
 * closed the chain.
 *
 * This one was refused by the CLI parser alone, so a file TestBench and the
 * Sessions API ran happily was rejected by `aiui run` — and what they ran was
 * not what it looked like: `fallbackOf` takes the FIRST condition-less member,
 * so a second `Otherwise`'s tail is unreachable code that is always skipped,
 * while an `Else if` written under one is still evaluated.
 */
describe('a chain member below the Otherwise is refused here too', () => {
  it('an Else if under an Otherwise', async () => {
    await expect(
      expandInline(doc('1. If a, then X', '2. Otherwise, Y', '3. Else if b, then Z')),
    ).rejects.toThrow(/"Else if b, then Z" follows an `Otherwise`, which ends a chain/);
  });

  it('a second Otherwise', async () => {
    await expect(
      expandInline(doc('1. If a, then X', '2. Otherwise, Y', '3. Otherwise, Z')),
    ).rejects.toThrow(/"Otherwise, Z" follows an `Otherwise`, which ends a chain/);
  });

  it('the parser`s wording, character for character', async () => {
    const expected = closedChainMemberMessage({
      line: 'Else if b, then Z',
      where: '/t/inline.md:7',
    });
    await expect(
      expandInline(doc('1. If a, then X', '2. Otherwise, Y', '3. Else if b, then Z')),
    ).rejects.toThrow(expected);
  });

  it('inside a section body, where the chain is a different flow', async () => {
    await expect(
      expandInline(
        doc('1. Pay', '', '### Pay', '', '1. If a, then X', '2. Otherwise, Y', '3. Otherwise, Z'),
      ),
    ).rejects.toThrow(/follows an `Otherwise`/);
  });

  it('but a NEW If after an Otherwise opens a fresh chain', async () => {
    // The control: closing one decision must not poison the next.
    const { controls } = await expandInline(
      doc('1. If a, then X', '2. Otherwise, Y', '3. If b, then Z', '4. Otherwise, W'),
    );
    const ids = [controls[0], controls[2], controls[4], controls[6]].map(
      (c) => (c as { chainId: string }).chainId,
    );
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
  });
});

/**
 * A section whose NAME parses as a control line, warned about where the run
 * actually resolves it.
 *
 * The parser says this too (`scanStepSpans`, src/parser/markdown.ts), but that
 * scan runs only on `aiui run` and on a server compile: an ordinary
 * `/sessions/:id/steps` run arrives with `steps` and `sections` already parsed
 * by runner-core inside the extension, so on TestBench and MCP — the surfaces
 * where sections are actually authored — nothing was ever said (review 4,
 * finding 10). Resolution is unchanged on every path; only the telling is new.
 */
describe('a section named like a control line, at expansion', () => {
  const md = doc(
    '1. While the Next button is enabled, Go to the next page',
    '2. Verify the last page',
    '',
    '### While the Next button is enabled, Go to the next page',
    '',
    '1. Click Next',
  );

  /** Parse first, so only the EXPANDER's warnings are counted — the parser
   *  has its own, tested in `parser-control-flow.test.ts`. */
  async function expanderWarnings(source: string): Promise<string[]> {
    const parsed = parseTestContent(source, '/t/inline.md');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await expandSkills(parsed.steps, undefined, undefined, '/t/inline.md', parsed.stepLines, {
        sections: parsed.sections,
        rawSteps: parsed.rawSteps,
        warnDeadSections: false,
      });
      return warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('named like a control line'));
    } finally {
      warn.mockRestore();
    }
  }

  it('warns once, naming the heading', async () => {
    const said = await expanderWarnings(md);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"While the Next button is enabled, Go to the next page"');
    expect(said[0]).toContain('/t/inline.md');
  });

  it('resolves exactly as it did: the call is the section, not a loop', async () => {
    // The warning is the whole fix. Rung 2 still beats the control split, so
    // the guard the author thinks they wrote is not there.
    const { steps, controls } = await expandInline(md);
    expect(steps).toEqual(['Click Next', 'Verify the last page']);
    expect(controls.every((c) => c === null)).toBe(true);
  });

  it('says it once however many times the section is called', async () => {
    const twice = doc(
      '1. While the Next button is enabled, Go to the next page',
      '2. While the Next button is enabled, Go to the next page',
      '3. Verify the last page',
      '',
      '### While the Next button is enabled, Go to the next page',
      '',
      '1. Click Next',
    );
    expect(await expanderWarnings(twice)).toHaveLength(1);
  });

  it('says nothing about an ordinary section name', async () => {
    const plain = doc(
      '1. If the Cash checkbox is ticked, then Pay with cash',
      '2. Verify the receipt',
      '',
      '### Pay with cash',
      '',
      '1. Click Pay now',
    );
    expect(await expanderWarnings(plain)).toEqual([]);
  });
});
