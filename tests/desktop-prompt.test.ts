/**
 * The computer-mode prompt
 * (docs/specs/SPEC-use-computer.md §5.3, §5.7; acceptance §13.1 "prompt states
 * image size").
 *
 * §5.7 is a list of things the prompt must say, so this file is mostly a list
 * of things it must contain. Two of them are worth more than the rest: that
 * every action in the parser's vocabulary is taught (a name the model is never
 * shown is a name it will not use, and a name it is shown that the parser
 * rejects costs a turn), and that the surface-change and credential sentences
 * are present, since both exist to stop a specific bad answer rather than to
 * enable a good one.
 */
import { describe, it, expect } from 'vitest';
import {
  buildComputerStepMessage,
  buildComputerSystemPrompt,
  zoomNote,
} from '../src/desktop/prompt.js';
import { COMPUTER_ACTION_TYPES } from '../src/desktop/actions.js';
import { buildSystemPrompt, contentBlocksToText } from '../src/ai/prompts.js';

function systemText(overrides: Record<string, unknown> = {}): string {
  return contentBlocksToText(
    buildComputerSystemPrompt({ imageWidth: 1600, imageHeight: 670, ...overrides } as never),
  );
}

describe('buildComputerSystemPrompt — §5.7', () => {
  it('says the model is driving the operating system, not a page', () => {
    const text = systemText();
    expect(text).toMatch(/THIS MACHINE'S SCREEN/);
    expect(text).toMatch(/not looking at a web page/);
    expect(text).toMatch(/no DOM, no HTML, no CSS selector/);
  });

  it('states the image size and that coordinates are in that space (§5.2)', () => {
    const text = systemText({ imageWidth: 1600, imageHeight: 670 });
    expect(text).toContain('1600×670');
    expect(text).toMatch(/coordinates are in that space/i);
  });

  it('carries the size the CURRENT turn actually has', () => {
    // A zoom changes it mid-step, so this cannot be a constant.
    expect(systemText({ imageWidth: 800, imageHeight: 400 })).toContain('800×400');
  });

  it('teaches every action in the vocabulary, with a JSON example each', () => {
    const text = systemText();
    for (const name of COMPUTER_ACTION_TYPES) {
      expect(text, `the prompt never mentions "${name}"`).toContain(`\`${name}\``);
      expect(text, `no JSON example for "${name}"`).toContain(`"action":"${name}"`);
    }
  });

  it('says focus_window / wait_window are for steps that name a window', () => {
    const text = systemText();
    expect(text).toMatch(/When a step names a window/);
    expect(text).toMatch(/focus_window/);
    expect(text).toMatch(/wait_window/);
  });

  it('says focus_window also restores a minimised window and fetches one from another screen', () => {
    // Without this the model hunts the taskbar for a minimised window, or
    // concludes a window on a second monitor is not open, when one
    // `focus_window` would bring it onto the screen it can see.
    expect(systemText()).toContain(
      'it also restores a minimised window and moves a window from another screen onto the one you can see',
    );
  });

  it('says zoom is for anything too small to read', () => {
    expect(systemText()).toMatch(/too small to be sure of/);
  });

  it('says page actions do not exist here, and names them', () => {
    const text = systemText();
    expect(text).toMatch(/Page actions do not exist here/);
    for (const name of ['navigate', 'select', 'upload', 'hover', 'readTable', 'extract_csrf']) {
      expect(text).toContain(name);
    }
    expect(text).toMatch(/nothing is quietly ignored/);
  });

  it('says a surface-change request is answered with assert holds:false', () => {
    // The one instruction the file header commits to, stated so that a reader
    // who changes it has to change this too.
    const text = systemText();
    expect(text).toMatch(/A step that asks to change surface/);
    expect(text).toMatch(/"holds": false/);
    expect(text).toMatch(/Do not answer it with `noop`/);
    expect(text).toMatch(/do not answer it with `fail`/);
  });

  it('tells the model not to repeat an action that already succeeded', () => {
    // The rule that answers the measured stall: the step message carries the
    // record, and this is what makes the model read it.
    const text = systemText();
    expect(text).toContain('## Actions already performed for this step');
    expect(text).toMatch(/do not repeat one that already succeeded/);
    expect(text).toMatch(/unless the screen shows it did not take effect/);
  });

  it('tells a model with no screenshot not to guess — assert holds:false (§15.5)', () => {
    // The rule for a route §15.4 cannot see: the Copilot bridge on an older
    // VS Code swaps the image for "[screenshot omitted …]" after the request
    // has left the server, and a model left to it guesses a click on the real
    // screen or `noop`s a step that did nothing.
    const text = systemText();
    expect(text).toContain(
      'If a message carries no image, or says the screenshot was omitted, do not guess coordinates',
    );
    expect(text).toContain('answer `assert` with "holds": false and "evidence": "no screenshot was received"');
  });

  it('says only the first screen-changing action of a response is performed (§5.5)', () => {
    const text = systemText();
    expect(text).toMatch(/only the first that changes the screen or the image .* is performed/);
    expect(text).toMatch(/anything after it is dropped/);
  });

  it('says there is no screenshot action, and caps wait_window at 30 s', () => {
    const text = systemText();
    expect(text).toContain('There is no screenshot action');
    expect(text).toContain('"timeoutMs" at most 30000');
  });

  it('says never to type a credential', () => {
    const text = systemText();
    expect(text).toMatch(/Never type a password, passphrase, PIN, API key, card number/);
    expect(text).toMatch(/answer with `prompt`/);
  });

  it('names the platform\'s modifiers', () => {
    expect(systemText({ platform: 'darwin' })).toMatch(/`cmd` is the command key/);
    expect(systemText({ platform: 'win32' })).toMatch(/`ctrl`, `alt`, `shift` and `win`/);
  });

  it('marks the stable instructions cacheable and the image size not', () => {
    const blocks = buildComputerSystemPrompt({ imageWidth: 1600, imageHeight: 670 });
    expect(blocks[0]).toMatchObject({ type: 'text', cache: true });
    const last = blocks[blocks.length - 1]!;
    expect(last).toMatchObject({ type: 'text' });
    expect((last as { cache?: boolean }).cache).toBeUndefined();
  });

  it('includes project context when there is some', () => {
    expect(systemText({ contextContent: 'The printer is called Front Desk.' })).toContain(
      'The printer is called Front Desk.',
    );
  });
});

describe('buildComputerStepMessage — §5.7', () => {
  const base = {
    stepInstruction: 'Click the Cancel button in the Print dialog',
    pngBase64: 'QUJD',
    imageWidth: 1600,
    imageHeight: 670,
  };

  it('carries the step, the size and the image', () => {
    const message = buildComputerStepMessage(base);
    expect(message.role).toBe('user');
    const blocks = message.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect(String(blocks[0]!['text'])).toContain('Click the Cancel button in the Print dialog');
    expect(String(blocks[0]!['text'])).toContain('1600×670 pixels');
    expect(blocks[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,QUJD' },
    });
  });

  it('carries the variable map', () => {
    const text = contentBlocksToText(
      buildComputerStepMessage({ ...base, variables: { save_dir: 'C:\\Temp' } }).content,
    );
    expect(text).toContain('{{save_dir}} = C:\\Temp');
  });

  it('omits the Values block entirely when the step references nothing', () => {
    expect(contentBlocksToText(buildComputerStepMessage(base).content)).not.toContain('## Values');
  });

  it('carries §5.3\'s note on a zoomed turn, and says the image is the zoom', () => {
    const text = contentBlocksToText(
      buildComputerStepMessage({
        ...base,
        zoomRegion: { x: 900, y: 400, width: 420, height: 180 },
      }).content,
    );
    expect(text).toContain(
      'This is a zoomed view of region (900, 400, 420, 180) of the previous screenshot; ' +
        'coordinates you return now are in THIS image.',
    );
    expect(text).toContain('ZOOMED');
  });

  it('lists what the step has already done, and says not to repeat it', () => {
    const text = contentBlocksToText(
      buildComputerStepMessage({
        ...base,
        performed: [
          'turn 1: focus_window "statement.pdf" → ok (already in front)',
          'turn 2: click image(812,544) → screen(1624,1088) ok',
        ],
      }).content,
    );
    expect(text).toContain('## Actions already performed for this step');
    expect(text).toContain(
      '- turn 1: focus_window "statement.pdf" → ok (already in front)',
    );
    expect(text).toContain('- turn 2: click image(812,544) → screen(1624,1088) ok');
    expect(text).toContain(
      'If the step is now satisfied, answer with `noop`. Do not repeat an action that already ' +
        'succeeded unless the screen shows it did not take effect.',
    );
  });

  it('omits the section on the first turn, when nothing has been performed', () => {
    expect(contentBlocksToText(buildComputerStepMessage(base).content)).not.toContain(
      'Actions already performed',
    );
    expect(
      contentBlocksToText(buildComputerStepMessage({ ...base, performed: [] }).content),
    ).not.toContain('Actions already performed');
  });

  it('puts last turn\'s refusals in front of the model (§5.4)', () => {
    const text = contentBlocksToText(
      buildComputerStepMessage({ ...base, refusals: ['"hover" is a page action'] }).content,
    );
    expect(text).toContain('## Your last answer was refused');
    expect(text).toContain('"hover" is a page action');
  });

  it('lists what the last answer asked for and did not get, under its own heading (§5.5)', () => {
    const text = contentBlocksToText(
      buildComputerStepMessage({
        ...base,
        notPerformed: ['noop — only the first screen-changing action of a response is performed'],
      }).content,
    );
    expect(text).toContain(
      '## Not performed from your last answer\n' +
        '- noop — only the first screen-changing action of a response is performed',
    );
    expect(text).not.toContain('refused');
  });

  it('puts a failed action\'s message in front of it too', () => {
    const text = contentBlocksToText(
      buildComputerStepMessage({ ...base, priorFailure: 'No window\'s title contains "Save As".' })
        .content,
    );
    expect(text).toContain('The last action did not succeed');
    expect(text).toContain('Save As');
  });

  it('carries prior steps when there are any', () => {
    const text = contentBlocksToText(
      buildComputerStepMessage({ ...base, conversationHistory: ['1. Navigate to statement.pdf'] })
        .content,
    );
    expect(text).toContain('## Prior Steps');
    expect(text).toContain('1. Navigate to statement.pdf');
  });
});

describe('zoomNote — §5.3', () => {
  it('quotes the model\'s own numbers back', () => {
    expect(zoomNote({ x: 1, y: 2, width: 3, height: 4 })).toBe(
      'This is a zoomed view of region (1, 2, 3, 4) of the previous screenshot; coordinates you ' +
        'return now are in THIS image.',
    );
  });
});

/**
 * §8 — the PAGE prompt's one new sentence.
 *
 * Lives here rather than in a page-prompt suite because it is the net for the
 * phrasings §4.2 cannot catch: the directive never reaches a model when it is
 * spelled right, so this sentence is what answers "use the computer to open
 * the print dialog" written as prose. It must name the unachievable outcome
 * and must rule out `noop`, which reports success for a step that did nothing.
 */
describe('the page prompt refuses a surface change (§8)', () => {
  it('names it unachievable and rules out noop', () => {
    const text = contentBlocksToText(buildSystemPrompt('', undefined, { dismissalGuidance: false }));

    expect(text).toContain('CHANGING SURFACE IS NOT A PAGE ACTION');
    expect(text).toContain('UNACHIEVABLE');
    expect(text).toContain('[use computer]');
    expect(text).toMatch(/never answer it with "noop"/i);
  });
});
