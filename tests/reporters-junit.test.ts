import { describe, expect, it } from 'vitest';
import { renderJUnit } from '../src/report/reporters/junit.js';
import type { RunState, RunTestEntry } from '../src/report/reporters/types.js';
import { KEYLESS_DIAGNOSIS_SKIPPED, POLICY_DIAGNOSIS_SKIPPED } from '../src/report/types.js';
import type { RowSummaryLine, StepResult, TestReport } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Fixtures. Every name, step and value is invented.
// ---------------------------------------------------------------------------

function step(index: number, instruction: string, extra: Partial<StepResult> = {}): StepResult {
  return { index, instruction, status: 'passed', turns: [], durationMs: 1000, retried: false, ...extra };
}

function report(steps: StepResult[], extra: Partial<TestReport> = {}): TestReport {
  return {
    testName: 'Place an order',
    filePath: 'unused',
    tags: [],
    status: steps.some((s) => s.status === 'failed' && !s.tolerated && !s.interrupted) ? 'failed' : 'passed',
    steps,
    totalSteps: steps.length,
    passedSteps: steps.filter((s) => s.status === 'passed').length,
    failedSteps: steps.filter((s) => s.status === 'failed' && !s.tolerated && !s.interrupted).length,
    totalSubActions: 0,
    durationMs: 21004,
    tokensUsed: 1200,
    inputTokens: 1000,
    outputTokens: 200,
    date: '2026-01-02T03:04:05.000Z',
    ...extra,
  };
}

function done(title: string, r: TestReport, reportFile = 'order.html'): RunTestEntry {
  return { title, file: 'tests/order.md', tags: [], state: 'done', report: r, reportFile };
}

function notRun(title: string, file = 'tests/later.md'): RunTestEntry {
  return { title, file, tags: [], state: 'notRun' };
}

function state(tests: RunTestEntry[], extra: Partial<RunState> = {}): RunState {
  return {
    suiteName: 'shop-tests',
    startedAt: '2026-01-02T03:04:05.000Z',
    durationMs: 83412,
    finished: true,
    bailed: false,
    failOnHealed: false,
    steptix: { version: '0.0.0-test', commit: null },
    tests,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A strict, small XML reader: it throws on anything that is not well-formed
// (a raw `<` or `&` in text, an unknown entity, a forbidden character, a tag
// left open or closed out of order, an unquoted or repeated attribute), and
// otherwise returns the element tree with entities decoded. The repo has no
// XML parser among its own dependencies, so this stands in for one.
// ---------------------------------------------------------------------------

interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
  text: string;
}

const FORBIDDEN = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const NAME = '[A-Za-z_][\\w.:-]*';

function decode(raw: string, where: string): string {
  if (raw.includes('<')) throw new Error(`raw < in ${where}`);
  return raw.replace(/&([^;]*);?/g, (match, body: string) => {
    if (!match.endsWith(';')) throw new Error(`unterminated entity in ${where}`);
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (body in named) return named[body]!;
    const num = /^#(\d+)$/.exec(body) ?? /^#x([0-9a-fA-F]+)$/.exec(body);
    if (!num) throw new Error(`unknown entity &${body}; in ${where}`);
    const code = body.startsWith('#x') ? parseInt(num[1]!, 16) : parseInt(num[1]!, 10);
    const ch = String.fromCodePoint(code);
    if (FORBIDDEN.test(ch)) throw new Error(`forbidden character reference in ${where}`);
    return ch;
  });
}

function parseXml(xml: string): El {
  if (FORBIDDEN.test(xml)) throw new Error('forbidden character');
  let rest = xml.replace(/^<\?xml [^?]*\?>\s*/, '');
  if (rest === xml) throw new Error('no XML declaration');
  const root: El = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: El[] = [root];
  const tagRe = new RegExp(`^<(/?)(${NAME})((?:\\s+${NAME}\\s*=\\s*"[^"]*")*)\\s*(/?)>`);
  while (rest.length > 0) {
    const lt = rest.indexOf('<');
    const textPart = lt === -1 ? rest : rest.slice(0, lt);
    if (textPart) {
      const top = stack[stack.length - 1]!;
      if (top === root && textPart.trim() !== '') throw new Error('text outside the root');
      top.text += decode(textPart, 'text');
      rest = rest.slice(textPart.length);
      continue;
    }
    const m = tagRe.exec(rest);
    if (!m) throw new Error(`bad tag at: ${rest.slice(0, 40)}`);
    const [all, closing, name, attrText, selfClose] = m;
    rest = rest.slice(all!.length);
    if (closing) {
      if (attrText || selfClose) throw new Error('bad closing tag');
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`</${name}> closes <${top?.name}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText!.matchAll(new RegExp(`(${NAME})\\s*=\\s*"([^"]*)"`, 'g'))) {
      if (a[1]! in attrs) throw new Error(`repeated attribute ${a[1]}`);
      attrs[a[1]!] = decode(a[2]!, `attribute ${a[1]}`);
    }
    const el: El = { name: name!, attrs, children: [], text: '' };
    const parent = stack[stack.length - 1]!;
    if (parent === root && root.children.length > 0) throw new Error('second root element');
    parent.children.push(el);
    if (!selfClose) stack.push(el);
  }
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1]!.name}> never closed`);
  const top = root.children[0];
  if (!top) throw new Error('no root element');
  return top;
}

function child(el: El, name: string): El | undefined {
  return el.children.find((c) => c.name === name);
}

function cases(xml: string): El[] {
  const suites = parseXml(xml);
  expect(suites.name).toBe('testsuites');
  const suite = child(suites, 'testsuite')!;
  return suite.children.filter((c) => c.name === 'testcase');
}

function props(tc: El): Record<string, string> {
  const p = child(tc, 'properties');
  return Object.fromEntries((p?.children ?? []).map((c) => [c.attrs.name!, c.attrs.value!]));
}

/** The suite's counts must be what its testcases hold, on both elements. */
function expectCountsMatch(xml: string): void {
  const suites = parseXml(xml);
  const suite = child(suites, 'testsuite')!;
  const tcs = suite.children.filter((c) => c.name === 'testcase');
  const expected = {
    tests: String(tcs.length),
    failures: String(tcs.filter((t) => child(t, 'failure')).length),
    errors: String(tcs.filter((t) => child(t, 'error')).length),
    skipped: String(tcs.filter((t) => child(t, 'skipped')).length),
  };
  for (const el of [suites, suite]) {
    expect({
      tests: el.attrs.tests,
      failures: el.attrs.failures,
      errors: el.attrs.errors,
      skipped: el.attrs.skipped,
    }).toEqual(expected);
  }
}

function render(s: RunState): string {
  const xml = renderJUnit(s);
  expectCountsMatch(xml);
  return xml;
}

// ---------------------------------------------------------------------------

describe('the strict XML reader the tests use', () => {
  it.each([
    ['a raw ampersand', '<?xml version="1.0"?>\n<a>x & y</a>'],
    ['an unknown entity', '<?xml version="1.0"?>\n<a>&nbsp;</a>'],
    ['a forbidden character', '<?xml version="1.0"?>\n<a>\u0001</a>'],
    ['tags closed out of order', '<?xml version="1.0"?>\n<a><b></a></b>'],
    ['a tag left open', '<?xml version="1.0"?>\n<a><b/>'],
    ['a raw < in an attribute', '<?xml version="1.0"?>\n<a b="<"/>'],
    ['two root elements', '<?xml version="1.0"?>\n<a/><b/>'],
  ])('refuses %s', (_label, xml) => {
    expect(() => parseXml(xml)).toThrow();
  });
});

describe('renderJUnit', () => {
  it('writes one passing testcase with its properties and report link', () => {
    const r = report([
      step(1, 'Open the shop'),
      step(2, 'Add #item to the basket', { fromCodeBehind: true }),
    ]);
    const xml = render(state([done('Place an order', r, '2026-01-02_03-04-05-place-an-order.html')]));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);

    const suites = parseXml(xml);
    expect(suites.attrs).toMatchObject({ name: 'shop-tests', time: '83.412' });
    const suite = child(suites, 'testsuite')!;
    expect(suite.attrs).toMatchObject({ name: 'shop-tests', timestamp: '2026-01-02T03:04:05.000Z' });

    const [tc] = cases(xml);
    expect(tc!.attrs).toEqual({
      name: 'Place an order',
      classname: 'tests/order.md',
      file: 'tests/order.md',
      time: '21.004',
    });
    expect(child(tc!, 'failure')).toBeUndefined();
    expect(child(tc!, 'error')).toBeUndefined();
    expect(props(tc!)).toEqual({
      report: '2026-01-02_03-04-05-place-an-order.html',
      tokens: '1200',
      steps: '2',
      stepsFromCode: '1',
    });
    expect(child(tc!, 'system-out')!.text).toBe('[[ATTACHMENT|2026-01-02_03-04-05-place-an-order.html]]');
  });

  it('leaves out the placeholder a run with no AI puts in the diagnosis slot', () => {
    for (const rootCause of [KEYLESS_DIAGNOSIS_SKIPPED, POLICY_DIAGNOSIS_SKIPPED]) {
      const r = report(
        [step(1, 'Open the shop', { status: 'failed', error: 'The shop did not open.' })],
        {
          diagnosis: { rootCause, faultCategory: 'unknown', evidence: [], suggestedFix: '', confidence: 'low' },
        },
      );
      const [tc] = cases(render(state([done('Place an order', r)])));
      expect(child(tc!, 'failure')!.text).toBe(
        ['Step 1: Open the shop', 'The shop did not open.', 'Report: order.html#step-1'].join('\n'),
      );
    }
  });

  it('names the failing step, its error, the report anchor and the diagnosis', () => {
    const r = report(
      [
        step(1, 'Open the shop'),
        step(2, 'Verify the total is "42.00"', { status: 'failed', error: 'Expected "42.00" but saw "24.00".' }),
        step(3, 'Pay', { status: 'skipped' }),
      ],
      {
        diagnosis: {
          rootCause: 'The total was not updated.',
          faultCategory: 'application',
          evidence: [],
          suggestedFix: 'Fix the basket.',
          confidence: 'medium',
        },
      },
    );
    const [tc] = cases(render(state([done('Place an order', r)])));
    const failure = child(tc!, 'failure')!;
    expect(failure.attrs).toEqual({ type: 'step', message: 'Step 2: Verify the total is "42.00"' });
    expect(failure.text).toBe(
      [
        'Step 2: Verify the total is "42.00"',
        'Expected "42.00" but saw "24.00".',
        'Report: order.html#step-2',
        'Cause: The total was not updated.',
        'Category: application',
      ].join('\n'),
    );
  });

  describe('a step that ran more than once', () => {
    const pass = (index: number, extra: Partial<StepResult> = {}): StepResult =>
      step(3, 'Check #item', {
        loop: { kind: 'iteration', label: 'Each item', index, count: 3, values: {} },
        ...extra,
      });

    it('links to the card of the loop pass that failed, not the first pass', () => {
      const r = report([pass(1), pass(2), pass(3, { status: 'failed', error: 'Not there.' })]);
      const [tc] = cases(render(state([done('Place an order', r)])));
      expect(child(tc!, 'failure')!.text).toBe('Step 3: Check #item\nNot there.\nReport: order.html#step-3-3');
    });

    it('links to the pass that failed within its row, in a data-driven test', () => {
      const r = report(
        [
          pass(1, { dataRow: 1 }),
          pass(2, { dataRow: 1 }),
          pass(1, { dataRow: 2 }),
          pass(2, { dataRow: 2, status: 'failed', error: 'Not there.' }),
        ],
        {
          rows: [
            { index: 1, values: {}, status: 'passed', durationMs: 1, tokensUsed: 0 },
            { index: 2, values: {}, status: 'failed', durationMs: 1, tokensUsed: 0 },
          ],
        },
      );
      const tcs = cases(render(state([done('Place an order', r)])));
      expect(child(tcs[1]!, 'failure')!.text).toBe(
        'Step 3: Check #item\nNot there.\nReport: order.html#row-2-step-3-2',
      );
    });
  });

  it('names a failing hook line by its scope, not as a step', () => {
    const r = report([
      step(0, 'Sign in', { hookScope: 'before', hookIndex: 1 }),
      step(1, 'Open the shop'),
      step(1, 'Clear the cart', { hookScope: 'beforeEach', hookIndex: 1 }),
      step(2, 'Clear the cart', { hookScope: 'beforeEach', hookIndex: 1, status: 'failed', error: 'No cart.' }),
    ]);
    const [tc] = cases(render(state([done('Place an order', r)])));
    const failure = child(tc!, 'failure')!;
    expect(failure.attrs).toEqual({ type: 'step', message: 'beforeEach hook: Clear the cart' });
    expect(failure.text).toBe(
      'beforeEach hook: Clear the cart\nNo cart.\nReport: order.html#hook-beforeEach-1-step-2',
    );
  });

  it('is a run error when the test failed before any step failed', () => {
    const r = report([], { status: 'failed', error: 'The code-behind file could not be loaded.\nSecond line.' });
    const [tc] = cases(render(state([done('Place an order', r)])));
    const error = child(tc!, 'error')!;
    expect(error.attrs).toEqual({ type: 'run', message: 'The code-behind file could not be loaded.' });
    expect(error.text).toBe('The code-behind file could not be loaded.\nSecond line.\nReport: order.html');
  });

  it('is a stopped error when the user stopped the test', () => {
    const r = report(
      [step(1, 'Open the shop'), step(2, 'Wait for the order', { status: 'failed', interrupted: true })],
      { aborted: true, status: 'passed' },
    );
    const [tc] = cases(render(state([done('Place an order', r)])));
    expect(child(tc!, 'failure')).toBeUndefined();
    const error = child(tc!, 'error')!;
    expect(error.attrs.type).toBe('stopped');
    expect(error.text).toContain('Report: order.html#step-2');
  });

  it('does not fail on a tolerated failure, and counts it', () => {
    const r = report([
      step(1, 'Close the banner', { status: 'failed', tolerated: true, error: 'No banner.' }),
      step(2, 'Open the shop'),
    ]);
    const [tc] = cases(render(state([done('Place an order', r)])));
    expect(child(tc!, 'failure')).toBeUndefined();
    expect(props(tc!).toleratedSteps).toBe('1');
  });

  it('reports the first untolerated failure, past a tolerated one', () => {
    const r = report([
      step(1, 'Close the banner', { status: 'failed', tolerated: true }),
      step(2, 'Open the shop', { status: 'failed', error: 'Gone.' }),
    ]);
    const [tc] = cases(render(state([done('Place an order', r)])));
    expect(child(tc!, 'failure')!.attrs.message).toBe('Step 2: Open the shop');
  });

  it('counts skipped steps apart from the steps that ran', () => {
    const r = report(
      [step(1, 'Open the shop'), step(2, 'Pay', { status: 'skipped' }), step(3, 'Leave', { status: 'skipped' })],
      { skippedSteps: 2 },
    );
    const [tc] = cases(render(state([done('Place an order', r)])));
    expect(child(tc!, 'skipped')).toBeUndefined();
    expect(props(tc!)).toMatchObject({ steps: '1', skippedSteps: '2' });
  });

  it('leaves hook lines out of the step counts', () => {
    const r = report([
      step(0, 'Sign in', { hookScope: 'before', hookIndex: 1 }),
      step(1, 'Open the shop', { fromCodeBehind: true }),
    ]);
    const [tc] = cases(render(state([done('Place an order', r)])));
    expect(props(tc!)).toMatchObject({ steps: '1', stepsFromCode: '1' });
  });

  describe('a data-driven test', () => {
    const rows: RowSummaryLine[] = [
      { index: 1, values: { plan: 'basic' }, status: 'passed', durationMs: 18220, tokensUsed: 0, videoRelPath: 'videos/order-row1.webm' },
      { index: 2, values: { plan: 'pro' }, status: 'failed', durationMs: 19870, tokensUsed: 900 },
      { index: 3, values: { plan: 'team' }, status: 'skipped', notRunReason: 'stopped', durationMs: 0, tokensUsed: 0 },
    ];
    const r = report(
      [
        step(1, 'Choose the plan', { dataRow: 1, fromCodeBehind: true }),
        step(2, 'Verify the total', { dataRow: 1 }),
        step(1, 'Choose the plan', { dataRow: 2 }),
        step(2, 'Verify the total', { dataRow: 2, status: 'failed', error: 'Expected 42.' }),
      ],
      {
        rows,
        diagnosis: {
          rootCause: 'Not for any one row.',
          faultCategory: 'flake',
          evidence: [],
          suggestedFix: '',
          confidence: 'low',
        },
      },
    );

    it('writes one testcase per row, a failed row and a row --bail did not reach', () => {
      const tcs = cases(render(state([done('Place an order', r, 'out/order.html')], { bailed: true })));
      expect(tcs.map((t) => t.attrs.name)).toEqual([
        'Place an order [row 1]',
        'Place an order [row 2]',
        'Place an order [row 3]',
      ]);
      expect(tcs.map((t) => t.attrs.time)).toEqual(['18.220', '19.870', '0.000']);

      expect(props(tcs[0]!)).toEqual({
        report: 'out/order.html',
        tokens: '0',
        steps: '2',
        stepsFromCode: '1',
        video: 'out/videos/order-row1.webm',
        'row.plan': 'basic',
      });
      expect(child(tcs[0]!, 'system-out')!.text).toBe(
        '[[ATTACHMENT|out/order.html]]\n[[ATTACHMENT|out/videos/order-row1.webm]]',
      );

      const failure = child(tcs[1]!, 'failure')!;
      expect(failure.attrs.message).toBe('Step 2: Verify the total');
      // The report's one diagnosis does not say which row it is about.
      expect(failure.text).toBe('Step 2: Verify the total\nExpected 42.\nReport: out/order.html#row-2-step-2');

      expect(child(tcs[2]!, 'skipped')!.attrs.message).toBe(
        'Not run: the run stopped at the first failure (--bail).',
      );
      expect(child(tcs[2]!, 'properties')).toBeUndefined();
    });
  });

  describe('healed steps', () => {
    const r = report(
      [
        step(1, 'Open the shop', { fromCodeBehind: true }),
        step(2, 'Add #item', {
          codeBehindStale: { file: 'unused', source: 'Add #item', error: 'No such element.' },
        }),
      ],
      { healedSteps: 1 },
    );

    it('are a pass, recorded in the properties', () => {
      const [tc] = cases(render(state([done('Place an order', r)])));
      expect(child(tc!, 'failure')).toBeUndefined();
      expect(props(tc!).healedSteps).toBe('1');
    });

    it('are a failure naming the steps under --fail-on-healed', () => {
      const [tc] = cases(render(state([done('Place an order', r)], { failOnHealed: true })));
      const failure = child(tc!, 'failure')!;
      expect(failure.attrs.type).toBe('healed');
      expect(failure.attrs.message).toBe('1 step healed (--fail-on-healed): step 2');
      expect(failure.text).toContain('Step 2: Add #item');
    });

    it('fail only the row that healed, in a data-driven test', () => {
      const dd = report(
        [
          step(1, 'Add #item', { dataRow: 1 }),
          step(1, 'Add #item', {
            dataRow: 2,
            codeBehindStale: { file: 'unused', source: 'Add #item', error: 'No such element.' },
          }),
        ],
        {
          rows: [
            { index: 1, values: {}, status: 'passed', durationMs: 1, tokensUsed: 0 },
            { index: 2, values: {}, status: 'passed', durationMs: 1, tokensUsed: 0 },
          ],
          healedSteps: 1,
        },
      );
      const tcs = cases(render(state([done('Place an order', dd)], { failOnHealed: true })));
      expect(child(tcs[0]!, 'failure')).toBeUndefined();
      expect(child(tcs[1]!, 'failure')!.attrs.type).toBe('healed');
    });
  });

  describe('tests that did not run', () => {
    it('are errors while the run goes on', () => {
      const [tc] = cases(render(state([notRun('Later')], { finished: false })));
      expect(child(tc!, 'error')!.attrs).toEqual({
        type: 'not-run',
        message: 'The run ended before this test ran.',
      });
      expect(tc!.attrs).toMatchObject({ name: 'Later', classname: 'tests/later.md', time: '0.000' });
    });

    it('are errors when the run finished without a bail', () => {
      const [tc] = cases(render(state([notRun('Later')], { finished: true })));
      expect(child(tc!, 'error')!.attrs.type).toBe('not-run');
    });

    it('stay errors while a bail is known but the run has not ended', () => {
      const [tc] = cases(render(state([notRun('Later')], { finished: false, bailed: true })));
      expect(child(tc!, 'error')!.attrs.type).toBe('not-run');
    });

    it('are skipped once the run has ended after a bail', () => {
      const [tc] = cases(render(state([notRun('Later')], { finished: true, bailed: true })));
      expect(child(tc!, 'error')).toBeUndefined();
      expect(child(tc!, 'skipped')!.attrs.message).toBe(
        'Not run: the run stopped at the first failure (--bail).',
      );
    });

    it('a data-driven test not yet run is one testcase under its title', () => {
      const tcs = cases(render(state([notRun('Place an order')], { finished: false })));
      expect(tcs.map((t) => t.attrs.name)).toEqual(['Place an order']);
    });
  });

  it('writes a parse error named after the file, and a run error with its message', () => {
    const xml = render(
      state([
        { title: 'tests/broken.md', file: 'tests/broken.md', tags: [], state: 'parseError', message: 'Unknown skill "Ada".' },
        { title: 'Place an order', file: 'tests/order.md', tags: [], state: 'runError', message: 'Data file not found: rows.csv' },
        notRun('Later'),
      ]),
    );
    const [parse, run, later] = cases(xml);
    expect(parse!.attrs.name).toBe('tests/broken.md');
    expect(child(parse!, 'error')!.attrs).toEqual({ type: 'parse', message: 'Unknown skill "Ada".' });
    expect(child(parse!, 'error')!.text).toBe('Unknown skill "Ada".');
    expect(child(run!, 'error')!.attrs).toEqual({ type: 'run', message: 'Data file not found: rows.csv' });
    expect(child(later!, 'error')!.attrs.type).toBe('not-run');
  });

  it('writes an empty suite for a run with no tests', () => {
    const suites = parseXml(render(state([])));
    expect(suites.attrs).toMatchObject({ tests: '0', failures: '0', errors: '0', skipped: '0' });
  });

  it('escapes markup, drops forbidden characters and colour codes in steps, errors and row values', () => {
    const nasty = 'a <b> & "c" \'d\'\u0001 \u001b[31mred\u001b[0m\uFFFE';
    const clean = 'a <b> & "c" \'d\' red';
    const r = report([step(1, nasty, { status: 'failed', error: nasty, dataRow: 1 })], {
      rows: [{ index: 1, values: { [`col`]: nasty }, status: 'failed', durationMs: 1, tokensUsed: 0 }],
    });
    const xml = render(state([done(nasty, r)]));
    expect(xml).not.toContain('\u001b');
    expect(xml).not.toContain('[31m');
    const [tc] = cases(xml);
    expect(tc!.attrs.name).toBe(`${clean} [row 1]`);
    const failure = child(tc!, 'failure')!;
    expect(failure.attrs.message).toBe(`Step 1: ${clean}`);
    expect(failure.text.split('\n').slice(0, 2)).toEqual([`Step 1: ${clean}`, clean]);
    expect(props(tc!)['row.col']).toBe(clean);
  });

  it('keeps newlines in an attribute as character references', () => {
    const r = report([step(1, 'First line\nsecond line', { status: 'failed' })]);
    const xml = render(state([done('Place an order', r)]));
    expect(xml).toContain('message="Step 1: First line&#10;second line"');
    expect(child(cases(xml)[0]!, 'failure')!.attrs.message).toBe('Step 1: First line\nsecond line');
  });

  it('writes a masked value as it was given', () => {
    const r = report([step(1, 'Type *** into #password', { status: 'failed', error: 'Rejected ***.', dataRow: 1 })], {
      rows: [{ index: 1, values: { password: '***' }, status: 'failed', durationMs: 1, tokensUsed: 0 }],
    });
    const [tc] = cases(render(state([done('Sign in', r)])));
    expect(child(tc!, 'failure')!.text).toContain('Type *** into #password\nRejected ***.');
    expect(props(tc!)['row.password']).toBe('***');
  });

  it('never reads as clean while the run is unfinished and a test is outstanding', () => {
    const passed = done('Place an order', report([step(1, 'Open the shop')]));
    const healed = done(
      'Healed',
      report([step(1, 'Add #item', { codeBehindStale: { file: 'unused', source: 'x', error: 'y' } })]),
    );
    const variants: RunState[] = [
      state([notRun('Later')], { finished: false }),
      state([passed, notRun('Later')], { finished: false }),
      state([passed, healed, notRun('Later'), notRun('Last', 'tests/last.md')], { finished: false }),
      state([passed, notRun('Later')], { finished: false, bailed: true }),
      state([notRun('Data-driven, rows unknown')], { finished: false, failOnHealed: true }),
    ];
    for (const s of variants) {
      const suites = parseXml(render(s));
      expect(suites.attrs.failures === '0' && suites.attrs.errors === '0').toBe(false);
    }
  });
});
