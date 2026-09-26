/**
 * Record Steps — the wire and the recorder's own records
 * (stories/testbench-record-steps.md, "On the wire").
 *
 * The frames below are the server's copy of the contract runner-core's
 * `protocol.ts` mirrors on the client side; the story's "On the wire" section is
 * the binding statement of both.
 */

/** What one recorded event was (docs/specs/SPEC-record-steps.md §4). */
export type RecordActionKind =
  | 'click'
  | 'type'
  | 'select'
  | 'tick'
  | 'untick'
  | 'key'
  | 'upload'
  | 'navigate'
  | 'tab'
  | 'check'
  | 'drag'
  | 'back'
  | 'forward'
  | 'reload';

/**
 * The kinds that are ACTIONS — what the author does to move the application
 * on, and what sends the draft to the model (decision 4, the author's
 * definition): a click or a drag, Enter or Tab, the browser's Back, Forward or
 * Refresh, an address typed into the bar, and the Add check click. Every other
 * kind is an event that rides with the next action.
 */
export const ACTION_KINDS: ReadonlySet<RecordActionKind> = new Set<RecordActionKind>([
  'click', 'drag', 'key', 'back', 'forward', 'reload', 'navigate', 'check',
]);

/**
 * The frames a `POST /sessions/:id/record-steps` stream carries, besides the
 * existing `output` frame (warnings and errors, same shape as a run's).
 *
 * `done` is its own variant rather than a run's: a recording has no report, no
 * healed steps and no settings echo, and it carries `error` — the one sentence a
 * client shows when the recording could not be written — which a run's `done`
 * does not.
 */
export type RecordEvent =
  | { type: 'record:started'; url: string; title: string }
  | {
      type: 'record:action';
      id: string;
      kind: RecordActionKind;
      /** One line for the panel. Secrets masked. */
      summary: string;
      /** Milliseconds since `record:started`. */
      atMs: number;
      /** PageTracker label of the tab the action happened in, when not `main`. */
      tab?: string;
      /** True for an ACTION (`ACTION_KINDS`), false for an event that rides
       *  with the next one. */
      action: boolean;
    }
  | { type: 'record:pick'; armed: boolean }
  /** A draft call started (`busy: true`) or finished (decision 9). */
  | { type: 'record:drafting'; busy: boolean }
  /**
   * The draft as it stands — REPLACES the previous one. `revision` increases
   * by one per draft; `through` is the id of the last action it covers.
   */
  | {
      type: 'record:draft';
      revision: number;
      steps: string[];
      parameters: Array<{ name: string; value: string }>;
      notes?: string[];
      through?: string;
    }
  /** Stop received; finishing the draft. */
  | { type: 'record:writing' }
  | {
      type: 'record:result';
      /** Step texts, no numbers, in order. */
      steps: string[];
      /** Parameters the steps use; `$NAME` for a secret. */
      parameters: Array<{ name: string; value: string }>;
      notes?: string[];
    }
  | { type: 'done'; status: 'passed' | 'error' | 'aborted'; error?: string };

/** Every frame a recording stream can carry. */
export type RecordStreamEvent =
  | RecordEvent
  | { type: 'output'; msg: string; kind: 'info' | 'warn' | 'error' };

export type RecordEventListener = (event: RecordStreamEvent) => void;

/** `POST /sessions/:id/record-steps` body, validated. */
export interface RecordStepsRequest {
  testFilePath: string;
  /** Only on the session's FIRST request — the steps route's object and rule. */
  config?: {
    baseUrl?: string;
    timeout?: string;
    viewport?: string;
    unmask?: string;
    tableStructure?: string;
    cdp?: { port: number; tab?: string; profile?: string };
  };
  /**
   * The test's `.env`, as the steps route takes it. NOT in the story's wire
   * contract — additive and optional: when it is sent it points the session's
   * AI client exactly as a batch would (so a session this request creates talks
   * to the project's model, not the server's), and when it is not, the session
   * keeps whatever its last batch set.
   */
  env?: Record<string, string>;
  target: {
    mode: 'cursor' | 'new';
    /** The document as it stands, for the prompt. */
    fileText: string;
    /** 1-based; mode `cursor` only. */
    cursorLine?: number;
  };
}

/** `POST /sessions/:id/record-steps/control` body, validated. */
export type RecordControl =
  | { action: 'stop'; dropped?: string[] }
  /** Leave this action out, and redraft now (decision 9). */
  | { action: 'drop'; id: string }
  /** Put it back, and redraft now. */
  | { action: 'restore'; id: string }
  | { action: 'check' }
  | { action: 'cancel-check' }
  | { action: 'cancel' };

/** Answer to a control request, which the route turns into a status. */
export type RecordControlOutcome =
  | 'accepted'
  | 'no-recording'
  /** Stop has been received; only `cancel` still does anything. */
  | 'stopping'
  /** `drop` / `restore` of an id the recording does not have, or one already
   *  in that state — nothing to do. */
  | 'ignored';

/** A rectangle in CSS pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The page's description of one element (decision 5), as the page script
 * builds it. Every field is a clipped string off the page — page content, so
 * DATA to the model, never instructions.
 */
export interface ElementDescription {
  tag: string;
  role?: string;
  name?: string;
  /** The accessible name before icon glyphs / emoji were stripped from its
   *  ends — present only when stripping changed it. */
  rawName?: string;
  text?: string;
  inputType?: string;
  placeholder?: string;
  href?: string;
  id?: string;
  nameAttr?: string;
  testId?: string;
  title?: string;
  classes?: string;
  disabled?: boolean;
  context?: {
    dialog?: string;
    menu?: string;
    fieldset?: string;
    landmark?: string;
    row?: string;
    column?: string;
    heading?: string;
  };
  selector?: string;
  inFrame?: boolean;
}

/** Which frame an action happened in, when it was not the top one. */
export interface FrameDescription {
  url: string;
  name?: string;
  /** Attributes of the `<iframe>` element in its parent document. */
  element?: { id?: string; name?: string; title?: string };
}

/** The crop taken for one action (decision 6). */
export interface ActionCrop {
  /** `data:image/png;base64,…` */
  dataUrl: string;
  width: number;
  height: number;
  /** The target's box inside the (scaled) crop — the red rectangle. */
  boxInCrop: Box;
  /** The target's box on the page, CSS pixels from the viewport's top-left. */
  pageBox: Box;
}

/** One recorded action, as the recorder keeps it. */
export interface RecordedAction {
  id: string;
  kind: RecordActionKind;
  atMs: number;
  summary: string;
  /** PageTracker label — `main` included here; the frame drops it. */
  tab: string;
  /** An ACTION (sends the draft) rather than an event (rides with the next). */
  action: boolean;
  target?: ElementDescription;
  /** Typed text (never for a secret), or nothing. */
  value?: string;
  /** Typed into a field `isSecretField` calls secret — no value exists. */
  secret?: boolean;
  /** The typed value equalled a secret the run already knows, under this
   *  parameter name (so it was withheld like a secret field's). */
  knownSecret?: string;
  /** A click that only put the caret in a text field. */
  focusOnly?: boolean;
  /** The click came from the keyboard (Enter/Space on a focused control). */
  keyboard?: boolean;
  /** A tick/untick made by clicking the checkbox's label. */
  viaLabel?: ElementDescription;
  /** Chosen option texts, for `select`. */
  options?: string[];
  /** File names, for `upload`. */
  files?: string[];
  /** `Enter` / `Escape` / `Tab`, for `key`. */
  key?: string;
  shift?: boolean;
  /** For `navigate` and `tab`. */
  url?: string;
  /** For `tab`: the tab's title (SPEC-record-steps.md §4). */
  title?: string;
  /** For `tab`: opened, or moved to. */
  tabEvent?: 'opened' | 'moved';
  /** For `check` (Add check): what the element said when it was picked. */
  check?: {
    text?: string;
    value?: string;
    secret?: boolean;
    checked?: boolean;
    selected?: string[];
    container?: { role?: string; name?: string; text?: string };
  };
  frame?: FrameDescription;
  crop?: ActionCrop;
  /** For `drag`: the element dropped on (`target` is the one dragged). */
  dropTarget?: ElementDescription;
  /** For `drag`: the crop taken at the drop, around `dropTarget`. */
  dropCrop?: ActionCrop;
}
