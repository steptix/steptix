/**
 * The computer surface's action vocabulary
 * (docs/specs/SPEC-use-computer.md §5.4).
 *
 * A separate union from `AIAction`, deliberately. The page vocabulary is
 * selector-shaped and this one is coordinate-shaped, and the one overlap —
 * `click` and `type` — means something different in each. Sharing the type
 * would have made "a `click` with a selector" representable on this surface,
 * which is precisely the thing §5.4 refuses.
 *
 * Coordinates are in the CURRENT image's pixel space (§5.2, §5.3), never in
 * screen points: the model is told the image size and answers in it, and
 * `capture.mapToScreen` is the only thing that knows the difference.
 */
import type { ImageRegion, MouseButton, ClickCount, ScrollDirection } from './adapter.js';

/** Fields every action carries. */
export interface ComputerActionBase {
  /** What the model says this action does — as on the page surface. */
  description: string;
  /**
   * The model's own object, as parsed.
   *
   * Carried so the caller's run loop can hand the actions this executor does
   * NOT perform — `api_call`, `extract_value`, `prompt`, `return`, `fail` —
   * to the page-surface machinery that already implements them (§5.4: "as
   * today — they touch no surface"), without a second parser having to
   * reconstruct fields this one deliberately does not model.
   */
  raw?: Record<string, unknown>;
}

export interface ComputerClickAction extends ComputerActionBase {
  action: 'click';
  x: number;
  y: number;
  button: MouseButton;
  count: ClickCount;
}

export interface ComputerDragAction extends ComputerActionBase {
  action: 'drag';
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface ComputerMoveAction extends ComputerActionBase {
  action: 'move';
  x: number;
  y: number;
}

export interface ComputerScrollAction extends ComputerActionBase {
  action: 'scroll';
  x: number;
  y: number;
  direction: ScrollDirection;
  /** Wheel ticks. Default 3 (§5.4). */
  amount: number;
}

export interface ComputerTypeAction extends ComputerActionBase {
  action: 'type';
  text: string;
}

export interface ComputerKeyAction extends ComputerActionBase {
  action: 'key';
  /** A chord in the §5.4 grammar, already validated by `keys.parseChord`. */
  key: string;
}

export interface ComputerWaitAction extends ComputerActionBase {
  action: 'wait';
  /** Seconds, capped at {@link MAX_WAIT_SECONDS}. */
  seconds: number;
}

export interface ComputerZoomAction extends ComputerActionBase {
  action: 'zoom';
  /** In the coordinates of the image the model was last shown (§5.3). */
  region: ImageRegion;
}

export interface ComputerFocusWindowAction extends ComputerActionBase {
  action: 'focus_window';
  title: string;
}

export interface ComputerWaitWindowAction extends ComputerActionBase {
  action: 'wait_window';
  title: string;
  state: 'open' | 'gone';
  timeoutMs: number;
}

export interface ComputerReadAction extends ComputerActionBase {
  action: 'read';
  as: string;
  value: string;
}

export interface ComputerAssertAction extends ComputerActionBase {
  action: 'assert';
  condition: string;
  holds: boolean;
  evidence: string;
}

export interface ComputerNoopAction extends ComputerActionBase {
  action: 'noop';
  /** Present when the parser turned something else into a no-op — a
   *  `screenshot` request, for instance, whose reason tells the model that
   *  captures are automatic. */
  reason?: string;
}

export interface ComputerPromptAction extends ComputerActionBase {
  action: 'prompt';
  question: string;
}

export interface ComputerReturnAction extends ComputerActionBase {
  action: 'return';
}

export interface ComputerFailAction extends ComputerActionBase {
  action: 'fail';
  message?: string;
}

export interface ComputerApiCallAction extends ComputerActionBase {
  action: 'api_call';
  raw: Record<string, unknown>;
}

export interface ComputerExtractValueAction extends ComputerActionBase {
  action: 'extract_value';
  raw: Record<string, unknown>;
}

export type ComputerAction =
  | ComputerClickAction
  | ComputerDragAction
  | ComputerMoveAction
  | ComputerScrollAction
  | ComputerTypeAction
  | ComputerKeyAction
  | ComputerWaitAction
  | ComputerZoomAction
  | ComputerFocusWindowAction
  | ComputerWaitWindowAction
  | ComputerReadAction
  | ComputerAssertAction
  | ComputerNoopAction
  | ComputerPromptAction
  | ComputerReturnAction
  | ComputerFailAction
  | ComputerApiCallAction
  | ComputerExtractValueAction;

export type ComputerActionType = ComputerAction['action'];

/** Every action name the computer surface accepts, in §5.4's table order.
 *  Used by the parser's refusal message and by the prompt's action table, so
 *  the two can never list different vocabularies. */
export const COMPUTER_ACTION_TYPES: readonly ComputerActionType[] = [
  'click',
  'drag',
  'move',
  'scroll',
  'type',
  'key',
  'wait',
  'zoom',
  'focus_window',
  'wait_window',
  'read',
  'assert',
  'noop',
  'prompt',
  'return',
  'fail',
  'api_call',
  'extract_value',
];

/** §5.4 — `wait` takes seconds, at most this many. */
export const MAX_WAIT_SECONDS = 10;

/** §5.4 — `scroll`'s default tick count. */
export const DEFAULT_SCROLL_TICKS = 3;

/** §5.4 — `wait_window`'s default budget. */
export const DEFAULT_WAIT_WINDOW_TIMEOUT_MS = 15_000;

/** The actions this surface performs itself. The rest (`read`, `assert`,
 *  `noop`, `prompt`, `return`, `fail`, `api_call`, `extract_value`) are the
 *  run loop's business, and the executor says so by answering
 *  `performed: false`. */
export const SCREEN_ACTION_TYPES: ReadonlySet<ComputerActionType> = new Set<ComputerActionType>([
  'click',
  'drag',
  'move',
  'scroll',
  'type',
  'key',
  'wait',
  'focus_window',
  'wait_window',
]);
