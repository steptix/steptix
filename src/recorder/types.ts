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
   * `locked` leading steps are final — the model cannot rewrite them — and
   * `authored` are the indices of the steps the author wrote by hand, with
   * their ids beside them in `authoredIds` (stories/testbench-record-toolbar.md,
   * "The wire, exactly").
   */
  | {
      type: 'record:draft';
      revision: number;
      steps: string[];
      parameters: Array<{ name: string; value: string }>;
      notes?: string[];
      through?: string;
      locked: number;
      authored: number[];
      authoredIds?: string[];
      /**
       * One stable id per step (stories/testbench-record-edit-steps.md, "The
       * wire, exactly"): kept while the step is unchanged in place, new when
       * the model writes or rewrites it; an author step keeps its `s` id.
       * Never an action's id or another step's.
       */
      ids: string[];
      /** Indices of the steps whose text is the author's rewording of a step
       *  the model wrote (a subset of what the drawer shows as `yours`). */
      edited: number[];
    }
  /** A step's text was changed by the author — from the browser's drawer,
   *  the test file or the panel. The draft that shows it comes after. */
  | { type: 'record:edited'; id: string; text: string; source: RecordStepSource }
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
  /** Paused or resumed — from the browser's toolbar or the panel. `atMs` is
   *  the recording's clock, which does not run while paused. */
  | { type: 'record:paused'; paused: boolean; atMs: number; source: 'toolbar' | 'panel' }
  /**
   * A step the author wrote joined the recording. `afterStep` is where it sits:
   * the 0-based index of the draft step it follows in the draft it joined
   * (-1 at the very start) — so it is step `afterStep + 1` of the next
   * `record:draft`, whose `authored` says the same.
   */
  | {
      type: 'record:step';
      id: string;
      text: string;
      source: RecordStepSource;
      afterStep: number;
      atMs: number;
    }
  /**
   * An action or an author step was dropped or restored from the browser's
   * toolbar (Undo / Restore), so the panel can strike it through — or a step
   * of the draft was deleted or restored from anywhere, with the recorded
   * actions its delete dropped (or its restore put back) in `actions`. A step's
   * frame comes before the draft without (or with) it.
   */
  | {
      type: 'record:dropped';
      id: string;
      dropped: boolean;
      source: RecordStepSource;
      actions?: string[];
    }
  /** The toolbar was moved or minimised: TestBench keeps it for the next start body. */
  | { type: 'record:toolbar'; dock: ToolbarDock; minimised: boolean }
  | {
      type: 'done';
      status: 'passed' | 'error' | 'aborted';
      error?: string;
      /** Cancel was pressed in the browser: TestBench takes the drafts out
       *  quietly, with no error. */
      cancelledBy?: 'browser';
    };

/** Where the browser toolbar docks: top or bottom, left, centre or right. */
export type ToolbarDock = 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br';

export const TOOLBAR_DOCKS: ReadonlySet<ToolbarDock> = new Set<ToolbarDock>(['tl', 'tc', 'tr', 'bl', 'bc', 'br']);

/** Where an author step came from. */
export type RecordStepSource = 'toolbar' | 'editor' | 'panel';

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
  /**
   * The browser toolbar (stories/testbench-record-toolbar.md). Absent means
   * `{ enabled: true, dock: 'bc', minimised: false }`; `enabled: false` puts
   * no toolbar in the page — the rest of the recording is unchanged.
   */
  toolbar?: { enabled: boolean; dock?: ToolbarDock; minimised?: boolean };
}

/** `POST /sessions/:id/record-steps/control` body, validated. */
export type RecordControl =
  | { action: 'stop'; dropped?: string[] }
  /**
   * Leave this action — or author step — out, and redraft now (decision 9).
   * A step of the draft (a `record:draft.ids` id) is deleted at once, with the
   * recorded actions behind it (stories/testbench-record-edit-steps.md).
   * `source` is not in that story's wire: optional, and only echoed in the
   * `record:dropped` a step's delete sends ('panel' when absent).
   */
  | { action: 'drop'; id: string; source?: 'editor' | 'panel' }
  /** Put it back — an action or author step redrafts now; a step of the
   *  draft goes back where it was, with its actions. */
  | { action: 'restore'; id: string; source?: 'editor' | 'panel' }
  /**
   * The author reworded a step of the draft. The text is theirs from now on:
   * the step keeps the actions it stands for, and the model neither rewrites
   * it nor writes another step for them. `revision` is the draft the author
   * saw.
   */
  | { action: 'edit-step'; id: string; text: string; source: 'editor' | 'panel'; revision?: number }
  | { action: 'check' }
  | { action: 'cancel-check' }
  | { action: 'cancel' }
  | { action: 'pause' }
  | { action: 'resume' }
  /**
   * A step the author wrote in the editor or the panel. `text` is one line or
   * several (several lines are several steps, in order); `afterStep` is the
   * 0-based index in the draft the author saw — absent means at the end — and
   * `revision` is the `record:draft` that index refers to. The toolbar's box
   * goes through the page binding instead.
   */
  | { action: 'add-step'; text: string; source: 'editor' | 'panel'; afterStep?: number; revision?: number };

/** Answer to a control request, which the route turns into a status. */
export type RecordControlOutcome =
  | 'accepted'
  | 'no-recording'
  /** Stop has been received; only `cancel` still does anything. */
  | 'stopping'
  /** `drop` / `restore` of an id the recording does not have, or one already
   *  in that state; `pause` while paused, `resume` while not; Add check while
   *  paused; an `add-step` whose every line is blank — nothing to do. */
  | 'ignored'
  /** Nothing was done, for a reason only the recording can word: an
   *  `add-step` from the editor holding a secret the recording knows. */
  | { ignored: string };

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
  /** The first thing recorded after the author paused and resumed: the time
   *  across the pause is not a wait the app needed (the gap already leaves
   *  it out), and the pause is no reason to write a navigation. */
  afterPause?: boolean;
}
