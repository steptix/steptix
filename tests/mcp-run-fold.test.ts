import { describe, it, expect } from 'vitest';
import { foldRun, type FoldInput } from '../src/mcp/run-fold.js';
import type { FrameInfo } from '../src/server/session-manager.js';
import type { RunEvent } from '../src/mcp/types.js';

// ---------------------------------------------------------------------------
// The fold turns "what executed" into "what you asked for", and those two
// lists are different whenever the server expands a skill or a section, or
// when a conditional group runs. Nearly every case below is one where the
// obvious implementation reports something false — a passing branch as never
// executed, a human-gated step as passed, one section invocation overwriting
// the other.
// ---------------------------------------------------------------------------

const TEST_FILE = 'c:/proj/tests/checkout.md';

function fold(partial: Partial<FoldInput> & { events: RunEvent[] }) {
  return foldRun({
    streamDropped: false,
    sentSteps: ['step one', 'step two', 'step three'],
    sourceLines: [10, 11, 12],
    testFilePath: TEST_FILE,
    expansionPossible: false,
    // The fold has no default of its own — `readRunSettings` resolves the tool
    // argument, so a second fallback here would be a second default to drift.
    // These cases are about the fold's mechanics, so `'none'` keeps the image
    // out of the way unless a case asks for one.
    screenshotsReturn: 'none',
    ...partial,
  });
}

const rootFrame: FrameInfo = {
  id: '',
  parentId: null,
  kind: 'test',
  uri: TEST_FILE,
  line: 0,
};

function skillFrame(id: string, line: number, name: string): FrameInfo {
  // `line` is the invocation site in the test file — the only link an expanded
  // step keeps back to the step the agent actually sent.
  return { id, parentId: '', kind: 'skill', uri: 'c:/proj/skills/login.md', line, skillName: name };
}

describe('root vs expanded steps', () => {
  it('treats an absent frame as a root step', () => {
    // The server omits `frame` entirely when nothing expanded, which is the
    // common case once skillsDir is only sent when it exists on disk.
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10 },
        { type: 'done', status: 'passed' },
      ],
      sentSteps: ['step one'],
      sourceLines: [10],
    });

    expect(result.steps[0]).toMatchObject({
      sentIndex: 0,
      text: 'step one',
      frameKind: 'test',
      uri: TEST_FILE,
      status: 'passed',
    });
  });

  it('treats the synthesized root frame as root, not as an expansion', () => {
    // The server synthesizes `{id:'', kind:'test', line:0}` whenever expansion
    // ran, so "has a frame" would wrongly classify every step as expanded.
    const result = fold({
      events: [
        { type: 'step:start', line: 11, frame: rootFrame },
        { type: 'step:pass', line: 11, frame: rootFrame },
        { type: 'done', status: 'passed' },
      ],
      expansionPossible: true,
    });

    const row = result.steps.find((s) => s.line === 11);
    expect(row).toMatchObject({ sentIndex: 1, text: 'step two', frameKind: 'test' });
  });

  it('maps an expanded step back to the step that invoked it', () => {
    const frame = skillFrame('f1', 11, 'login');
    const result = fold({
      events: [
        { type: 'frame:push', frame },
        { type: 'step:start', line: 3, frame },
        { type: 'step:pass', line: 3, frame },
        { type: 'done', status: 'passed' },
      ],
      expansionPossible: true,
    });

    const row = result.steps.find((s) => s.frameKind === 'skill');
    expect(row).toMatchObject({
      sentIndex: 1,
      frameName: 'login',
      uri: 'c:/proj/skills/login.md',
      line: 3,
      // The skill body is a file the agent never sent, so we have no text to
      // show — uri + line + frameName is the identifier.
      text: null,
    });
  });

  it('keeps two invocations of one section apart', () => {
    // A line-keyed map would collapse these into one row, losing the fact
    // that the second invocation failed.
    const frame: FrameInfo = {
      id: 'sec1',
      parentId: '',
      kind: 'section',
      uri: TEST_FILE,
      line: 10,
      skillName: 'Log in',
    };
    const frame2: FrameInfo = { ...frame, id: 'sec2', line: 12 };

    const result = fold({
      events: [
        { type: 'frame:push', frame },
        { type: 'step:start', line: 20, frame },
        { type: 'step:pass', line: 20, frame },
        { type: 'frame:push', frame: frame2 },
        { type: 'step:start', line: 20, frame: frame2 },
        { type: 'step:fail', line: 20, frame: frame2, error: 'second time failed' },
        { type: 'done', status: 'failed' },
      ],
      expansionPossible: true,
    });

    const sectionRows = result.steps.filter((s) => s.frameKind === 'section');
    expect(sectionRows).toHaveLength(2);
    expect(sectionRows[0]?.status).toBe('passed');
    expect(sectionRows[1]?.status).toBe('failed');
    expect(sectionRows[0]?.sentIndex).toBe(0);
    expect(sectionRows[1]?.sentIndex).toBe(2);
  });
});

describe('steps with no events', () => {
  it('never reports not-run on a passing run', () => {
    // A conditional group emits nothing at all. On a passing run, "no events"
    // means we cannot see it, not that it was skipped — claiming otherwise
    // reports a passing branch as never executed.
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10 },
        { type: 'done', status: 'passed' },
      ],
    });

    const statuses = result.steps.map((s) => s.status);
    expect(statuses).not.toContain('not-run');
    expect(statuses.filter((s) => s === 'unknown')).toHaveLength(2);
    expect(result.warnings.join(' ')).toContain('could not be attributed');
  });

  it('reports not-run only for steps after the failure', () => {
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10 },
        { type: 'step:start', line: 11 },
        { type: 'step:fail', line: 11, error: 'boom' },
        { type: 'done', status: 'failed' },
      ],
    });

    expect(result.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'not-run']);
    expect(result.error).toBe('boom');
  });

  it('reports unknown, not not-run, for a gap before the failure', () => {
    // A conditional group early in a run that later fails: the gap is at
    // index 0, which the run clearly moved past.
    const result = fold({
      events: [
        { type: 'step:start', line: 11 },
        { type: 'step:pass', line: 11 },
        { type: 'step:start', line: 12 },
        { type: 'step:fail', line: 12, error: 'boom' },
        { type: 'done', status: 'failed' },
      ],
    });

    const byIndex = new Map(result.steps.map((s) => [s.sentIndex, s.status]));
    expect(byIndex.get(0)).toBe('unknown');
    expect(byIndex.get(1)).toBe('passed');
    expect(byIndex.get(2)).toBe('failed');
  });

  it('claims nothing about un-executed steps when the stream dropped', () => {
    // The run may still be executing server-side, so "did not run" would be a
    // lie in the same payload that says so.
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10 },
      ],
      streamDropped: true,
    });

    expect(result.status).toBe('error');
    expect(result.steps.map((s) => s.status)).not.toContain('not-run');
    expect(result.warnings.join(' ')).toContain('may still be executing');
  });

  it('places synthetic rows in run order', () => {
    const result = fold({
      events: [
        { type: 'step:start', line: 12 },
        { type: 'step:pass', line: 12 },
        { type: 'done', status: 'passed' },
      ],
    });

    expect(result.steps.map((s) => s.sentIndex)).toEqual([0, 1, 2]);
    expect(result.steps.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('adds no synthetic rows when sourceLines had to be omitted', () => {
    // Without them there is no position to place a row at, and no way to know
    // which sent step it would stand for.
    const result = fold({
      events: [
        { type: 'step:start', line: 1 },
        { type: 'step:pass', line: 1 },
        { type: 'done', status: 'passed' },
      ],
      sourceLines: undefined,
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.sentIndex).toBe(0);
  });

  it('cannot recover sentIndex without sourceLines when expansion was possible', () => {
    const result = fold({
      events: [
        { type: 'step:start', line: 1 },
        { type: 'step:pass', line: 1 },
        { type: 'done', status: 'passed' },
      ],
      sourceLines: undefined,
      expansionPossible: true,
    });

    expect(result.steps[0]).toMatchObject({ sentIndex: null, text: null });
  });
});

describe('step outcomes', () => {
  it('maps output "skipped" to skipped, not passed', () => {
    // `[input:]` and `[interactive]` steps come back as step:pass with this
    // output. Reporting them passed is a false green on work nobody did.
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10, output: 'skipped' },
        { type: 'done', status: 'passed' },
      ],
      sentSteps: ['[input: password]'],
      sourceLines: [10],
    });

    expect(result.steps[0]?.status).toBe('skipped');
    expect(result.warnings.join(' ')).toContain('need a human');
  });

  it('marks a step that started but never terminated as unknown', () => {
    const result = fold({
      events: [{ type: 'step:start', line: 10 }],
      streamDropped: true,
      sentSteps: ['step one'],
      sourceLines: [10],
    });

    expect(result.steps[0]).toMatchObject({ status: 'unknown', durationMs: null });
  });

  it('measures duration from the arrival times the client recorded', () => {
    // The fold walks a finished array, so it cannot time anything itself —
    // reading the clock here would give every step the same instant and
    // report a confident zero. A real run did exactly that before the client
    // started stamping arrivals.
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10 },
        { type: 'done', status: 'passed' },
      ],
      receivedAt: [1_000, 3_500, 3_600],
      sentSteps: ['step one'],
      sourceLines: [10],
    });

    expect(result.steps[0]?.durationMs).toBe(2_500);
  });

  it('reports duration as unknown rather than zero when no arrival times exist', () => {
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10 },
        { type: 'done', status: 'passed' },
      ],
      sentSteps: ['step one'],
      sourceLines: [10],
    });

    expect(result.steps[0]?.durationMs).toBeNull();
  });

  it('carries fromCache through', () => {
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10, fromCache: true },
        { type: 'done', status: 'passed' },
      ],
      sentSteps: ['step one'],
      sourceLines: [10],
    });

    expect(result.steps[0]?.fromCache).toBe(true);
  });
});

describe('run-level reporting', () => {
  it('falls back to an error output when no step failed', () => {
    // A bad env name, a tool-catalogue load failure or a skill-expansion
    // failure produce no step:fail at all — their only text is an output
    // event, emitted before any step started.
    const result = fold({
      events: [
        { type: 'output', msg: 'Environment file not found: .env.nope', kind: 'error' },
        { type: 'done', status: 'error' },
      ],
    });

    expect(result.error).toContain('Environment file not found');
    expect(result.messages).toHaveLength(1);
  });

  it('reports no error on a passing run, even after a retried failure', () => {
    // Caught live: the runner retries a failed action and emits an `output` of
    // kind error per attempt, so a run that recovered and passed still leaves
    // error text in the stream. A real duckduckgo run came back as
    // `status: "passed"` with `error: "Action failed [wait]: Timeout..."`,
    // which reads as a broken test that isn't.
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'output', msg: 'Action failed [wait]: Timeout 10000ms exceeded', kind: 'error' },
        { type: 'step:pass', line: 10 },
        { type: 'done', status: 'passed' },
      ],
      sentSteps: ['click the thing'],
      sourceLines: [10],
    });

    expect(result.status).toBe('passed');
    expect(result.error).toBeNull();
    // Still discoverable by anyone who wants it.
    expect(result.messages.map((m) => m.text).join(' ')).toContain('Timeout');
  });

  it('prefers a step failure over an error output', () => {
    const result = fold({
      events: [
        { type: 'output', msg: 'some earlier noise', kind: 'error' },
        { type: 'step:start', line: 10 },
        { type: 'step:fail', line: 10, error: 'the real failure' },
        { type: 'done', status: 'failed' },
      ],
    });

    expect(result.error).toBe('the real failure');
  });

  it('keeps only warn and error messages, capped', () => {
    const events: RunEvent[] = [];
    for (let i = 0; i < 80; i++) {
      events.push({ type: 'output', msg: `warn ${i}`, kind: 'warn' });
    }
    events.push({ type: 'output', msg: 'chatty info line', kind: 'info' });
    events.push({ type: 'done', status: 'passed' });

    const result = fold({ events });

    expect(result.messages).toHaveLength(50);
    expect(result.messages.at(-1)?.text).toBe('warn 79');
    expect(result.messages.some((m) => m.text.includes('chatty'))).toBe(false);
  });

  it('takes reportPath off the done event when it is there', () => {
    // The emitter spreads it in, so it is on the wire even though RunEvent
    // does not declare it.
    const result = fold({
      events: [
        { type: 'done', status: 'passed', reportPath: 'c:/proj/reports/x.html' } as RunEvent,
      ],
    });

    expect(result.reportPath).toBe('c:/proj/reports/x.html');
  });

  it('records captures with last-write-wins', () => {
    const result = fold({
      events: [
        { type: 'capture', line: 10, name: 'orderId', value: 'first', source: 'capture' },
        { type: 'capture', line: 11, name: 'orderId', value: 'second', source: 'toolOutput' },
        { type: 'done', status: 'passed' },
      ],
    });

    expect(result.captures).toEqual({ orderId: 'second' });
  });

  it('surfaces frames the reader could not parse as warnings', () => {
    const result = fold({
      events: [{ type: 'done', status: 'passed' }],
      dropped: ['unparseable frame: {oops'],
    });

    expect(result.warnings).toContain('unparseable frame: {oops');
  });
});

describe('screenshots', () => {
  const png = `data:image/png;base64,${'A'.repeat(100)}`;

  it('is omitted under none, even with one available', () => {
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:fail', line: 10, error: 'x', screenshot: png },
        { type: 'done', status: 'failed' },
      ],
      screenshotsReturn: 'none',
    });

    expect(result.screenshotBase64).toBeNull();
  });

  it('strips the data URI prefix when requested', () => {
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:fail', line: 10, error: 'x', screenshot: png },
        { type: 'done', status: 'failed' },
      ],
      screenshotsReturn: 'on-failure',
    });

    expect(result.screenshotBase64).toBe('A'.repeat(100));
  });

  it('drops an oversized image with a warning rather than silently', () => {
    const huge = `data:image/png;base64,${'A'.repeat(1_600_000)}`;
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:fail', line: 10, error: 'x', screenshot: huge },
        { type: 'done', status: 'failed' },
      ],
      screenshotsReturn: 'on-failure',
    });

    expect(result.screenshotBase64).toBeNull();
    expect(result.warnings.join(' ')).toContain('Screenshot dropped');
  });

  it('ignores a passing step screenshot under on-failure', () => {
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10, screenshot: png },
        { type: 'done', status: 'passed' },
      ],
      screenshotsReturn: 'on-failure',
    });

    expect(result.screenshotBase64).toBeNull();
    // And says nothing about it: asking for the failure shot on a run that
    // never failed is the happy path, not a problem to report.
    expect(result.warnings.join(' ')).not.toMatch(/screenshot/i);
  });

  // `final` is the mode that needs the capture setting, so these three cover
  // the coupling the tool description warns about.
  it('returns a passing run\'s last screenshot under final', () => {
    const later = `data:image/png;base64,${'B'.repeat(100)}`;
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10, screenshot: png },
        { type: 'step:start', line: 11 },
        { type: 'step:pass', line: 11, screenshot: later },
        { type: 'done', status: 'passed' },
      ],
      screenshotsReturn: 'final',
    });

    // The LAST one seen, not the first: "how did the run leave the page?"
    expect(result.screenshotBase64).toBe('B'.repeat(100));
  });

  it('returns the failure shot under final when the run ended on a failure', () => {
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:fail', line: 10, error: 'x', screenshot: png },
        { type: 'done', status: 'failed' },
      ],
      screenshotsReturn: 'final',
    });

    expect(result.screenshotBase64).toBe('A'.repeat(100));
  });

  it('warns, naming capture, when final has nothing to return', () => {
    // A passing step carries no screenshot at all unless per-action capture is
    // on. Returning nothing in silence would leave the caller to work that out.
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:pass', line: 10 },
        {
          type: 'done',
          status: 'passed',
          effectiveSettings: {
            model: 'test-model',
            capture: 'none',
            fullPage: false,
            sendScreenshots: false,
            sources: { model: 'server', capture: 'session', fullPage: 'server', sendScreenshots: 'server' },
          },
        },
      ],
      screenshotsReturn: 'final',
    });

    expect(result.screenshotBase64).toBeNull();
    expect(result.warnings.join(' ')).toContain('capture');
    expect(result.warnings.join(' ')).toContain('"none"');
  });

  it('warns when a failure produced no screenshot', () => {
    const result = fold({
      events: [
        { type: 'step:start', line: 10 },
        { type: 'step:fail', line: 10, error: 'x' },
        { type: 'done', status: 'failed' },
      ],
      screenshotsReturn: 'on-failure',
    });

    expect(result.screenshotBase64).toBeNull();
    expect(result.warnings.join(' ')).toContain('capture');
  });
});

describe('effectiveSettings on the done event', () => {
  const settings = {
    model: 'aibroker/google/gemini-3-flash',
    capture: 'every-step' as const,
    fullPage: true,
    sendScreenshots: false,
    ai: 'on' as const,
    aiOffReason: null,
    sources: {
      model: 'session' as const,
      capture: 'session' as const,
      fullPage: 'project' as const,
      sendScreenshots: 'server' as const,
      ai: 'server' as const,
    },
  };

  it('passes the server\'s report through, with the return mode added', () => {
    const result = fold({
      events: [{ type: 'done', status: 'passed', effectiveSettings: settings }],
      screenshotsReturn: 'final',
    });

    expect(result.effectiveSettings).toEqual({ ...settings, screenshotsReturn: 'final' });
  });

  it('nulls the server half when an older server omits it', () => {
    // The regression this guards: a missing key fails `structuredContent`
    // validation outright, which would degrade the whole run result to an error
    // with nothing readable in it — at the end of a run that worked.
    const result = fold({
      events: [{ type: 'done', status: 'passed' }],
      screenshotsReturn: 'on-failure',
    });

    expect(result.effectiveSettings).toEqual({
      model: null,
      capture: null,
      fullPage: null,
      sendScreenshots: null,
      ai: null,
      aiOffReason: null,
      sources: null,
      // Never null: this side always knows what it was told, whatever the
      // server did or did not report.
      screenshotsReturn: 'on-failure',
    });
  });

  it('keeps the four §§1–8 fields when a server predating the AI switch omits ai', () => {
    // The older-server rule applied to §9's own addition. Rejecting the frame
    // over a missing `ai` would throw away the four settings that server DID
    // report — a strictly worse answer than the one it sent.
    const { ai: _ai, aiOffReason: _reason, sources, ...older } = settings;
    const { ai: _aiSource, ...olderSources } = sources;
    const result = fold({
      events: [
        {
          type: 'done',
          status: 'passed',
          effectiveSettings: { ...older, sources: olderSources },
        } as unknown as RunEvent,
      ],
      screenshotsReturn: 'none',
    });

    expect(result.effectiveSettings?.model).toBe(settings.model);
    expect(result.effectiveSettings?.capture).toBe('every-step');
    expect(result.effectiveSettings?.sources?.model).toBe('session');
    // Null, not 'on': "the server did not say" and "the server said yes" are
    // different claims, and only one of them is true here.
    expect(result.effectiveSettings?.ai).toBeNull();
    expect(result.effectiveSettings?.aiOffReason).toBeNull();
    expect(result.effectiveSettings?.sources?.ai).toBeNull();
  });

  it('carries the off reason through, so policy and no-key stay apart', () => {
    const result = fold({
      events: [
        {
          type: 'done',
          status: 'passed',
          effectiveSettings: {
            ...settings,
            ai: 'off',
            aiOffReason: 'policy',
            sources: { ...settings.sources, ai: 'session' },
          },
        } as unknown as RunEvent,
      ],
      screenshotsReturn: 'none',
    });

    expect(result.effectiveSettings?.ai).toBe('off');
    expect(result.effectiveSettings?.aiOffReason).toBe('policy');
    expect(result.effectiveSettings?.sources?.ai).toBe('session');
  });

  it('treats a malformed report as not reported', () => {
    const result = fold({
      events: [
        {
          type: 'done',
          status: 'passed',
          // `sources` half-filled — exactly what a mid-branch server would send.
          effectiveSettings: { ...settings, sources: { model: 'session' } },
        } as unknown as RunEvent,
      ],
    });

    expect(result.effectiveSettings?.model).toBeNull();
    expect(result.effectiveSettings?.sources).toBeNull();
  });
});
