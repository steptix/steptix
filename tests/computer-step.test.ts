/**
 * The computer-mode turn loop — docs/specs/SPEC-use-computer.md §5.4, §5.5,
 * and acceptance items 3 and 4.
 *
 * Driven end to end: the real `executeComputerStep`, the real action parser,
 * the real capture/zoom mapping, and `FakeDesktopAdapter` at the bottom. The
 * only thing faked above it is the model, because the whole subject here is
 * what the loop DOES with a given answer.
 *
 * Grabs are deliberately small (800×600, downscaled to 400). A default
 * `makeFakeGrab` is 3440×1440 — 19 MB of RGBA per capture, PNG-encoded once
 * per turn — and this file takes a dozen of them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Config } from '../src/config/types.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { AiClient } from '../src/ai/client.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { FakeDesktopAdapter, fakeWindow, makeFakeGrab } from '../src/desktop/fake-adapter.js';
import { mapToScreen, viewFromGrab } from '../src/desktop/index.js';
import {
  executeComputerStep,
  guardVisitReadsScreen,
  resetComputerScreenshotNotice,
  stepReadsScreen,
  undispatchedDirectiveError,
  type ComputerStepOptions,
} from '../src/runner/computer-step.js';
import { createControlState, type ControlRecord } from '../src/runner/control-flow.js';
import { parseFailureTail } from '../src/parser/failure-tail.js';
import { logger } from '../src/utils/logger.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GRAB = { width: 800, height: 600 } as const;
const MAX_IMAGE_WIDTH = 400;

interface Scripted {
  client: AiClient;
  /** Every message list the loop sent, so a test can look at what the model
   *  was shown rather than only at what it answered. */
  sent: ChatMessage[][];
}

/** A model that answers from a script; the last entry repeats for ever, which
 *  is what lets the stall test hand it one answer and get three turns. An
 *  `Error` entry is thrown instead of answered — a failed model call. */
function scripted(...responses: Array<string | Error>): Scripted {
  const sent: ChatMessage[][] = [];
  let at = 0;
  const client = {
    complete: async (messages: ChatMessage[]) => {
      sent.push(messages);
      const entry = responses[Math.min(at, responses.length - 1)] ?? '{"action":"noop"}';
      at++;
      if (entry instanceof Error) throw entry;
      return { text: entry, model: 'fake-model' };
    },
  };
  return { client: client as unknown as AiClient, sent };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: true, ...(overrides.ai ?? {}) },
    execution: {
      ...DEFAULT_CONFIG.execution,
      retries: 0,
      maxTurns: 6,
      promptOnAmbiguity: true,
      ...(overrides.execution ?? {}),
    },
    logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  } as Config;
}

/** A config with these `execution` values over the harness defaults. */
function execWith(overrides: Partial<Config['execution']>): Config {
  return makeConfig({
    execution: {
      ...DEFAULT_CONFIG.execution,
      retries: 0,
      maxTurns: 6,
      promptOnAmbiguity: true,
      ...overrides,
    } as Config['execution'],
  });
}

function makeOpts(
  adapter: FakeDesktopAdapter,
  client: AiClient,
  overrides: Partial<ComputerStepOptions> = {},
): ComputerStepOptions {
  return {
    page: undefined as never,
    config: makeConfig(),
    aiClient: client,
    contextContent: '',
    testName: `computer-step-test-${Math.random()}`,
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
    nonInteractive: true,
    computer: {
      adapter,
      settleMs: 0,
      maxImageWidth: MAX_IMAGE_WIDTH,
      reportScreenshots: true,
    },
    ...overrides,
  } as ComputerStepOptions;
}

/** The logical screen point an image point maps to, computed the way the
 *  runtime computes it — so the assertion checks the LOOP's wiring, not a
 *  hand-copied arithmetic result that would drift with `mapToScreen`. */
async function expectedScreenPoint(
  image: { x: number; y: number },
  spec: Parameters<typeof makeFakeGrab>[0] = GRAB,
): Promise<{ x: number; y: number }> {
  const view = await viewFromGrab(makeFakeGrab(spec), { maxImageWidth: MAX_IMAGE_WIDTH });
  return mapToScreen(image, view);
}

/** Every image block in the last message of a request. */
function imagesIn(messages: ChatMessage[]): string[] {
  const user = messages[messages.length - 1]!;
  if (typeof user.content === 'string') return [];
  return user.content
    .filter((b): b is { type: 'image_url'; image_url: { url: string } } => b.type === 'image_url')
    .map((b) => b.image_url.url);
}

/** The text of the last message of a request. */
function textIn(messages: ChatMessage[]): string {
  const user = messages[messages.length - 1]!;
  if (typeof user.content === 'string') return user.content;
  return user.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

beforeEach(() => {
  resetComputerScreenshotNotice();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// §5.4 / acceptance 3 — the actions that touch the screen
// ---------------------------------------------------------------------------

describe('a click reaches the adapter at the mapped screen point', () => {
  it('maps the model image point through the downscale', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted(
      '{"action":"click","x":200,"y":150,"description":"Click Save"}',
      '{"action":"noop","description":"done"}',
    );

    const result = await executeComputerStep(1, 1, 'Click Save', makeOpts(adapter, client));

    expect(result.status).toBe('passed');
    expect(result.surface).toBe('computer');
    const clicks = adapter.callsOf('click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.args.point).toEqual(await expectedScreenPoint({ x: 200, y: 150 }));
  });

  it('halves the point again on a density-2 display', async () => {
    const spec = { ...GRAB, scaleX: 2, scaleY: 2 };
    const adapter = new FakeDesktopAdapter(spec);
    const { client } = scripted(
      '{"action":"click","x":200,"y":150,"description":"Click Save"}',
      '{"action":"noop","description":"done"}',
    );

    await executeComputerStep(1, 1, 'Click Save', makeOpts(adapter, client));

    expect(adapter.callsOf('click')[0]!.args.point).toEqual(
      await expectedScreenPoint({ x: 200, y: 150 }, spec),
    );
  });

  it('records the pointer on the turn, in both spaces (§10.1, §10.2)', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted(
      '{"action":"click","x":120,"y":80,"description":"Click"}',
      '{"action":"noop","description":"done"}',
    );

    const result = await executeComputerStep(1, 1, 'Click', makeOpts(adapter, client));

    expect(result.turns[0]!.computer!.imagePoint).toEqual({ x: 120, y: 80 });
    expect(result.turns[0]!.computer!.screenPoint).toEqual(
      await expectedScreenPoint({ x: 120, y: 80 }),
    );
  });
});

describe('a click after a zoom lands where the model pointed in the ZOOMED image', () => {
  it('maps through the crop rather than through the full screen', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted(
      '{"action":"zoom","region":{"x":100,"y":100,"width":100,"height":75},"description":"Read the small print"}',
      '{"action":"click","x":200,"y":150,"description":"Click the button in the zoom"}',
      '{"action":"noop","description":"done"}',
    );

    const result = await executeComputerStep(1, 1, 'Click Yes', makeOpts(adapter, client));
    expect(result.status).toBe('passed');

    // The zoom's own view is what the click is mapped through, and it is NOT
    // the full-screen mapping — which is the whole claim.
    const full = await expectedScreenPoint({ x: 200, y: 150 });
    const clicked = adapter.callsOf('click')[0]!.args.point as { x: number; y: number };
    expect(clicked).not.toEqual(full);
    // The zoom showed grab pixels (200,200)…(400,350); the model's (200,150)
    // in a 400×300 image is the middle of that crop.
    expect(clicked.x).toBeGreaterThanOrEqual(200);
    expect(clicked.x).toBeLessThanOrEqual(400);
    expect(clicked.y).toBeGreaterThanOrEqual(200);
    expect(clicked.y).toBeLessThanOrEqual(350);
  });

  it('shows the model the zoomed image and tells it so', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"zoom","region":{"x":10,"y":10,"width":80,"height":60},"description":"Zoom"}',
      '{"action":"noop","description":"done"}',
    );

    await executeComputerStep(1, 1, 'Read the dialog', makeOpts(adapter, client));

    expect(textIn(sent[1]!)).toContain('ZOOMED');
    expect(textIn(sent[1]!)).toContain('zoomed view of region (10, 10, 80, 60)');
    // A zoom performs nothing on the screen, so only the FIRST capture grabbed.
    expect(adapter.callsOf('grab')).toHaveLength(1);
  });

  it('re-captures a full screenshot after a real action', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted(
      '{"action":"click","x":10,"y":10,"description":"Click"}',
      '{"action":"noop","description":"done"}',
    );

    await executeComputerStep(1, 1, 'Click', makeOpts(adapter, client));

    // One at the start, one after the click.
    expect(adapter.callsOf('grab')).toHaveLength(2);
  });
});

describe('window actions go through the window list', () => {
  it('focus_window focuses a matching title', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [fakeWindow('Save As')] });
    const { client } = scripted(
      '{"action":"focus_window","title":"Save As","description":"Focus the dialog"}',
      '{"action":"noop","description":"done"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Focus the window whose title contains "Save As"',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('passed');
    expect(adapter.callsOf('findWindow')[0]!.args).toMatchObject({ titleSubstring: 'Save As' });
    expect(adapter.callsOf('focusWindowHandle')).toHaveLength(1);
  });

  it('a title nothing matches comes back to the model as prior failure, not as a red step', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [fakeWindow('Untitled - Notepad')] });
    const { client, sent } = scripted(
      '{"action":"focus_window","title":"Save As","description":"Focus the dialog"}',
      '{"action":"noop","description":"nothing to do after all"}',
    );

    const result = await executeComputerStep(1, 1, 'Focus Save As', makeOpts(adapter, client));

    expect(result.status).toBe('passed');
    expect(textIn(sent[1]!)).toContain('The last action did not succeed');
    expect(textIn(sent[1]!)).toContain('Untitled - Notepad');
  });

  it('wait_window polls until the window appears', async () => {
    const adapter = new FakeDesktopAdapter({
      ...GRAB,
      windowsSequence: [[], [], [fakeWindow('Print')]],
    });
    const { client } = scripted(
      '{"action":"wait_window","title":"Print","state":"open","timeoutMs":5000,"description":"Wait"}',
      '{"action":"noop","description":"done"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Wait until the Print dialog is showing',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('passed');
    expect(adapter.callsOf('windows').length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// §5.4 — the actions the LOOP owns
// ---------------------------------------------------------------------------

describe('read stores into the live parameter map', () => {
  it('binds the value and reports it as a capture the run loops can find', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted(
      '{"action":"read","as":"file_name","value":"statement.pdf","description":"Read the File name field"}',
      '{"action":"noop","description":"done"}',
    );
    const resolvedParameters: Record<string, string> = {};

    const result = await executeComputerStep(
      1,
      1,
      'Read the File name field [store as: file_name]',
      makeOpts(adapter, client, { resolvedParameters }),
    );

    expect(resolvedParameters.file_name).toBe('statement.pdf');
    // The sub-action shape `autoCapturedNames` (src/server/run-helpers.ts)
    // reads to lift the value into `session.outputs` for the next batch.
    const sub = result.turns.flatMap((t) => t.subActions).find((s) => s.action.action === 'read');
    expect(sub).toBeDefined();
    expect(sub!.action.as).toBe('file_name');
    expect(sub!.error).toBeUndefined();
  });
});

describe('assert is a verdict', () => {
  it('holds: true passes and ends the step', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted(
      '{"action":"assert","condition":"the Print dialog is closed","holds":true,"evidence":"No Print window is on screen","description":"Verify"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Verify the Print dialog has closed',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('passed');
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions![0]!.pass).toBe(true);
  });

  it('holds: false fails the step with the evidence as the actual', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted(
      '{"action":"assert","condition":"the Print dialog is closed","holds":false,"evidence":"A window titled Print is still on screen","description":"Verify"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Verify the Print dialog has closed',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('A window titled Print is still on screen');
    expect(result.assertions![0]!.pass).toBe(false);
    expect(result.assertions![0]!.actual).toBe('A window titled Print is still on screen');
  });
});

describe('page actions and unknown action names are refused (acceptance 4)', () => {
  it('refuses a page action and puts the reason in front of the model next turn', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"navigate","url":"https://example.com","description":"Go there"}',
      '{"action":"noop","description":"nothing I can do"}',
    );

    const result = await executeComputerStep(1, 1, 'Open the page', makeOpts(adapter, client));

    expect(result.status).toBe('passed');
    const refusalText = textIn(sent[1]!);
    expect(refusalText).toContain('Your last answer was refused');
    expect(refusalText).toContain('navigate');
    // …and it is visible in the report, on the turn that produced it.
    const refused = result.turns[0]!.subActions.find((s) => s.error !== undefined);
    expect(refused!.error).toContain('navigate');
    // Nothing touched the screen.
    expect(adapter.callsOf('click')).toHaveLength(0);
  });

  it('refuses a click carrying a selector', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"click","selector":"#save","description":"Click Save"}',
      '{"action":"noop","description":"giving up"}',
    );

    await executeComputerStep(1, 1, 'Click Save', makeOpts(adapter, client));

    expect(textIn(sent[1]!)).toContain('Your last answer was refused');
    expect(adapter.callsOf('click')).toHaveLength(0);
  });
});

describe('the claim guards travel with the step, not with the surface', () => {
  it('refuses a `return` on a step that does not claim it', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"return","description":"I think we are done"}',
      '{"action":"noop","description":"ok"}',
    );

    const result = await executeComputerStep(1, 1, 'Click Save', makeOpts(adapter, client));

    expect(result.status).toBe('passed');
    expect(result.flowControl).toBeUndefined();
    expect(textIn(sent[1]!)).toContain('this step does not say to return');
  });

  it('honours a `return` on a step that claims it', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted('{"action":"return","description":"the dialog is gone"}');

    const result = await executeComputerStep(
      1,
      1,
      'If the Save As dialog is gone, then return',
      makeOpts(adapter, client, {
        flowControlClaim: {
          verb: 'return',
          body: 'the Save As dialog is gone',
        } as ComputerStepOptions['flowControlClaim'],
      }),
    );

    expect(result.status).toBe('passed');
    expect(result.flowControl).toEqual({ kind: 'return', verb: 'return' });
  });

  it('refuses a `fail` on a step that does not claim it', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"fail","message":"nope","description":"giving up"}',
      '{"action":"noop","description":"ok"}',
    );

    const result = await executeComputerStep(1, 1, 'Click Save', makeOpts(adapter, client));

    expect(result.status).toBe('passed');
    expect(textIn(sent[1]!)).toContain('this step does not say to fail');
  });
});

describe('the stall detector (§5.5)', () => {
  it('fails the step after three identical turns', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    // One answer, repeated for ever, against a screen that never changes.
    const { client } = scripted('{"action":"key","key":"enter","description":"Press Enter"}');

    const result = await executeComputerStep(1, 1, 'Press Enter', makeOpts(adapter, client));

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Computer mode stalled');
    expect(result.error).toContain('3 turns in a row');
  });

  it('does not stall when the screen changes between turns', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    let seed = 0;
    const { client } = scripted('{"action":"key","key":"enter","description":"Press Enter"}');
    const originalGrab = adapter.grab.bind(adapter);
    vi.spyOn(adapter, 'grab').mockImplementation(async () => {
      adapter.setGrabSpec({ ...GRAB, seed: seed++ });
      return originalGrab();
    });

    const result = await executeComputerStep(1, 1, 'Press Enter', makeOpts(adapter, client));

    // Not a stall: it ran out of turns instead.
    expect(result.status).toBe('failed');
    expect(result.error).toContain('multi-turn limit');
  });
});

// ---------------------------------------------------------------------------
// §5.2, §10.1, §10.4 — the image, the report copy, and the cache
// ---------------------------------------------------------------------------

describe('the capture always reaches the model (§5.2)', () => {
  it('attaches the image even when ai.sendScreenshots is false, and says so once', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"noop","description":"done"}',
      '{"action":"noop","description":"done"}',
    );
    const opts = makeOpts(adapter, client, {
      config: makeConfig({ ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false } as Config['ai'] }),
    });

    await executeComputerStep(1, 2, 'Look at the dialog', opts);
    await executeComputerStep(2, 2, 'Look again', opts);

    expect(imagesIn(sent[0]!)).toHaveLength(1);
    expect(imagesIn(sent[0]!)[0]).toMatch(/^data:image\/png;base64,/);
    const overrideLines = info.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('computer mode sends its capture anyway'));
    expect(overrideLines).toHaveLength(1);
  });
});

describe('desktop.reportScreenshots (§10.1)', () => {
  it('records the capture on the turn when true', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted('{"action":"noop","description":"done"}');

    const result = await executeComputerStep(1, 1, 'Look', makeOpts(adapter, client));

    expect(result.turns[0]!.computer!.screenshotBase64).toBeTruthy();
    expect(result.screenshotBase64).toBeTruthy();
  });

  it('records no desktop image when false, but still reports the size', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted('{"action":"noop","description":"done"}');

    const result = await executeComputerStep(
      1,
      1,
      'Look',
      makeOpts(adapter, client, {
        computer: {
          adapter,
          settleMs: 0,
          maxImageWidth: MAX_IMAGE_WIDTH,
          reportScreenshots: false,
        },
      }),
    );

    expect(result.turns[0]!.computer!.screenshotBase64).toBeUndefined();
    expect(result.turns[0]!.computer!.imageWidth).toBe(MAX_IMAGE_WIDTH);
    expect(result.screenshotBase64).toBeUndefined();
    expect(result.turns[0]!.aiInteractions[0]!.screenshotBase64).toBeUndefined();
    // …and the MODEL still saw it. The switch is about the report only.
    expect(imagesIn(sent[0]!)).toHaveLength(1);
  });
});

describe('no step cache in computer mode (§5.5, §10.4)', () => {
  it('neither reads nor writes it, even when one is handed over', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted(
      '{"action":"click","x":10,"y":10,"description":"Click"}',
      '{"action":"noop","description":"done"}',
    );
    const stepCache = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {}),
      invalidateStep: vi.fn(async () => {}),
      readAssertion: vi.fn(async () => null),
    };

    await executeComputerStep(
      1,
      1,
      'Click',
      makeOpts(adapter, client, {
        stepCache: stepCache as unknown as ComputerStepOptions['stepCache'],
        cacheEnabled: true,
      }),
    );

    expect(stepCache.read).not.toHaveBeenCalled();
    expect(stepCache.write).not.toHaveBeenCalled();
  });
});

describe('the secret rules follow the step onto this surface', () => {
  it('masks a secret-named value in the `## Values` block', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted('{"action":"noop","description":"done"}');

    await executeComputerStep(
      1,
      1,
      'Type {{password}} into the field',
      makeOpts(adapter, client, { resolvedParameters: { password: 'hunter2' } }),
    );

    const text = textIn(sent[0]!);
    expect(text).toContain('{{password}}');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('***');
  });
});

describe('a clarification with nobody to answer fails fast (issues/014)', () => {
  it('carries the question as the error', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted(
      '{"action":"prompt","question":"Which printer should I choose?","description":"Ask"}',
    );

    const result = await executeComputerStep(1, 1, 'Print it', makeOpts(adapter, client));

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Which printer should I choose?');
  });
});

// ---------------------------------------------------------------------------
// What the step has already done is fed back to the model
//
// The measured defect (live, 2026-09-23): step 4 of
// templates/init/tests/pdf-dialog-cancel.md focused a window that was already
// frontmost, so the screen did not change and turn 2 was shown the same step
// and the same pixels with no record that anything had happened. The model
// answered with the same action three more times and the stall detector ended
// the step. Both halves of the fix are proved here: the list, and the net
// under a model that ignores it.
// ---------------------------------------------------------------------------

describe('the actions a step has already performed go back to the model', () => {
  it('lists a successful focus_window on the next turn, with the no-repeat sentence', async () => {
    const adapter = new FakeDesktopAdapter({
      ...GRAB,
      windows: [fakeWindow('statement.pdf - Chrome')],
    });
    const { client, sent } = scripted(
      '{"action":"focus_window","title":"statement.pdf","description":"Focus the PDF window"}',
      '{"action":"noop","description":"already at the front"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Focus the window whose title contains "statement.pdf"',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('passed');
    expect(result.turns).toHaveLength(2);
    // Turn 1 had nothing to report.
    expect(textIn(sent[0]!)).not.toContain('## Actions already performed for this step');
    const second = textIn(sent[1]!);
    expect(second).toContain('## Actions already performed for this step');
    expect(second).toContain(
      '- turn 1: focus_window "statement.pdf" → ok (now in front)',
    );
    expect(second).toContain(
      'If the step is now satisfied, answer with `noop`. Do not repeat an action that already ' +
        'succeeded unless the screen shows it did not take effect.',
    );
  });

  it('keeps accumulating across turns rather than being consumed by one', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [fakeWindow('Save As')] });
    const { client, sent } = scripted(
      '{"action":"click","x":200,"y":150,"description":"Click the File name field"}',
      '{"action":"type","text":"statement.pdf","description":"Type the file name"}',
      '{"action":"key","key":"enter","description":"Press Enter"}',
      '{"action":"noop","description":"saved"}',
    );

    const result = await executeComputerStep(1, 1, 'Save the file', makeOpts(adapter, client));

    expect(result.status).toBe('passed');
    const last = textIn(sent[3]!);
    expect(last).toContain('turn 1: click image(200,150)');
    // The LENGTH, never the text — a computer-mode `type` may be a password.
    expect(last).toContain('turn 2: type 13 chars → ok');
    expect(last).toContain('turn 3: key enter → ok');
  });

  it('does not repeat a window action the last turn satisfied, and tells the model (the safety net)', async () => {
    const adapter = new FakeDesktopAdapter({
      ...GRAB,
      windows: [fakeWindow('statement.pdf - Chrome')],
    });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const { client, sent } = scripted(
      '{"action":"focus_window","title":"statement.pdf","description":"Focus the PDF window"}',
      '{"action":"focus_window","title":"statement.pdf","description":"Focus the PDF window"}',
      '{"action":"noop","description":"it is in front"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Focus the window whose title contains "statement.pdf"',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('passed');
    // The repeat is answered with a note, not with "step complete" (A3): the
    // model's noop on turn 3 is what ends the step.
    expect(result.turns).toHaveLength(3);
    expect(adapter.callsOf('findWindow')).toHaveLength(1);
    expect(adapter.callsOf('focusWindowHandle')).toHaveLength(1);
    expect(textIn(sent[2]!)).toContain(
      '- focus_window "statement.pdf" — that window action already succeeded in this step. ' +
        'If the step asks for nothing more, answer noop; otherwise do the rest of it.',
    );
    expect(
      info.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('repeated an already-satisfied window action')),
    ).toHaveLength(1);
  });

  it('a model that repeats it for ever ends in a stall, having focused once', async () => {
    const adapter = new FakeDesktopAdapter({
      ...GRAB,
      windows: [fakeWindow('statement.pdf - Chrome')],
    });
    // ONE answer, repeated for ever — the live failure exactly.
    const { client } = scripted(
      '{"action":"focus_window","title":"statement.pdf","description":"Focus the PDF window"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Focus the window whose title contains "statement.pdf"',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Computer mode stalled');
    expect(result.turns).toHaveLength(3);
    expect(adapter.callsOf('focusWindowHandle')).toHaveLength(1);
  });

  it('nets a repeated wait_window too, and leaves an honest report row', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [fakeWindow('Print')] });
    const { client } = scripted(
      '{"action":"wait_window","title":"Print","state":"open","timeoutMs":5000,"description":"Wait for Print"}',
      '{"action":"wait_window","title":"Print","state":"open","timeoutMs":5000,"description":"Wait for Print"}',
      '{"action":"noop","description":"it is open"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Wait until the Print dialog is showing',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('passed');
    expect(result.turns).toHaveLength(3);
    expect(adapter.callsOf('windows')).toHaveLength(1);
    const second = result.turns[1]!.subActions;
    expect(second).toHaveLength(1);
    expect(second[0]!.action.action).toBe('noop');
    expect(second[0]!.error).toBeUndefined();
  });

  it('a repeat in front of the rest of the answer is skipped, and the rest runs', async () => {
    // [focus, type] is dropped behind the focus on turn 1; sent again, the
    // satisfied focus is skipped and the type is what runs.
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [fakeWindow('Calculator')] });
    const { client } = scripted(
      '[{"action":"focus_window","title":"Calculator"},{"action":"type","text":"1+1"}]',
      '[{"action":"focus_window","title":"Calculator"},{"action":"type","text":"1+1"}]',
      '{"action":"noop","description":"typed"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Focus Calculator and type 1+1',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('passed');
    expect(adapter.callsOf('focusWindowHandle')).toHaveLength(1);
    expect(adapter.callsOf('type').map((c) => c.args.text)).toEqual(['1+1']);
  });

  it('does not net a repeat that follows a FAILED window action', async () => {
    // Nothing matches, so turn 1 is a prior failure rather than a success, and
    // the identical turn 2 must reach the adapter like any other answer.
    const adapter = new FakeDesktopAdapter({
      ...GRAB,
      windows: [fakeWindow('Untitled - Notepad')],
    });
    const { client, sent } = scripted(
      '{"action":"focus_window","title":"Save As","description":"Focus the dialog"}',
      '{"action":"focus_window","title":"Save As","description":"Focus the dialog"}',
      '{"action":"noop","description":"it is not there"}',
    );

    const result = await executeComputerStep(1, 1, 'Focus Save As', makeOpts(adapter, client));

    expect(result.status).toBe('passed');
    expect(adapter.callsOf('findWindow')).toHaveLength(2);
    // A failure is not a performed action: it goes through priorFailure only.
    expect(textIn(sent[1]!)).toContain('The last action did not succeed');
    expect(textIn(sent[1]!)).not.toContain('## Actions already performed for this step');
    expect(textIn(sent[2]!)).not.toContain('## Actions already performed for this step');
  });

  it('says "already in front" when the window was, so the model knows the screen will not change', async () => {
    const adapter = new FakeDesktopAdapter({
      ...GRAB,
      windows: [fakeWindow('statement.pdf - Chrome')],
      activeTitle: 'statement.pdf',
    });
    const { client, sent } = scripted(
      '{"action":"focus_window","title":"statement.pdf","description":"Focus the PDF window"}',
      '{"action":"noop","description":"already at the front"}',
    );

    await executeComputerStep(1, 1, 'Focus the PDF window', makeOpts(adapter, client));

    expect(textIn(sent[1]!)).toContain(
      '- turn 1: focus_window "statement.pdf" → ok (already in front)',
    );
  });

  it('a focus the OS refuses goes back to the model as priorFailure, and its repeat is NOT netted', async () => {
    // Measured on Windows: a background process can be refused the
    // foreground, and the window then comes back BEHIND the front app. That
    // is now a failure the model reads next turn — so it can click the
    // window in the screenshot — rather than a success it has to disbelieve.
    const adapter = new FakeDesktopAdapter({
      ...GRAB,
      windows: [fakeWindow('statement.pdf - Chrome'), fakeWindow('Claude')],
      activeTitle: 'Claude',
      refuseForeground: 'always',
    });
    const { client, sent } = scripted(
      '{"action":"focus_window","title":"statement.pdf","description":"Focus the PDF window"}',
      '{"action":"focus_window","title":"statement.pdf","description":"Try again"}',
      '{"action":"noop","description":"giving up on focus"}',
    );

    const result = await executeComputerStep(1, 1, 'Focus the PDF window', makeOpts(adapter, client));

    expect(result.status).toBe('passed');
    const second = textIn(sent[1]!);
    expect(second).toContain('The last action did not succeed');
    expect(second).toMatch(
      /did not bring "statement\.pdf - Chrome" to the front; the front window is "Claude"\. A background process is often refused the foreground; click the window in the screenshot/,
    );
    // A failure is not a performed action.
    expect(second).not.toContain('## Actions already performed for this step');
    // The identical second turn reached the adapter: a failed focus disarms
    // the repeat net.
    expect(adapter.callsOf('findWindow')).toHaveLength(2);
    // The report row carries the failure too.
    expect(result.turns[0]!.subActions[0]!.error).toMatch(/did not bring/);
  });

  // A retry's empty list is proved under A6 below: only an attempt that drove
  // no input is retried at all now.
});

// ---------------------------------------------------------------------------
// The turn rules (§5.5) — each block below is a defect an audit of the loop
// found by probing dist/ with this fake adapter and a scripted model.
// ---------------------------------------------------------------------------

describe('a screenshot request is refused, not taken as "done" (A1)', () => {
  it('goes back to the model as a refusal and does not end the step', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"screenshot","description":"Look at the screen"}',
      '{"action":"click","x":10,"y":10,"description":"Click Print"}',
      '{"action":"noop","description":"done"}',
    );

    const result = await executeComputerStep(1, 1, 'Click Print', makeOpts(adapter, client));

    // Measured before the fix: passed after ONE model call with zero clicks.
    expect(result.status).toBe('passed');
    expect(sent).toHaveLength(3);
    expect(adapter.callsOf('click')).toHaveLength(1);
    const second = textIn(sent[1]!);
    expect(second).toContain('## Your last answer was refused');
    expect(second).toContain('There is no screenshot action');
  });

  it('a model that only ever asks for one stalls instead of passing', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client } = scripted('{"action":"screenshot","description":"Look"}');

    const result = await executeComputerStep(1, 1, 'Click Print', makeOpts(adapter, client));

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Computer mode stalled');
    expect(adapter.callsOf('click')).toHaveLength(0);
  });
});

describe('one screen-changing action per response (A2)', () => {
  it('does not judge an assert against the image from before the click', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '[{"action":"click","x":10,"y":10,"description":"Click Print"},' +
        '{"action":"assert","condition":"the Print dialog is open","holds":true,"evidence":"It is","description":"Verify"}]',
      '{"action":"assert","condition":"the Print dialog is open","holds":true,' +
        '"evidence":"A Print window is on screen","description":"Verify"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Click Print and verify the dialog opens',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('passed');
    expect(sent).toHaveLength(2);
    expect(adapter.callsOf('click')).toHaveLength(1);
    // The verdict that counts is the one given LOOKING AT the click's result.
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions![0]!.actual).toBe('A Print window is on screen');
    const second = textIn(sent[1]!);
    expect(second).toContain('## Not performed from your last answer');
    expect(second).toContain('assert "the Print dialog is open"');
    expect(second).toContain('only the first screen-changing action of a response is performed');
    // …and the report says what was dropped, on the turn that asked for it.
    const dropped = result.turns[0]!.subActions.find((s) => s.action.action === 'assert');
    expect(dropped!.error).toMatch(/not performed/);
  });

  it('does not map a click chosen on the full image through the zoom in front of it', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"actions":[{"action":"zoom","region":{"x":100,"y":100,"width":100,"height":75},"description":"Zoom"},' +
        '{"action":"click","x":250,"y":180,"description":"Click OK"}]}',
      '{"action":"noop","description":"done"}',
    );

    await executeComputerStep(1, 1, 'Click OK', makeOpts(adapter, client));

    // Measured before the fix: image(250,180) was clicked at screen(325,290),
    // through the crop, where the model meant screen(500,360).
    expect(adapter.callsOf('click')).toHaveLength(0);
    const second = textIn(sent[1]!);
    expect(second).toContain('ZOOMED');
    expect(second).toContain('## Not performed from your last answer');
    expect(second).toContain('click (250,180)');
  });

  it('drops a noop that follows a click: the model must see the result first', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '[{"action":"click","x":10,"y":10,"description":"Click Print"},{"action":"noop","description":"done"}]',
      '{"action":"noop","description":"the dialog is open"}',
    );

    const result = await executeComputerStep(1, 1, 'Click Print', makeOpts(adapter, client));

    expect(result.status).toBe('passed');
    expect(sent).toHaveLength(2);
    expect(adapter.callsOf('click')).toHaveLength(1);
    expect(textIn(sent[1]!)).toContain('- noop');
  });

  it('an assert that holds in front of a click is recorded, the click runs, and the step goes on', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '[{"action":"assert","condition":"the Print dialog is open","holds":true,"evidence":"A Print window is up","description":"Verify"},' +
        '{"action":"click","x":10,"y":10,"description":"Click Cancel"}]',
      '{"action":"noop","description":"the dialog closed"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Click the Cancel button',
      makeOpts(adapter, client),
    );

    // Measured before the fix: passed after ONE model call with zero clicks,
    // and the click was not even reported as not performed.
    expect(result.status).toBe('passed');
    expect(adapter.callsOf('click')).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions![0]!.pass).toBe(true);
    expect(result.turns[0]!.subActions.every((s) => s.error === undefined)).toBe(true);
  });

  it('a noop in front of a click is refused with a note, and never passes the step with zero clicks', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '[{"action":"noop","description":"done"},{"action":"click","x":10,"y":10,"description":"Click Cancel"}]',
      '{"action":"noop","description":"the dialog closed"}',
    );

    const result = await executeComputerStep(1, 1, 'Click the Cancel button', makeOpts(adapter, client));

    expect(result.status).toBe('passed');
    expect(adapter.callsOf('click')).toHaveLength(1);
    expect(sent).toHaveLength(2);
    const second = textIn(sent[1]!);
    expect(second).toContain('## Not performed from your last answer');
    expect(second).toContain('- noop');
    expect(second).toContain('does not end the step');
    const refused = result.turns[0]!.subActions.find((s) => s.action.action === 'noop');
    expect(refused!.error).toMatch(/not performed/);
  });

  it('an assert that does NOT hold in front of a click still fails the step, and the click is reported as not performed', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '[{"action":"assert","condition":"the Print dialog is open","holds":false,"evidence":"No Print window is on screen","description":"Verify"},' +
        '{"action":"click","x":10,"y":10,"description":"Click Cancel"}]',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Verify the Print dialog is open, then click Cancel',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No Print window is on screen');
    expect(adapter.callsOf('click')).toHaveLength(0);
    expect(sent).toHaveLength(1);
    const cut = result.turns[0]!.subActions.find((s) => s.action.action === 'click');
    expect(cut).toBeDefined();
    expect(cut!.error).toMatch(/not performed/);
  });

  it('an action behind one that ended the turn is reported as not performed, and the model is told', async () => {
    // A refused `return` ends the turn; the read behind it never ran.
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '[{"action":"return","description":"done"},{"action":"read","as":"field","value":"x","description":"Read"}]',
      '{"action":"noop","description":"ok"}',
    );
    const resolvedParameters: Record<string, string> = {};

    const result = await executeComputerStep(
      1,
      1,
      'Read the field',
      makeOpts(adapter, client, { resolvedParameters }),
    );

    expect(result.status).toBe('passed');
    expect(resolvedParameters.field).toBeUndefined();
    const cut = result.turns[0]!.subActions.find((s) => s.action.action === 'read');
    expect(cut!.error).toMatch(/not performed/);
    expect(textIn(sent[1]!)).toContain('read {{field}}');
  });

  it('still runs the reads in front of the screen-changing action', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '[{"action":"read","as":"field","value":"statement.pdf","description":"Read"},' +
        '{"action":"click","x":10,"y":10,"description":"Click Save"}]',
      '{"action":"noop","description":"done"}',
    );
    const resolvedParameters: Record<string, string> = {};

    await executeComputerStep(1, 1, 'Read the name, then Save', makeOpts(adapter, client, { resolvedParameters }));

    expect(resolvedParameters.field).toBe('statement.pdf');
    expect(adapter.callsOf('click')).toHaveLength(1);
    expect(textIn(sent[1]!)).not.toContain('## Not performed from your last answer');
  });
});

describe('a repeated window action is answered with a note, not a pass (A3)', () => {
  it('"Focus Calculator and type 1+1" still types after the model repeats the focus', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [fakeWindow('Calculator')] });
    const { client, sent } = scripted(
      '{"action":"focus_window","title":"Calculator","description":"Focus Calculator"}',
      '{"action":"focus_window","title":"Calculator","description":"Focus Calculator"}',
      '{"action":"type","text":"1+1","description":"Type the sum"}',
      '{"action":"noop","description":"typed"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Focus Calculator and type 1+1',
      makeOpts(adapter, client),
    );

    // Measured before the fix: passed at turn 2 with nothing typed.
    expect(result.status).toBe('passed');
    expect(adapter.callsOf('type').map((c) => c.args.text)).toEqual(['1+1']);
    expect(adapter.callsOf('focusWindowHandle')).toHaveLength(1);
    const third = textIn(sent[2]!);
    expect(third).toContain('## Not performed from your last answer');
    expect(third).toContain('already succeeded in this step');
  });
});

describe('Stop reaches a computer step (A5)', () => {
  it('ends a wait_window promptly, without spinning on the window list', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [] });
    const controller = new AbortController();
    const { client } = scripted(
      '{"action":"wait_window","title":"Never","state":"open","timeoutMs":1500,"description":"Wait"}',
    );
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();

    const result = await executeComputerStep(
      1,
      1,
      'Wait for the Never window',
      makeOpts(adapter, client, { signal: controller.signal }),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Aborted by client');
    expect(Date.now() - started).toBeLessThan(900);
    // Measured before the fix: millions of window-list calls, spun until the
    // model's own timeout ran out.
    expect(adapter.callsOf('windows').length).toBeLessThanOrEqual(3);
  });

  it('performs nothing the model answered after Stop was pressed', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const controller = new AbortController();
    const client = {
      complete: async () => {
        controller.abort();
        return { text: '{"action":"click","x":10,"y":10,"description":"Click"}', model: 'fake' };
      },
    } as unknown as AiClient;

    const result = await executeComputerStep(
      1,
      1,
      'Click',
      makeOpts(adapter, client, { signal: controller.signal }),
    );

    expect(result.error).toBe('Aborted by client');
    expect(adapter.callsOf('click')).toHaveLength(0);
  });

  it('tells the model when its wait_window timeout was capped', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [fakeWindow('Print')] });
    const { client, sent } = scripted(
      '{"action":"wait_window","title":"Print","state":"open","timeoutMs":120000,"description":"Wait"}',
      '{"action":"noop","description":"open"}',
    );

    await executeComputerStep(1, 1, 'Wait for Print', makeOpts(adapter, client));

    expect(textIn(sent[1]!)).toMatch(/wait_window "Print" open → ok .*capped at 30000ms; you asked for 120000ms/);
  });
});

describe('an attempt that acted on the screen is never replayed (A6)', () => {
  it('does not type twice when the attempt that typed then failed', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"type","text":"1+1","description":"Type the sum"}',
      'I am not sure what to do next',
      '{"action":"type","text":"1+1","description":"Type the sum"}',
      'I am not sure what to do next',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Type 1+1',
      makeOpts(adapter, client, { config: execWith({ retries: 1 }) }),
    );

    // Measured before the fix: typed ['1+1', '1+1'].
    expect(result.status).toBe('failed');
    expect(result.error).toContain('No JSON object or array found');
    expect(adapter.callsOf('type').map((c) => c.args.text)).toEqual(['1+1']);
    expect(sent).toHaveLength(2);
    expect(result.retried).toBe(false);
  });

  it('does not click twice when the model call after the click fails', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"click","x":10,"y":10,"description":"Click Submit"}',
      new Error('503 upstream unavailable'),
      '{"action":"click","x":10,"y":10,"description":"Click Submit"}',
      new Error('503 upstream unavailable'),
    );

    const result = await executeComputerStep(
      1,
      1,
      'Click Submit',
      makeOpts(adapter, client, { config: execWith({ retries: 1 }) }),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('503 upstream unavailable');
    expect(adapter.callsOf('click')).toHaveLength(1);
    expect(sent).toHaveLength(2);
    // The attempt's turns are on the report, not lost with the raw error.
    expect(result.turns).toHaveLength(1);
  });

  it('an attempt that touched nothing is still retried, and starts with an empty list', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [fakeWindow('Print')] });
    const { client, sent } = scripted(
      '{"action":"wait_window","title":"Print","state":"open","timeoutMs":5000,"description":"Wait"}',
      new Error('503 upstream unavailable'),
      '{"action":"noop","description":"the dialog is open"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Wait for Print',
      makeOpts(adapter, client, { config: execWith({ retries: 1 }) }),
    );

    expect(result.status).toBe('passed');
    expect(result.retried).toBe(true);
    expect(sent).toHaveLength(3);
    expect(textIn(sent[1]!)).toContain('turn 1: wait_window "Print" open → ok');
    // The retry's first turn is a fresh step, not a continuation of the one
    // that failed.
    expect(textIn(sent[2]!)).not.toContain('## Actions already performed for this step');
  });
});

describe('a wait that never comes costs one attempt, within a budget (D2)', () => {
  it('a stall is not retried', async () => {
    // An answer that touches nothing, so only the stall rule stops a retry.
    // (A repeated `wait` no longer stalls: the wait budget bounds it — below.)
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"read","as":"title","value":"Print","description":"Read the title"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Wait for the dialog',
      makeOpts(adapter, client, { config: execWith({ retries: 1 }) }),
    );

    expect(result.error).toContain('Computer mode stalled');
    expect(sent).toHaveLength(3);
    expect(result.retried).toBe(false);
  });

  it('a slow "Wait until" waits on a static screen past three turns, then sees the window and passes', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [] });
    const sent: ChatMessage[][] = [];
    const client = {
      complete: async (messages: ChatMessage[]) => {
        sent.push(messages);
        if (sent.length <= 4) {
          return { text: '{"action":"wait","seconds":0.01,"description":"Wait for the dialog"}' };
        }
        if (sent.length === 5) {
          adapter.setWindows([fakeWindow('Print')]);
          return {
            text: '{"action":"wait_window","title":"Print","state":"open","timeoutMs":1000,"description":"Wait"}',
          };
        }
        return { text: '{"action":"noop","description":"the Print dialog is showing"}' };
      },
    } as unknown as AiClient;

    const result = await executeComputerStep(
      1,
      1,
      'Wait until the Print dialog is showing',
      makeOpts(adapter, client, { config: execWith({ maxTurns: 8 }) }),
    );

    // Measured before the fix: "Computer mode stalled" at turn 3, ~20 s into a
    // 60 s budget on a real run.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('passed');
    expect(sent).toHaveLength(6);
  });

  it('a wait_window that keeps timing out is not a stall either', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [] });
    const sent: ChatMessage[][] = [];
    const client = {
      complete: async (messages: ChatMessage[]) => {
        sent.push(messages);
        if (sent.length === 5) adapter.setWindows([fakeWindow('Print')]);
        return sent.length <= 5
          ? { text: '{"action":"wait_window","title":"Print","state":"open","timeoutMs":20,"description":"Wait"}' }
          : { text: '{"action":"noop","description":"the Print dialog is showing"}' };
      },
    } as unknown as AiClient;

    const result = await executeComputerStep(
      1,
      1,
      'Wait until the Print dialog is showing',
      makeOpts(adapter, client, { config: execWith({ maxTurns: 8 }) }),
    );

    expect(result.status).toBe('passed');
    expect(sent).toHaveLength(6);
  });

  it('an endless wait is ended by the wait budget, not by the stall detector', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted('{"action":"wait","seconds":0.05,"description":"Wait"}');

    const result = await executeComputerStep(
      1,
      1,
      'Wait until the Print dialog is showing',
      makeOpts(adapter, client, {
        config: execWith({ maxTurns: 30 }),
        computer: {
          adapter,
          settleMs: 0,
          maxImageWidth: MAX_IMAGE_WIDTH,
          reportScreenshots: true,
          waitBudgetMs: 200,
        } as ComputerStepOptions['computer'],
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error).not.toContain('stalled');
    expect(result.error).toMatch(/wait budget/);
    expect(sent.length).toBeGreaterThan(3);
    expect(sent.length).toBeLessThan(30);
  });

  it('an endless failing wait_window is ended by the wait budget too', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [] });
    const { client, sent } = scripted(
      '{"action":"wait_window","title":"Never","state":"open","timeoutMs":60,"description":"Wait"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Wait until the Never window is showing',
      makeOpts(adapter, client, {
        config: execWith({ maxTurns: 30 }),
        computer: {
          adapter,
          settleMs: 0,
          maxImageWidth: MAX_IMAGE_WIDTH,
          reportScreenshots: true,
          waitBudgetMs: 800,
        } as ComputerStepOptions['computer'],
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error).not.toContain('stalled');
    expect(result.error).toMatch(/wait budget/);
    expect(sent.length).toBeGreaterThan(3);
  });

  it('the turn cap still bounds waits', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted('{"action":"wait","seconds":0.01,"description":"Wait"}');

    const result = await executeComputerStep(
      1,
      1,
      'Wait for the dialog',
      makeOpts(adapter, client, { config: execWith({ maxTurns: 4 }) }),
    );

    expect(result.error).toContain('multi-turn limit');
    expect(sent).toHaveLength(4);
  });

  it('the turn cap is not retried', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"wait","seconds":0.01,"description":"Wait"}',
      '{"action":"wait","seconds":0.02,"description":"Wait longer"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Wait for the dialog',
      makeOpts(adapter, client, { config: execWith({ retries: 1, maxTurns: 2 }) }),
    );

    expect(result.error).toContain('multi-turn limit');
    expect(sent).toHaveLength(2);
    expect(result.retried).toBe(false);
  });

  it('fails the step once wait_window has spent the wait budget, naming it', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [] });
    const { client, sent } = scripted(
      '{"action":"wait_window","title":"Never","state":"open","timeoutMs":200,"description":"Wait"}',
      '{"action":"wait_window","title":"Never","state":"open","timeoutMs":201,"description":"Wait again"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Wait for the Never window',
      makeOpts(adapter, client, {
        computer: {
          adapter,
          settleMs: 0,
          maxImageWidth: MAX_IMAGE_WIDTH,
          reportScreenshots: true,
          waitBudgetMs: 300,
        } as ComputerStepOptions['computer'],
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/wait budget/);
    expect(result.error).toContain('Timed out');
    expect(sent).toHaveLength(2);
  });

  it('counts plain waits against the same budget', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"wait","seconds":0.2,"description":"Wait"}',
      '{"action":"wait","seconds":0.21,"description":"Wait more"}',
      '{"action":"wait","seconds":0.22,"description":"Wait more still"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Wait for the dialog',
      makeOpts(adapter, client, {
        computer: {
          adapter,
          settleMs: 0,
          maxImageWidth: MAX_IMAGE_WIDTH,
          reportScreenshots: true,
          waitBudgetMs: 300,
        } as ComputerStepOptions['computer'],
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/wait budget/);
    expect(sent).toHaveLength(3);
  });
});

describe('the step reaches the model as the page surface sends it (A7)', () => {
  it('[output: total] is asked for as [store as: total], and the read lands in {{total}}', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"read","as":"total","value":"2","description":"Read the display"}',
      '{"action":"noop","description":"read"}',
    );
    const resolvedParameters: Record<string, string> = {};

    const result = await executeComputerStep(
      1,
      1,
      'Read the result shown in Calculator [store as: total]',
      makeOpts(adapter, client, { resolvedParameters }),
      '[output: total] Read the result shown in Calculator',
    );

    expect(result.status).toBe('passed');
    const text = textIn(sent[0]!);
    expect(text).toContain('## Current Step\nRead the result shown in Calculator [store as: total]\n');
    expect(text).not.toContain('[output: total]');
    expect(resolvedParameters.total).toBe('2');
  });

  it('the model never sees the failure tail, and the tail still decides the outcome', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted(
      '{"action":"assert","condition":"the Print dialog is open","holds":false,"evidence":"No dialog","description":"Verify"}',
    );
    const authored = 'Verify the Print dialog is open, otherwise continue with warning "no dialog"';

    const result = await executeComputerStep(
      1,
      1,
      authored,
      makeOpts(adapter, client, { failureTail: parseFailureTail(authored)! }),
      authored,
    );

    const text = textIn(sent[0]!);
    expect(text).toContain('## Current Step\nVerify the Print dialog is open\n');
    expect(text).not.toContain('otherwise');
    expect(result.status).toBe('failed');
    expect(result.tolerated).toBe(true);
    expect(result.warning).toBe('no dialog');
  });

  it('strips the tail before the enrichment, so both apply to one line', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted('{"action":"noop","description":"done"}');
    const authored = '[output: total] Read the result, otherwise continue';

    await executeComputerStep(
      1,
      1,
      'Read the result, otherwise continue [store as: total]',
      makeOpts(adapter, client, { failureTail: parseFailureTail(authored)! }),
      authored,
    );

    expect(textIn(sent[0]!)).toContain('## Current Step\nRead the result [store as: total]\n');
  });
});

describe('the model is given one coordinate space: the image (B5)', () => {
  it('carries no browser viewport line, and keeps the test name, base URL and step n of m', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted('{"action":"noop","description":"done"}');
    const opts = makeOpts(adapter, client, {
      testName: 'Calculator sums',
      baseUrl: 'http://localhost:8787',
    });
    // Both sizes the page surface could report, so neither can slip through.
    expect(opts.config.browser.viewport).toBeDefined();

    await executeComputerStep(2, 3, 'Look at the display', opts);

    const text = textIn(sent[0]!);
    expect(text).not.toMatch(/Viewport/i);
    expect(text).toContain('Calculator sums');
    expect(text).toContain('- Base URL: http://localhost:8787');
    expect(text).toContain('- Current Step: 2 of 3');
    // The one size the model is told is the image's.
    expect(text).toContain(`The attached image is the current screen, ${MAX_IMAGE_WIDTH}×300 pixels.`);
  });
});

// ---------------------------------------------------------------------------
// §15.4 — a model that rejects the screenshot fails the step at once
//
// The backstop behind the `[use computer]` vision check: a model changed after
// the check (run settings), or a bridge that could not say in advance, answers
// the first request that carries an image with a 400 `image_input_unsupported`.
// Retrying sends the same image to the same model, so the step fails on
// attempt 1 with the bridge's own words.
// ---------------------------------------------------------------------------

/** The OpenAI SDK's `BadRequestError` for the bridge's 400, as
 *  `APIError.generate` builds it: the message is `"400 <error.message>"` and
 *  the code lives on `.code` / `.error.code`, never in the message. */
function bridgeRejection(message: string): Error {
  const body = { message, type: 'invalid_request_error', code: 'image_input_unsupported' };
  return Object.assign(new Error(`400 ${message}`), {
    name: 'BadRequestError',
    status: 400,
    error: body,
    code: body.code,
    type: body.type,
  });
}

const BRIDGE_REJECTION =
  'copilot/o3-mini does not accept images. Computer mode and ai.sendScreenshots need a ' +
  'model that does — pick another Copilot model.';

describe('image_input_unsupported fails the step at once (§15.4)', () => {
  it('fails on attempt 1 with the bridge\'s message, and is not retried', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    let calls = 0;
    const client = {
      complete: async () => {
        calls++;
        throw bridgeRejection(BRIDGE_REJECTION);
      },
    } as unknown as AiClient;
    const opts = makeOpts(adapter, client, {
      config: makeConfig({
        execution: {
          ...DEFAULT_CONFIG.execution,
          retries: 2,
          maxTurns: 4,
          promptOnAmbiguity: true,
        } as Config['execution'],
      }),
    });

    const result = await executeComputerStep(1, 1, 'Click Save', opts);

    expect(result.status).toBe('failed');
    expect(result.error).toBe(BRIDGE_REJECTION);
    expect(result.retried).toBe(false);
    // One request: no second turn, no retry attempt.
    expect(calls).toBe(1);
    // The turn that was refused is on the report, with what the model would
    // have been shown.
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]!.attemptNumber).toBe(1);
    expect(result.turns[0]!.computer?.screenshotBase64).toBeDefined();
    expect(adapter.callsOf('click')).toHaveLength(0);
  });

  it('any other AI error is still retried as before', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    let calls = 0;
    const client = {
      complete: async () => {
        calls++;
        throw Object.assign(new Error('400 context_length_exceeded'), { status: 400 });
      },
    } as unknown as AiClient;
    const opts = makeOpts(adapter, client, {
      config: makeConfig({
        execution: {
          ...DEFAULT_CONFIG.execution,
          retries: 1,
          maxTurns: 4,
          promptOnAmbiguity: true,
        } as Config['execution'],
      }),
    });

    const result = await executeComputerStep(1, 1, 'Click Save', opts);

    expect(result.status).toBe('failed');
    expect(calls).toBe(2);
  });

  it('the §5.6 condition judge fails the same way: the bridge\'s message, one call', async () => {
    const { evaluateConditions } = await import('../src/runner/step-executor.js');
    const adapter = new FakeDesktopAdapter(GRAB);
    let calls = 0;
    const client = {
      complete: async () => {
        calls++;
        throw bridgeRejection(BRIDGE_REJECTION);
      },
    } as unknown as AiClient;

    const judged = evaluateConditions(['a window titled "Save As" is open'], makeOpts(adapter, client));

    await expect(judged).rejects.toThrow(BRIDGE_REJECTION);
    await judged.catch((err: unknown) => {
      expect((err as Error).message).toBe(BRIDGE_REJECTION);
      expect((err as { retryable?: boolean }).retryable).toBe(false);
    });
    expect(calls).toBe(1);
  });

  it('an `If` guard on the computer surface fails with the bridge\'s message', async () => {
    // The layer every run loop shares: `evaluateGuard` turns a judge throw
    // into a failed guard carrying the judge's words, with no re-ask.
    const { evaluateGuard } = await import('../src/runner/control-runtime.js');
    const { createControlState } = await import('../src/runner/control-flow.js');
    const adapter = new FakeDesktopAdapter(GRAB);
    let calls = 0;
    const client = {
      complete: async () => {
        calls++;
        throw bridgeRejection(BRIDGE_REJECTION);
      },
    } as unknown as AiClient;

    const evaluation = await evaluateGuard({
      controls: [
        {
          kind: 'if',
          chainId: 'c1',
          condition: 'a window titled "Save As" is open',
          bodyStart: 1,
          bodyEnd: 1,
          chainEnd: 1,
        },
        null,
      ],
      index: 0,
      state: createControlState(),
      resolvedParameters: {},
      executorOptions: makeOpts(adapter, client),
    });

    expect(evaluation.error).toBe(BRIDGE_REJECTION);
    expect(calls).toBe(1);
  });
});

describe('undispatchedDirectiveError — what may not reach the computer-surface model (§5.4)', () => {
  const none = { toolsLoaded: false, skillsDirSupplied: false };
  const all = { toolsLoaded: true, skillsDirSupplied: true };

  it('names the missing toolsDir, and how to supply one', () => {
    expect(undispatchedDirectiveError('[tool: open_calculator]', none)).toBe(
      '[tool: open_calculator] was not run: this request carried no tools directory (toolsDir), ' +
        "so no tool is loaded — declare tests.toolsDir in the project's aiui.config.json so the " +
        'client sends one. In computer mode a tool line is never handed to the model, because it ' +
        'would act it out on the real screen.',
    );
  });

  it('reads a tool line the way the dispatcher does: labelled, colonless, with arguments', () => {
    for (const step of [
      'Open the calculator [tool: open_calculator]',
      '[tool open_calculator]',
      '[tool: open_calculator mode="scientific"]',
      '[no-hooks] [tool: open_calculator]',
    ]) {
      expect(undispatchedDirectiveError(step, none), step).toMatch(/^\[tool: open_calculator\] was not run/);
    }
  });

  it('a tool line that does not parse is still a tool line, and carries the parser\'s caret', () => {
    const message = undispatchedDirectiveError('[tool: open_calculator count=abc]', none)!;
    expect(message).toMatch(/^This \[tool: …\] line was not run: it does not parse\./);
    expect(message).toContain('[tool: open_calculator count=abc]');
    expect(message).toContain('^');
    expect(message).toContain('In computer mode a tool line is never handed to the model');
  });

  it('with everything loaded, says the runner dropped it rather than blaming a directory', () => {
    expect(undispatchedDirectiveError('[tool: x]', all)).toMatch(
      /^\[tool: x\] was not run: the runner did not dispatch it as a tool call\./,
    );
    expect(undispatchedDirectiveError('[skill: login]', all)).toMatch(
      /^\[skill: login\] was not run: skills are expanded into their steps before the run starts/,
    );
  });

  it('names the missing skillsDir for a raw skill line', () => {
    expect(undispatchedDirectiveError('[skill: auth/login]', none)).toMatch(
      /^\[skill: auth\/login\] was not run: this request carried no skills directory \(skillsDir\)/,
    );
  });

  it('refuses a whole-step bracket that names no directive, with §4.2\'s own message', () => {
    expect(undispatchedDirectiveError('[calculator]', all)).toContain('`[calculator]` is not one');
  });

  it('lets prose and the directives the loop already dispatched through', () => {
    for (const step of [
      'Click the equals button',
      'Verify the [optional] banner is gone',
      'Check the [skillful] label',
      '[use computer]',
      '[input: code]',
      '[interactive]',
      'If the dialog is open, then return',
    ]) {
      expect(undispatchedDirectiveError(step, none), step).toBeNull();
    }
  });
});

describe('which steps read the screen, and so take the lock (§5.9)', () => {
  it('prose — including an `If … then return` claim, judged from the screen — reads it', () => {
    for (const step of [
      'Click Save in the dialog',
      'Verify the [optional] banner is gone',
      'If the Save dialog is open, then return',
      '[output: total] Read the total from the status bar',
    ]) {
      expect(stepReadsScreen(step), step).toBe(true);
    }
  });

  it('a [tool:] line takes it: a tool can launch a program and take the focus', () => {
    // Measured: the fixture `open_calculator` launches a GUI app. Run after a
    // pause without the lock, it could steal the front window from another
    // session's computer-mode run.
    for (const step of [
      '[tool: open_calculator]',
      'Open the calculator [tool: open_calculator]',
      '[tool: assert_file_exists]',
    ]) {
      expect(stepReadsScreen(step), step).toBe(true);
    }
  });

  it('assignments, whole-step flow control, directives and surface switches do not', () => {
    for (const step of [
      'Set {{file_name}} to "statement.pdf"',
      'Return',
      'Stop running the remaining steps',
      'Fail the test with error "no dialog"',
      // Fails with §5.4's parse message before anything runs.
      '[tool: open calculator(]',
      '[skill: open-calculator]',
      '[calculator]',
      '[use computer]',
      '[use browser]',
    ]) {
      expect(stepReadsScreen(step), step).toBe(false);
    }
  });

  it('a guard reads it when the visit decides a condition, and not otherwise', () => {
    const controls: (ControlRecord | null)[] = [
      { kind: 'if', chainId: 'c1', condition: 'the dialog is open', bodyStart: 1, bodyEnd: 1, chainEnd: 1 },
      null,
      { kind: 'repeat', condition: 'the dialog is gone', bodyStart: 3, bodyEnd: 3, label: 'Press Escape' },
      null,
      { kind: 'foreach', item: 'file', list: 'files', bodyStart: 5, bodyEnd: 5, label: 'Open {{file}}' },
      null,
      { kind: 'while', condition: 'a dialog is open', bodyStart: 7, bodyEnd: 7, label: 'Press Escape' },
      null,
    ];
    const state = createControlState();

    expect(guardVisitReadsScreen(controls, 0, state)).toBe(true);
    expect(guardVisitReadsScreen(controls, 6, state)).toBe(true);
    // `Repeat` runs its body before there is anything to decide…
    expect(guardVisitReadsScreen(controls, 2, state)).toBe(false);
    // …and decides from the second visit on.
    state.passes.set(2, 1);
    expect(guardVisitReadsScreen(controls, 2, state)).toBe(true);
    // `For each` reads a variable, not the screen.
    expect(guardVisitReadsScreen(controls, 4, state)).toBe(false);
  });
});
