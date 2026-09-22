/**
 * The computer surface's action parser (docs/specs/SPEC-use-computer.md §5.4).
 *
 * The COMPUTER-mode counterpart of `src/ai/action-parser.ts`, and separate
 * from it on purpose: the two vocabularies overlap in two names (`click`,
 * `type`) and mean different things by both. What they DO share is the
 * envelope, and that is shared by import rather than by copy — `extractJson`
 * comes from the page parser, so a model that fences its JSON, prefixes prose
 * or emits two objects is handled identically on both surfaces and can only
 * ever be fixed once.
 *
 * The one rule that separates this parser from its page sibling: an
 * unrecognised action type is REFUSED, never kept as a no-op that reports
 * success (§5.4). On the page surface that defect costs a step that quietly
 * did nothing; here the alternative to doing nothing is a real click at a real
 * coordinate, so a silently-kept unknown is a mouse event nobody asked for.
 *
 * Refusals are data, not exceptions: each one names the offending object and a
 * reason written FOR THE MODEL, because §5.4 puts it in front of the model on
 * its next turn. A response that is not JSON at all still throws, as on the
 * page surface — there is no action to refuse and the turn is lost either way.
 */
import { extractJson } from '../ai/action-parser.js';
import { logger } from '../utils/logger.js';
import { parseChord } from './keys.js';
import type { ClickCount, ImageRegion, MouseButton, ScrollDirection } from './adapter.js';
import {
  COMPUTER_ACTION_TYPES,
  DEFAULT_SCROLL_TICKS,
  DEFAULT_WAIT_WINDOW_TIMEOUT_MS,
  MAX_WAIT_SECONDS,
  type ComputerAction,
} from './actions.js';

/** One action the parser would not build, and why — in words the model reads. */
export interface ComputerActionRefusal {
  /** The model's own object, untouched. */
  raw: unknown;
  reason: string;
}

export interface ParsedComputerActions {
  actions: ComputerAction[];
  refused: ComputerActionRefusal[];
  /** The envelope's `reasoning`, as on the page surface. */
  reasoning: string;
}

/**
 * Fold an action name to one canonical spelling: lower-case, with `_`, `-`
 * and spaces removed. `switchFrame`, `switch_frame` and `Switch Frame` are one
 * name, which is what lets a single table cover every spelling a model reaches
 * for instead of a row per variant.
 */
function foldName(name: string): string {
  return name.trim().toLowerCase().replace(/[_\-\s]/g, '');
}

/** What an alias resolves to, plus any fields the alias itself implies. */
interface AliasTarget {
  type: string;
  button?: MouseButton;
  count?: ClickCount;
  direction?: ScrollDirection;
  /** Recorded on the built action, for the model and the log. */
  note?: string;
}

const ALIASES: Readonly<Record<string, AliasTarget>> = {
  // §5.4: "`keyboard` and `keypress` are aliased to `key`".
  keyboard: { type: 'key' },
  keypress: { type: 'key' },
  press: { type: 'key' },
  presskey: { type: 'key' },
  sendkeys: { type: 'key' },

  // The computer-use vocabulary every vision model has been trained on. These
  // are not guesses about what a model MIGHT emit: they are the action names
  // Anthropic's and OpenAI's computer-use tools define, so a model reaching
  // for them is the expected case rather than the odd one.
  leftclick: { type: 'click' },
  doubleclick: { type: 'click', count: 2 },
  dblclick: { type: 'click', count: 2 },
  tripleclick: { type: 'click', count: 3 },
  rightclick: { type: 'click', button: 'right' },
  middleclick: { type: 'click', button: 'middle' },
  mousemove: { type: 'move' },
  movemouse: { type: 'move' },
  leftclickdrag: { type: 'drag' },
  scrolldown: { type: 'scroll', direction: 'down' },
  scrollup: { type: 'scroll', direction: 'up' },
  scrollleft: { type: 'scroll', direction: 'left' },
  scrollright: { type: 'scroll', direction: 'right' },
  typetext: { type: 'type' },
  sleep: { type: 'wait' },

  // A capture is taken before every turn (§5.2), so asking for one is not an
  // error — it is a turn spent learning that. Say so in the no-op's reason.
  screenshot: {
    type: 'noop',
    note: 'A fresh screenshot is captured automatically before every turn — you do not need to ask for one. Use "zoom" to see a region more closely.',
  },
  takescreenshot: {
    type: 'noop',
    note: 'A fresh screenshot is captured automatically before every turn — you do not need to ask for one. Use "zoom" to see a region more closely.',
  },
  capturescreen: {
    type: 'noop',
    note: 'A fresh screenshot is captured automatically before every turn — you do not need to ask for one. Use "zoom" to see a region more closely.',
  },

  waitforwindow: { type: 'waitwindow' },
  activatewindow: { type: 'focuswindow' },
  raisewindow: { type: 'focuswindow' },

  // Mirrors of the page parser's own api_call aliases, so the two surfaces
  // accept the same spellings for the one action that behaves identically on
  // both (§5.4: "as today — they touch no surface").
  api: { type: 'apicall' },
  http: { type: 'apicall' },
  request: { type: 'apicall' },
  httprequest: { type: 'apicall' },
  fetch: { type: 'apicall' },
};

/**
 * Every PAGE action name §5.4 refuses on this surface, folded — including the
 * spellings `src/ai/action-parser.ts` aliases, because a model that says
 * `goBack` has asked for the browser's history just as plainly as one that
 * says `back`, and answering the two differently would teach it nothing.
 */
const PAGE_ACTION_NAMES: ReadonlySet<string> = new Set([
  'navigate', 'goto', 'open', 'openurl',
  'select', 'selectoption',
  'upload', 'attach', 'attachfile', 'fileupload', 'uploadfile', 'setfiles', 'setinputfiles',
  'hover',
  'dismiss',
  'switchframe', 'switchtoframe',
  'switchpage', 'switchtab', 'switchwindow',
  'closepage', 'closetab', 'closewindow',
  'openpage', 'opentab', 'openwindow', 'newtab', 'newwindow',
  'openbrowser', 'newbrowser',
  'switchbrowser',
  'closebrowser',
  'back', 'goback', 'browserback', 'navigateback', 'historyback',
  'forward', 'goforward', 'browserforward', 'navigateforward', 'historyforward',
  'find',
  'expand',
  'count',
  'readtable',
  'extractcsrf', 'csrf', 'getcsrf',
]);

/** The canonical (folded) computer action names. */
const COMPUTER_NAMES: ReadonlySet<string> = new Set(COMPUTER_ACTION_TYPES.map(foldName));

/** The list every refusal message ends with. */
const VOCABULARY = COMPUTER_ACTION_TYPES.join(', ');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first of `names` holding a finite number. */
function numberField(obj: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = obj[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** The first of `names` holding a string. */
function stringField(obj: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = obj[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * A point, however the model spelled it: `{x, y}` on the action itself, a
 * nested `{point: {x, y}}`, or `{coordinate: [x, y]}` — the shape the
 * computer-use tool definitions use, and therefore the shape a vision model
 * reaches for first.
 *
 * Non-negative and finite, because a negative coordinate is not a point on a
 * screenshot and rounding one into the mapping would click an edge.
 */
function pointField(value: unknown): { x: number; y: number } | undefined {
  if (Array.isArray(value) && value.length >= 2) {
    const [x, y] = value;
    if (typeof x === 'number' && typeof y === 'number') return finitePoint(x, y);
    return undefined;
  }
  if (isPlainObject(value)) {
    const x = numberField(value, 'x');
    const y = numberField(value, 'y');
    if (x !== undefined && y !== undefined) return finitePoint(x, y);
  }
  return undefined;
}

function finitePoint(x: number, y: number): { x: number; y: number } | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (x < 0 || y < 0) return undefined;
  return { x, y };
}

/** The action's own point, from `x`/`y`, `point` or `coordinate`. */
function actionPoint(obj: Record<string, unknown>): { x: number; y: number } | undefined {
  const x = numberField(obj, 'x');
  const y = numberField(obj, 'y');
  if (x !== undefined && y !== undefined) return finitePoint(x, y);
  return pointField(obj['point']) ?? pointField(obj['coordinate']) ?? pointField(obj['coordinates']);
}

function regionField(value: unknown): ImageRegion | undefined {
  if (Array.isArray(value) && value.length >= 4) {
    const [x, y, width, height] = value as unknown[];
    if ([x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return { x: x as number, y: y as number, width: width as number, height: height as number };
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  const x = numberField(value, 'x', 'left');
  const y = numberField(value, 'y', 'top');
  const width = numberField(value, 'width', 'w');
  const height = numberField(value, 'height', 'h');
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function clickCount(value: number | undefined, fallback: ClickCount): ClickCount {
  if (value === 1 || value === 2 || value === 3) return value;
  return fallback;
}

function mouseButton(value: string | undefined, fallback: MouseButton): MouseButton {
  const folded = value?.trim().toLowerCase();
  if (folded === 'left' || folded === 'right' || folded === 'middle') return folded;
  return fallback;
}

function scrollDirection(value: string | undefined): ScrollDirection | undefined {
  const folded = value?.trim().toLowerCase();
  if (folded === 'up' || folded === 'down' || folded === 'left' || folded === 'right') {
    return folded;
  }
  return undefined;
}

/** Either an action or the reason it was refused — the parser's per-item answer. */
type Built = { action: ComputerAction } | { refusal: string };

function refuse(reason: string): Built {
  return { refusal: reason };
}

function pageActionRefusal(name: string): string {
  return (
    `"${name}" is a page action and does not exist in computer mode. You are driving the ` +
    `operating system's screen, not a web page: there is no DOM and no selector. Point at what ` +
    `you can see, with coordinates from the current image. Valid actions: ${VOCABULARY}.`
  );
}

function unknownActionRefusal(name: string): string {
  return `Unknown action "${name}" — it does nothing on this surface. Valid actions: ${VOCABULARY}.`;
}

function buildAction(raw: unknown): Built {
  if (!isPlainObject(raw)) return refuse('An action must be a JSON object.');

  // `type` as a fallback, but not `name`: `focus_window` and `wait_window`
  // both accept `name` for their TITLE, so reading it as the action's name
  // would turn a well-formed window action into an unknown one.
  const rawType = raw['action'] ?? raw['type'];
  if (typeof rawType !== 'string' || rawType.trim() === '') {
    return refuse(`An action needs an "action" field naming one of: ${VOCABULARY}.`);
  }

  const folded = foldName(rawType);
  const alias = ALIASES[folded];
  const type = alias?.type ?? folded;

  if (PAGE_ACTION_NAMES.has(type)) return refuse(pageActionRefusal(rawType));
  if (!COMPUTER_NAMES.has(type)) return refuse(unknownActionRefusal(rawType));

  const description = stringField(raw, 'description') ?? `${type} action`;
  const base = { description, raw };

  switch (type) {
    case 'click': {
      if (typeof raw['selector'] === 'string' && raw['selector'].trim() !== '') {
        return refuse(
          'A computer-mode "click" targets a point on the screen, not an element: there is no ' +
            'selector here. Drop "selector" and give "x" and "y" in the current image\'s pixel space.',
        );
      }
      const point = actionPoint(raw);
      if (!point) {
        return refuse(
          '"click" needs finite, non-negative "x" and "y" in the current image\'s pixel space.',
        );
      }
      return {
        action: {
          ...base,
          action: 'click',
          x: point.x,
          y: point.y,
          button: mouseButton(stringField(raw, 'button'), alias?.button ?? 'left'),
          count: clickCount(numberField(raw, 'count', 'clicks'), alias?.count ?? 1),
        },
      };
    }

    case 'move': {
      const point = actionPoint(raw);
      if (!point) {
        return refuse('"move" needs finite, non-negative "x" and "y" in the current image\'s pixel space.');
      }
      return { action: { ...base, action: 'move', x: point.x, y: point.y } };
    }

    case 'drag': {
      const from = pointField(raw['from']) ?? pointField(raw['start']) ?? pointField(raw['startCoordinate']);
      const to = pointField(raw['to']) ?? pointField(raw['end']) ?? pointField(raw['coordinate']);
      if (!from || !to) {
        return refuse(
          '"drag" needs "from" and "to", each an object with finite, non-negative "x" and "y" in ' +
            "the current image's pixel space.",
        );
      }
      return { action: { ...base, action: 'drag', from, to } };
    }

    case 'scroll': {
      const point = actionPoint(raw);
      if (!point) {
        return refuse(
          '"scroll" needs finite, non-negative "x" and "y" — the point the pointer moves to before ' +
            'the wheel turns.',
        );
      }
      const direction = scrollDirection(stringField(raw, 'direction')) ?? alias?.direction;
      if (!direction) {
        return refuse('"scroll" needs a "direction" of up, down, left or right.');
      }
      const amount = numberField(raw, 'amount', 'ticks', 'clicks', 'steps');
      return {
        action: {
          ...base,
          action: 'scroll',
          x: point.x,
          y: point.y,
          direction,
          amount:
            amount !== undefined && amount > 0 ? Math.round(amount) : DEFAULT_SCROLL_TICKS,
        },
      };
    }

    case 'type': {
      if (typeof raw['selector'] === 'string' && raw['selector'].trim() !== '') {
        return refuse(
          'A computer-mode "type" types into whatever has OS focus, so it takes no "selector". ' +
            'Click the field first, then type.',
        );
      }
      const text = stringField(raw, 'text', 'value');
      if (text === undefined) return refuse('"type" needs a "text" string.');
      return { action: { ...base, action: 'type', text } };
    }

    case 'key': {
      // Not `text`: a `{"action":"key","text":"Hello there"}` is a model that
      // meant `type`, and reading its sentence as a chord would refuse it with
      // a list of key names instead of the one thing it needed to hear.
      const chord = stringField(raw, 'key', 'keys', 'chord');
      if (chord === undefined || chord.trim() === '') {
        return refuse('"key" needs a "key" string, e.g. "enter" or "ctrl+s".');
      }
      // Validated HERE as well as in the adapter. The adapter's refusal fails
      // the step; this one reaches the model on its next turn with the list of
      // names, which is the difference between a run that recovers and one
      // that does not.
      try {
        parseChord(chord);
      } catch (err) {
        return refuse((err as Error).message);
      }
      return { action: { ...base, action: 'key', key: chord.trim() } };
    }

    case 'wait': {
      let seconds = numberField(raw, 'seconds', 'duration', 'amount');
      if (seconds === undefined) {
        const ms = numberField(raw, 'ms', 'milliseconds', 'timeoutMs', 'timeout');
        if (ms !== undefined) seconds = ms / 1000;
      }
      if (seconds === undefined || !(seconds > 0)) {
        return refuse(`"wait" needs a positive "seconds" (at most ${MAX_WAIT_SECONDS}).`);
      }
      // Capped, not refused. A model asking for 30 s has misjudged a budget,
      // not named something meaningless, and spending a turn to tell it so
      // costs more than the 20 s it does not get.
      return { action: { ...base, action: 'wait', seconds: Math.min(seconds, MAX_WAIT_SECONDS) } };
    }

    case 'zoom': {
      const region = regionField(raw['region']) ?? regionField(raw);
      if (!region) {
        return refuse(
          '"zoom" needs a "region" with "x", "y", "width" and "height" in the current image\'s pixel space.',
        );
      }
      if (region.x < 0 || region.y < 0 || !(region.width > 0) || !(region.height > 0)) {
        return refuse(
          `"zoom" region (${region.x}, ${region.y}, ${region.width}, ${region.height}) is not a ` +
            'rectangle inside the current image: x and y must be at least 0 and width and height above 0.',
        );
      }
      return { action: { ...base, action: 'zoom', region } };
    }

    case 'focuswindow': {
      const title = stringField(raw, 'title', 'window', 'name');
      if (title === undefined || title.trim() === '') {
        return refuse('"focus_window" needs a "title" — the text the window\'s title contains.');
      }
      return { action: { ...base, action: 'focus_window', title: title.trim() } };
    }

    case 'waitwindow': {
      const title = stringField(raw, 'title', 'window', 'name');
      if (title === undefined || title.trim() === '') {
        return refuse('"wait_window" needs a "title" — the text the window\'s title contains.');
      }
      const rawState = stringField(raw, 'state', 'until')?.trim().toLowerCase();
      const state =
        rawState === 'open' || rawState === 'present' || rawState === 'visible'
          ? 'open'
          : rawState === 'gone' || rawState === 'closed' || rawState === 'absent'
            ? 'gone'
            : undefined;
      if (!state) {
        return refuse('"wait_window" needs a "state" of "open" or "gone".');
      }
      const timeout = numberField(raw, 'timeoutMs', 'timeout_ms', 'timeout');
      return {
        action: {
          ...base,
          action: 'wait_window',
          title: title.trim(),
          state,
          timeoutMs:
            timeout !== undefined && timeout > 0
              ? Math.round(timeout)
              : DEFAULT_WAIT_WINDOW_TIMEOUT_MS,
        },
      };
    }

    case 'read': {
      const as = stringField(raw, 'as', 'variable', 'name');
      const value = stringField(raw, 'value', 'text');
      if (as === undefined || as.trim() === '') {
        return refuse('"read" needs an "as" — the variable to store what you read.');
      }
      if (value === undefined) {
        return refuse('"read" needs a "value" — what you read on the screen, transcribed.');
      }
      return { action: { ...base, action: 'read', as: as.trim(), value } };
    }

    case 'assert': {
      const condition = stringField(raw, 'condition');
      if (condition === undefined || condition.trim() === '') {
        return refuse('"assert" needs a "condition" — what you checked.');
      }
      const holdsRaw = raw['holds'] ?? raw['pass'] ?? raw['result'];
      if (typeof holdsRaw !== 'boolean') {
        return refuse('"assert" needs a boolean "holds" — true if the condition is met on screen.');
      }
      const evidence = stringField(raw, 'evidence', 'actual');
      // Required when the answer is "no": §5.4 makes `evidence` the actual
      // value the step fails with, and a failure whose actual is blank is the
      // one report nobody can act on.
      if (!holdsRaw && (evidence === undefined || evidence.trim() === '')) {
        return refuse(
          '"assert" with "holds": false needs "evidence" — what you actually see, which becomes ' +
            "the failure's actual value.",
        );
      }
      return {
        action: {
          ...base,
          action: 'assert',
          condition: condition.trim(),
          holds: holdsRaw,
          evidence: evidence ?? '',
        },
      };
    }

    case 'noop': {
      const reason = alias?.note ?? stringField(raw, 'reason');
      return { action: { ...base, action: 'noop', ...(reason !== undefined && { reason }) } };
    }

    case 'prompt': {
      const question = stringField(raw, 'question', 'text');
      if (question === undefined || question.trim() === '') {
        return refuse('"prompt" needs a "question" to put to the person running the test.');
      }
      return { action: { ...base, action: 'prompt', question: question.trim() } };
    }

    case 'return':
      return { action: { ...base, action: 'return' } };

    case 'fail': {
      const message = stringField(raw, 'message', 'error', 'reason');
      return {
        action: { ...base, action: 'fail', ...(message !== undefined && { message }) },
      };
    }

    case 'apicall':
      return { action: { ...base, action: 'api_call', raw } };

    case 'extractvalue':
      return { action: { ...base, action: 'extract_value', raw } };

    default:
      // Unreachable: `type` was checked against COMPUTER_NAMES above. Refusing
      // rather than asserting keeps the §5.4 rule true even if the two lists
      // ever drift — an action nothing here builds is never kept.
      return refuse(unknownActionRefusal(rawType));
  }
}

/**
 * Parse a computer-mode model response.
 *
 * Throws when the response holds no JSON at all (as the page parser does — the
 * turn is lost either way and the message should name the model's own output).
 * Everything else comes back as actions plus refusals.
 */
export function parseComputerActions(rawModelText: string): ParsedComputerActions {
  const jsonString = extractJson(rawModelText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new Error(
      `Computer-mode AI response is not valid JSON: ${String(err)}\nRaw response:\n${rawModelText.substring(0, 500)}`,
    );
  }

  // The same three envelopes the page parser accepts, plus a single action
  // object under the plural key — a shape smaller models produce when they
  // read "return exactly ONE action" and the wrapper in the same breath.
  let rawActions: unknown[];
  let envelope: Record<string, unknown> = {};
  if (Array.isArray(parsed)) {
    rawActions = parsed;
  } else if (isPlainObject(parsed)) {
    envelope = parsed;
    const actions = parsed['actions'];
    if (Array.isArray(actions)) {
      rawActions = actions;
    } else if (isPlainObject(actions) && typeof actions['action'] === 'string') {
      rawActions = [actions];
    } else if (typeof parsed['action'] === 'string' || typeof parsed['type'] === 'string') {
      rawActions = [parsed];
    } else {
      throw new Error('Computer-mode AI response must have an "actions" array');
    }
  } else {
    throw new Error('Computer-mode AI response must be a JSON object or array');
  }

  const actions: ComputerAction[] = [];
  const refused: ComputerActionRefusal[] = [];
  for (const raw of rawActions) {
    const built = buildAction(raw);
    if ('action' in built) {
      actions.push(built.action);
    } else {
      refused.push({ raw, reason: built.refusal });
      logger.warn(`[computer] refused an action: ${built.refusal}`);
    }
  }

  const reasoning =
    typeof envelope['reasoning'] === 'string' ? envelope['reasoning'] : 'No reasoning provided';

  return { actions, refused, reasoning };
}

/** Exported for the prompt and for tests, so the vocabulary the model is
 *  taught and the vocabulary the parser accepts are the same list. */
export { VOCABULARY as COMPUTER_ACTION_VOCABULARY, PAGE_ACTION_NAMES, foldName };
