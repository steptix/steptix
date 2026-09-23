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
  resetComputerScreenshotNotice,
  type ComputerStepOptions,
} from '../src/runner/computer-step.js';
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
 *  is what lets the stall test hand it one answer and get three turns. */
function scripted(...responses: string[]): Scripted {
  const sent: ChatMessage[][] = [];
  let at = 0;
  const client = {
    complete: async (messages: ChatMessage[]) => {
      sent.push(messages);
      const text = responses[Math.min(at, responses.length - 1)] ?? '{"action":"noop"}';
      at++;
      return { text, model: 'fake-model' };
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
// templates/init/tests/pdf-print-cancel.md focused a window that was already
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

  it('completes the step when the model repeats the same window action (the safety net)', async () => {
    const adapter = new FakeDesktopAdapter({
      ...GRAB,
      windows: [fakeWindow('statement.pdf - Chrome')],
    });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
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

    expect(result.status).toBe('passed');
    expect(result.error).toBeUndefined();
    // Turn 2 answered it; the screen was touched exactly once.
    expect(result.turns).toHaveLength(2);
    expect(adapter.callsOf('findWindow')).toHaveLength(1);
    expect(adapter.callsOf('focusWindowHandle')).toHaveLength(1);
    expect(
      info.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('repeated an already-satisfied window action')),
    ).toHaveLength(1);
  });

  it('nets a repeated wait_window too, and leaves an honest report row', async () => {
    const adapter = new FakeDesktopAdapter({ ...GRAB, windows: [fakeWindow('Print')] });
    const { client } = scripted(
      '{"action":"wait_window","title":"Print","state":"open","timeoutMs":5000,"description":"Wait for Print"}',
    );

    const result = await executeComputerStep(
      1,
      1,
      'Wait until the Print dialog is showing',
      makeOpts(adapter, client),
    );

    expect(result.status).toBe('passed');
    expect(result.turns).toHaveLength(2);
    const second = result.turns[1]!.subActions;
    expect(second).toHaveLength(1);
    expect(second[0]!.action.action).toBe('noop');
    expect(second[0]!.error).toBeUndefined();
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

  it('starts a retry attempt with an empty list', async () => {
    const adapter = new FakeDesktopAdapter(GRAB);
    const { client, sent } = scripted('{"action":"click","x":10,"y":10,"description":"Click"}');
    const opts = makeOpts(adapter, client, {
      config: makeConfig({
        execution: {
          ...DEFAULT_CONFIG.execution,
          retries: 1,
          maxTurns: 2,
          promptOnAmbiguity: true,
        } as Config['execution'],
      }),
    });

    const result = await executeComputerStep(1, 1, 'Click', opts);

    // Attempt 1 ran out of turns, attempt 2 started over.
    expect(result.status).toBe('failed');
    expect(sent).toHaveLength(4);
    expect(textIn(sent[0]!)).not.toContain('## Actions already performed for this step');
    expect(textIn(sent[1]!)).toContain('turn 1: click image(10,10)');
    // The retry's first turn is a fresh step, not a continuation of the one
    // that failed — the same reset the stall detector gets.
    expect(textIn(sent[2]!)).not.toContain('## Actions already performed for this step');
    expect(textIn(sent[3]!)).toContain('turn 1: click image(10,10)');
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
