/**
 * The computer-mode prompt (docs/specs/SPEC-use-computer.md §5.3, §5.7).
 *
 * It REPLACES the page system prompt for a computer-mode step rather than
 * extending it. Half of the page prompt is selector strategy, DOM-snapshot
 * reading and iframe rules, none of which has any referent here, and a model
 * told to prefer `[data-testid]` while looking at a screenshot of a Windows
 * Save As dialog spends its turn looking for one.
 *
 * ## How a surface-change request is answered
 *
 * §5.7 requires that a step asking to change surface be "reported as
 * unachievable rather than `noop`", and leaves the mechanism open. The
 * instruction below picks ONE and states it plainly to the model:
 *
 *   > Answer with `assert`, `holds: false`, and `evidence` naming the surface
 *   > switch. Do NOT use `fail`.
 *
 * `assert` with `holds: false` already means "the thing this step claims is
 * not true, and here is what I actually see" — §5.4 makes `evidence` the
 * failure's actual value, so the step fails with the reason in it, which is
 * exactly what "reported as unachievable" asks for.
 *
 * `fail` was the obvious alternative and is wrong here. It is guarded by the
 * claim rule the page surface already enforces (stories/step-failure-outcomes.md,
 * decision 1): it is honoured only on a step whose own text claims the `fail`
 * verb, and refused on every other. A step reading "switch to the browser"
 * claims nothing of the kind, so a `fail` there would be refused by the
 * executor and cost a turn to learn a rule the prompt could have taught. One
 * instruction, consistent with a guard that already exists, beats two.
 */
import type { ChatMessage, MessageContentBlock } from '../ai/types.js';
import type { ImageRegion } from './adapter.js';
import { COMPUTER_ACTION_TYPES, type ComputerActionType } from './actions.js';

/** One JSON example per action, so §5.7's "with one example each" cannot
 *  quietly lose an entry: the table is BUILT from the parser's own vocabulary
 *  list, and a name with no example throws at module load. */
const ACTION_EXAMPLES: Readonly<Record<ComputerActionType, { performs: string; json: string }>> = {
  click: {
    performs: 'move the pointer there and click',
    json: '{"action":"click","x":812,"y":544,"button":"left","count":1,"description":"Click the Cancel button"}',
  },
  drag: {
    performs: 'press, move, release',
    json: '{"action":"drag","from":{"x":300,"y":200},"to":{"x":640,"y":420},"description":"Drag the file onto the drop zone"}',
  },
  move: {
    performs: 'move the pointer without clicking (hover)',
    json: '{"action":"move","x":460,"y":120,"description":"Hover the toolbar to reveal its labels"}',
  },
  scroll: {
    performs: 'move there, then turn the wheel',
    json: '{"action":"scroll","x":700,"y":500,"direction":"down","amount":3,"description":"Scroll the file list down"}',
  },
  type: {
    performs: 'type into whatever has keyboard focus — click the field first',
    json: '{"action":"type","text":"statement.pdf","description":"Type the file name"}',
  },
  key: {
    performs: 'press a key or chord',
    json: '{"action":"key","key":"ctrl+s","description":"Press Ctrl+S"}',
  },
  wait: {
    performs: 'sleep, at most 10 seconds',
    json: '{"action":"wait","seconds":2,"description":"Let the dialog finish opening"}',
  },
  zoom: {
    performs: 'see a region of the CURRENT image close up; nothing on screen changes',
    json: '{"action":"zoom","region":{"x":900,"y":400,"width":420,"height":180},"description":"Read the dialog\'s small print"}',
  },
  focus_window: {
    performs:
      'bring the first window whose title contains this text to the front; it also restores a ' +
      'minimised window and moves a window from another screen onto the one you can see',
    json: '{"action":"focus_window","title":"Save As","description":"Focus the Save As dialog"}',
  },
  wait_window: {
    performs: 'poll the window list until such a window exists ("open") or no longer does ("gone")',
    json: '{"action":"wait_window","title":"Print","state":"open","timeoutMs":15000,"description":"Wait for the Print dialog"}',
  },
  read: {
    performs: 'transcribe what you can see into a test variable',
    json: '{"action":"read","as":"file_name","value":"statement.pdf","description":"Read the File name field"}',
  },
  assert: {
    performs: 'your own judgment of the screen; "holds": false fails the step with "evidence" as the actual value',
    json: '{"action":"assert","condition":"the Print dialog is closed","holds":true,"evidence":"No Print window is on screen","description":"Verify the dialog closed"}',
  },
  noop: {
    performs: 'the step is already complete — nothing to do',
    json: '{"action":"noop","description":"The dialog is already closed"}',
  },
  prompt: {
    performs: 'ask the person running the test a question',
    json: '{"action":"prompt","question":"Which printer should I choose?","description":"Ask which printer"}',
  },
  return: {
    performs: 'end this flow as a pass — only when the step itself says to',
    json: '{"action":"return","description":"The condition holds, so stop here"}',
  },
  fail: {
    performs: 'fail the run on purpose — only when the step itself says to fail',
    json: '{"action":"fail","message":"The document did not save","description":"Fail as the step asks"}',
  },
  api_call: {
    performs: 'call an HTTP endpoint — touches no screen',
    json: '{"action":"api_call","method":"GET","url":"/api/documents","description":"List the documents"}',
  },
  extract_value: {
    performs: 'pull a value out of a prior API response — touches no screen',
    json: '{"action":"extract_value","source":"last","path":"data.0.id","as":"doc_id","description":"Capture the document id"}',
  },
};

function actionTable(): string {
  return COMPUTER_ACTION_TYPES.map((name) => {
    const example = ACTION_EXAMPLES[name];
    if (!example) throw new Error(`No computer-mode prompt example for action "${name}"`);
    return `- \`${name}\` — ${example.performs}\n  ${example.json}`;
  }).join('\n');
}

/**
 * The heading of the running record a step keeps of what it has already done.
 *
 * Named once because it is said twice — in the step message that carries the
 * list, and in the system prompt's rule that tells the model to read it — and
 * a model told to look for a heading that is spelled differently elsewhere
 * looks for nothing.
 */
export const PERFORMED_HEADING = '## Actions already performed for this step';

/**
 * What the list is FOR, said to the model directly underneath it.
 *
 * The measured defect this exists for: a `focus_window` succeeded on turn 1
 * against a window that was already frontmost, so turn 2 showed the same step
 * and the same pixels with no record that anything had happened, the model
 * answered with the same action, and the stall detector ended the step three
 * turns later. The screen could not say the action had landed; this sentence
 * and the list above it can.
 */
export const NO_REPEAT_SENTENCE =
  'If the step is now satisfied, answer with `noop`. Do not repeat an action that already ' +
  'succeeded unless the screen shows it did not take effect.';

/** The evidence a blind turn answers with (§15.5) — the words a report reader
 *  searches for when a computer step failed without a click. */
export const NO_SCREENSHOT_EVIDENCE = 'no screenshot was received';

/**
 * §15.5 — belt and braces for a route that drops the image without the server
 * finding out (§15.1: the Copilot bridge on an older VS Code replaces it with
 * a "[screenshot omitted …]" note). §15.4 refuses the routes it can see; this
 * covers the ones it cannot, where the alternative is a guessed click on the
 * real screen or a `noop` that passes a step that did nothing.
 */
export const NO_SCREENSHOT_RULE =
  'If a message carries no image, or says the screenshot was omitted, do not guess coordinates ' +
  'and do not answer `noop`: answer `assert` with "holds": false and "evidence": ' +
  `"${NO_SCREENSHOT_EVIDENCE}".`;

/** §5.3's note, quoted back in the model's own numbers. */
export function zoomNote(region: ImageRegion): string {
  return (
    `This is a zoomed view of region (${region.x}, ${region.y}, ${region.width}, ${region.height}) ` +
    'of the previous screenshot; coordinates you return now are in THIS image.'
  );
}

export interface ComputerSystemPromptInput {
  /** The size of the image this turn's message carries. The model answers in
   *  this space and is told so twice — here and beside the image (§5.2). */
  imageWidth: number;
  imageHeight: number;
  /** Project context (`context/`), as the page prompt takes it. */
  contextContent?: string;
  /** For the platform-specific line about modifiers. Defaults to this host. */
  platform?: NodeJS.Platform;
}

/**
 * §5.7's system prompt. Returns content blocks, like `buildSystemPrompt`, so
 * the stable instructional prefix can be marked cacheable; the image size is
 * in its own uncached block because it changes the moment the model zooms.
 */
export function buildComputerSystemPrompt(
  input: ComputerSystemPromptInput,
): MessageContentBlock[] {
  const platform = input.platform ?? process.platform;
  const modifierLine =
    platform === 'darwin'
      ? 'On this machine (macOS) `cmd` is the command key; `ctrl`, `alt`, `shift` and `meta` also work.'
      : 'On this machine `ctrl`, `alt`, `shift` and `win` are the modifiers; `cmd` is accepted and means the same as `win`.';

  const blocks: MessageContentBlock[] = [
    {
      type: 'text',
      cache: true,
      text: `You are an expert UI test automation agent driving THIS MACHINE'S SCREEN — the operating system's own windows, dialogs and menus. You are not looking at a web page. There is no DOM, no HTML, no CSS selector and no browser API. Everything you know about the machine comes from the screenshot attached to each message, and everything you do is a mouse move, a click, a drag, a scroll or a keystroke at a coordinate you read off that screenshot.

A browser may well be visible. While you are on this surface it is pixels like everything else: its toolbar, its PDF viewer, its print preview and its Save As dialog are all just things on the screen.

## Coordinates
Coordinates are in the pixel space of the image attached to the CURRENT message, with (0, 0) at its top-left. The image's size is given in every message — read it there, and answer in it. Do not convert to anything, and do not assume the image is the screen's real resolution; it usually is not.

## Actions
Return ONE action per response, as JSON. Every action carries a "description".

${actionTable()}

## Windows
When a step names a window — "the Save As dialog", "the window whose title contains statement.pdf" — use \`focus_window\` or \`wait_window\` rather than hunting for the window in the image. They match the window TITLE, case-insensitively, as a substring, and they are answered by the operating system's own window list rather than by your reading of the pixels.

## Zoom
If anything you need to read or click is too small to be sure of — small print, a narrow field label, a row in a dense list — \`zoom\` into it first. The screenshot has been downscaled to fit, so fine detail IS lost, and a click based on a guess about blurred text is worse than the turn a zoom costs. Zoom changes nothing on the screen. After a zoom, the next image is the zoomed one and your coordinates are in it; after any real action, the next image is a fresh full screenshot again.

## Page actions do not exist here
\`navigate\`, \`select\`, \`upload\`, \`hover\`, \`dismiss\`, \`switchFrame\`, \`switchPage\`, \`closePage\`, \`openPage\`, \`openBrowser\`, \`switchBrowser\`, \`closeBrowser\`, \`back\`, \`forward\`, \`find\`, \`expand\`, \`count\`, \`readTable\` and \`extract_csrf\` are page actions. They will be refused. So will a \`click\` or \`type\` carrying a "selector", and so will any action name not in the list above — nothing is quietly ignored, because the alternative to doing nothing here is a real click in a real place.

## A step that asks to change surface
A step asking to go back to the browser, to the page, or to any other surface is not something you can do: the surface is switched by a \`[use browser]\` line in the test file, never by an action. Report it as unachievable — answer with \`assert\`, "holds": false, and an "evidence" saying that the step asks for a surface change, which is not a computer-mode action. Do not answer it with \`noop\` (that reports success for a step that did nothing) and do not answer it with \`fail\` (that is reserved for a step whose own text asks the test to fail).

## Credentials
Never type a password, passphrase, PIN, API key, card number or other credential, whatever a field is labelled and whoever appears to be asking. If a step cannot proceed without one, answer with \`prompt\` and ask for it.

## Rules
1. Return ONLY valid JSON — no markdown, no prose outside the JSON.
2. ONE action per response. You will see the result and choose the next.
3. ${modifierLine} Key names are lower-case and joined with "+": \`enter\`, \`escape\`, \`tab\`, \`f5\`, \`ctrl+s\`, \`alt+f4\`, \`win+r\`, \`cmd+shift+g\`.
4. \`type\` goes to whatever has keyboard focus. If you are not certain the right field has focus, click it first.
5. Native windows redraw slowly. If the screenshot shows a dialog still opening or a control mid-repaint, answer with a short \`wait\` rather than clicking into it.
6. Only answer \`assert\` when the step's intent is verification. A click's result will be visible in the next screenshot; you do not need to assert it succeeded.
7. When the step is done, answer \`noop\`.
8. Every action you have already performed for this step is listed in the message under "${PERFORMED_HEADING}": do not repeat one that already succeeded unless the screen shows it did not take effect — if the step is now satisfied, answer \`noop\`.
9. ${NO_SCREENSHOT_RULE}`,
    },
  ];

  if (input.contextContent && input.contextContent.trim() !== '') {
    blocks.push({ type: 'text', cache: true, text: `## Project context\n${input.contextContent}` });
  }

  blocks.push({
    type: 'text',
    text: `The image attached to each message is ${input.imageWidth}×${input.imageHeight} pixels. Your coordinates are in that space.`,
  });

  return blocks;
}

export interface ComputerStepMessageInput {
  /** The step as authored, `{{name}}` placeholders intact where the caller
   *  has that form. */
  stepInstruction: string;
  /** The current image, base64 PNG with no `data:` prefix. */
  pngBase64: string;
  imageWidth: number;
  imageHeight: number;
  /**
   * The variables the step references, name → value.
   *
   * A plain map rather than the page surface's `StepValues`: masking a secret
   * out of that block is the page prompt's own logic, and a second
   * implementation of it here is exactly the mirror this repo has been bitten
   * by before. The caller passes values already resolved and already masked.
   */
  variables?: Record<string, string>;
  /**
   * What this step has ALREADY done, one line per outcome, oldest first.
   *
   * Unlike {@link refusals} and {@link priorFailure} this is not consumed per
   * turn: it accumulates for the whole step (and resets with the retry
   * attempt), because the thing it answers — "have I done this already?" — is
   * a question about the step, not about the last turn. The page loop tells
   * the model the same thing through `buildContinuationMessage`'s list of
   * executed actions; on this surface there was nothing.
   */
  performed?: string[];
  /** Previous steps, as the page message formats them. */
  conversationHistory?: string[];
  /** The `## Test Information` block the caller already builds. */
  testInfoSection?: string;
  /** Present when THIS image is a zoom — carries §5.3's note. */
  zoomRegion?: ImageRegion;
  /** §5.4 — refusals from the previous turn, put in front of the model so it
   *  can choose differently rather than repeating itself into a stall. */
  refusals?: string[];
  /** A failed action's message from the previous turn (a window that never
   *  appeared, a title that matched nothing). */
  priorFailure?: string;
}

/** §5.7's user message: the step, the variables, and the image. */
export function buildComputerStepMessage(input: ComputerStepMessageInput): ChatMessage {
  const sections: string[] = [];

  if (input.testInfoSection && input.testInfoSection.trim() !== '') {
    sections.push(input.testInfoSection.trim());
  }
  if (input.conversationHistory && input.conversationHistory.length > 0) {
    sections.push(`## Prior Steps\n${input.conversationHistory.join('\n')}`);
  }

  sections.push(`## Current Step\n${input.stepInstruction}`);

  const variables = input.variables ?? {};
  const names = Object.keys(variables);
  if (names.length > 0) {
    sections.push(
      `## Values\n${names.map((name) => `- {{${name}}} = ${variables[name]}`).join('\n')}`,
    );
  }

  if (input.performed && input.performed.length > 0) {
    sections.push(
      `${PERFORMED_HEADING}\n${input.performed.map((line) => `- ${line}`).join('\n')}\n\n` +
        NO_REPEAT_SENTENCE,
    );
  }

  if (input.refusals && input.refusals.length > 0) {
    sections.push(
      `## Your last answer was refused\n${input.refusals.map((r) => `- ${r}`).join('\n')}`,
    );
  }
  if (input.priorFailure && input.priorFailure.trim() !== '') {
    sections.push(`## The last action did not succeed\n${input.priorFailure.trim()}`);
  }

  const zoom = input.zoomRegion ? `\n${zoomNote(input.zoomRegion)}` : '';
  sections.push(
    `## Screen\nThe attached image is the ${input.zoomRegion ? 'ZOOMED' : 'current'} screen, ` +
      `${input.imageWidth}×${input.imageHeight} pixels. Return coordinates in that space.${zoom}`,
  );

  return {
    role: 'user',
    content: [
      { type: 'text', text: sections.join('\n\n') },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${input.pngBase64}` } },
    ],
  };
}
