/**
 * The computer surface (docs/specs/SPEC-use-computer.md §5).
 *
 * One import site for the run loop, the session manager and the CLI runner.
 * `nut-adapter.js` is deliberately NOT re-exported as a value here: importing
 * this barrel must never be what pulls nut.js in (§5.1 item 2). Load the real
 * adapter with `import('./nut-adapter.js')` where computer mode is entered,
 * which is the one place a load failure has a step to fail.
 */
export type {
  ClickCount,
  ClickOptions,
  DesktopAdapter,
  ImageRegion,
  MouseButton,
  Point,
  ScreenGrab,
  ScrollDirection,
  WindowHandle,
  WindowInfo,
  WindowRef,
  WindowRegion,
  WindowSize,
} from './adapter.js';

export { titleContains } from './adapter.js';

export {
  DEFAULT_BRING_TO_FRONT_SETTLE_MS,
  FIT_MARGIN_PX,
  MIN_VISIBLE_PX,
  SAFE_ORIGIN,
  bringWindowToFront,
  describeBringToFront,
  isEmptyRegion,
  isOffMainDisplay,
  touchesRightOrBottom,
  type BringToFrontOptions,
  type BringToFrontResult,
} from './bring-to-front.js';

export {
  DEFAULT_MAX_IMAGE_WIDTH,
  captureView,
  mapToScreen,
  viewFromGrab,
  viewSourceRect,
  zoomView,
  type CaptureOptions,
  type ImageView,
} from './capture.js';

export {
  COMPUTER_ACTION_TYPES,
  DEFAULT_SCROLL_TICKS,
  DEFAULT_WAIT_WINDOW_TIMEOUT_MS,
  INPUT_ACTION_TYPES,
  MAX_WAIT_SECONDS,
  MAX_WAIT_WINDOW_TIMEOUT_MS,
  SCREEN_ACTION_TYPES,
  SCREEN_CHANGING_ACTION_TYPES,
  type ComputerAction,
  type ComputerActionType,
} from './actions.js';

export {
  COMPUTER_ACTION_VOCABULARY,
  parseComputerActions,
  type ComputerActionRefusal,
  type ParsedComputerActions,
} from './action-parser.js';

export {
  WINDOW_POLL_INTERVAL_MS,
  executeComputerAction,
  type ComputerExecutionContext,
  type ComputerExecutionResult,
} from './executor.js';

export {
  COMPUTER_STALL_TURNS,
  ComputerStallDetector,
  computerStallMessage,
  fingerprintActions,
} from './stall.js';

export {
  acquireComputerLock,
  computerLockInUseMessage,
  computerLockPath,
  isPidAlive,
  readComputerLock,
  releaseComputerLock,
  type ComputerLockOptions,
  type ComputerLockRecord,
} from './lock.js';

export {
  buildComputerStepMessage,
  buildComputerSystemPrompt,
  zoomNote,
  type ComputerStepMessageInput,
  type ComputerSystemPromptInput,
} from './prompt.js';

export {
  KNOWN_KEY_NAMES,
  MODIFIER_NAMES,
  chordKeyMembers,
  parseChord,
  type ParsedChord,
} from './keys.js';
