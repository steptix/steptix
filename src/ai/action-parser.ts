import type {
  AIAction,
  AIResponse,
  BranchedAIResponse,
  ActionType,
  TableReadColumn,
} from './types.js';
import { logger } from '../utils/logger.js';
import { normaliseUploadPath } from '../browser/upload-paths.js';

/**
 * Every action type the framework runs — the parser's vocabulary, and the
 * list the step loop and `executeAction` check a type against before anything
 * touches the page.
 *
 * Exported so there is ONE list: the step loop refuses exactly what is missing
 * from it, {@link RETRY_ACTION_TYPES} is drawn from it for the retry prompt,
 * and tests/unknown-action-type.test.ts walks it to prove every member has a
 * route — either a case in `executeAction` or an interception in the step loop
 * ahead of it. A type added here without wiring fails that test instead of
 * failing at runtime.
 */
export const VALID_ACTION_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  'click', 'type', 'select', 'navigate', 'upload',
  // docs/specs/SPEC-browser-history.md §4 — the browser's own history.
  'back', 'forward',
  // The browser's reload button, and a drag of one element onto another —
  // both recordable by Record Steps, so both must run
  // (docs/specs/SPEC-record-steps.md §4).
  'reload', 'drag',
  // docs/specs/SPEC-web-survey-fixes.md §2.1 — how the next browser dialog
  // is answered.
  'dialog',
  'hover', 'wait', 'scroll', 'switchFrame', 'switchPage', 'closePage', 'openPage',
  'openBrowser', 'switchBrowser', 'closeBrowser',
  'dismiss',
  'assert', 'keyboard', 'keypress', 'prompt',
  'api_call', 'extract_csrf', 'extract_value',
  'read', 'count',
  // docs/specs/SPEC-structured-table-reads.md §6 — named columns from one
  // native <table>, one record per visible data row.
  'readTable',
  'find', 'expand',
  'noop',
  // stories/step-flow-control.md — the model's "the condition holds" answer.
  // Valid vocabulary everywhere; the CLAIM guard lives in the step executor,
  // which is the only place that knows the step's authored text.
  'return',
  // stories/step-failure-outcomes.md, decision 1 — the same answer for the
  // `fail` verb, and under the same claim guard for the same reason.
  'fail',
]);

/** Is `type` one of {@link VALID_ACTION_TYPES}? */
export function isKnownActionType(type: unknown): type is ActionType {
  return typeof type === 'string' && VALID_ACTION_TYPES.has(type as ActionType);
}

/**
 * Why an action whose type the framework does not have failed — the sentence
 * a PERSON reads: the ✗ in Steptix, the MCP reason, the report.
 *
 * Short on purpose. The model needs more than this — which types it may send
 * instead, and what to do when none of them does what the step asks — and
 * `buildRetryContext` adds that to the retry prompt, the one place it is read
 * by the reader it is for. A list of action names is noise on a red step.
 */
export function unknownActionTypeError(type: unknown): string {
  return (
    `Unknown action type ${JSON.stringify(String(type))} — the framework has no such action, ` +
    'so nothing was done on the page'
  );
}

/**
 * Valid types the retry does NOT offer a model whose type was unknown, because
 * each can end a step green having done nothing — the one outcome that retry
 * must not produce:
 *
 *  - `noop`, `switchFrame` and `extract_value` do nothing and report success;
 *  - `prompt` asks the person at the console, and with
 *    `execution.promptOnAmbiguity` off it is skipped and the step passes;
 *  - `find` and `expand` only look: the NEXT turn decides, and its prompt no
 *    longer carries the retry's guidance;
 *  - `return` and `fail` are flow control, legal only on a step written to
 *    return or fail.
 *
 * Measured on gpt-5.6-luna (2026-09-29): offered all 35 types and told to
 * "use one of the valid action types instead", a misplaced `[use ai]` step's
 * retry typed an invented first name into a field the step never mentioned,
 * and passed, 4 runs in 5 — once ending on `noop` after the typing.
 */
const NOT_OFFERED_ON_RETRY: ReadonlySet<ActionType> = new Set<ActionType>([
  'noop', 'switchFrame', 'extract_value', 'prompt', 'find', 'expand', 'return', 'fail',
]);

/**
 * The types `buildRetryContext` lists after an unknown-type refusal: every
 * member of {@link VALID_ACTION_TYPES} except {@link NOT_OFFERED_ON_RETRY}, in
 * the same order. Derived rather than written out, so a type added to the
 * vocabulary is offered unless it is excluded on purpose.
 */
export const RETRY_ACTION_TYPES: readonly ActionType[] = [...VALID_ACTION_TYPES].filter(
  (type) => !NOT_OFFERED_ON_RETRY.has(type),
);

/**
 * Fold an action name to one canonical spelling: lower-case, with `_`, `-`
 * and spaces removed. `switchFrame`, `switch_frame` and `Switch Frame` are one
 * name, which is what lets one table cover every spelling a model reaches for
 * instead of a row per variant.
 *
 * Shared with the computer surface's parser (src/desktop/action-parser.ts),
 * which imports it from here as it imports `extractJson`, so the two surfaces
 * fold a name the same way.
 */
export function foldActionName(name: string): string {
  return name.trim().toLowerCase().replace(/[_\-\s]/g, '');
}

/**
 * Normalise common AI action type variants to canonical types.
 * AI models sometimes return "api", "http", "request" etc. instead of "api_call".
 *
 * Looked up FOLDED ({@link canonicalActionType}), so each row also covers its
 * other capitalisations and its snake_case, kebab-case and spaced forms — and
 * the canonical types get the same treatment: `"Click"`, `"SWITCH_PAGE"` and
 * `"read_table"` are `click`, `switchPage` and `readTable`.
 *
 * A convenience, not the safety net. A type that is neither canonical nor
 * listed here is kept as the model wrote it, so the transcript shows what it
 * returned, and the step loop refuses the whole turn before any of it runs:
 * the step fails naming the type, and the retry prompt lists the types that
 * may be sent instead. An alias only saves that retry. (Until the refusal
 * existed an unknown type ran as a no-op that REPORTED SUCCESS, which is why
 * the history, reload and drag spellings below were added one at a time.)
 *
 * Exported so tests/unknown-action-type.test.ts can prove folding merges no
 * two meanings.
 */
export const ACTION_TYPE_ALIASES: Readonly<Record<string, ActionType>> = {
  // docs/specs/SPEC-browser-history.md §4.1. `goBack` is the likeliest miss of
  // all: it is the Playwright call the code-generation prompt teaches two
  // screens away.
  goBack: 'back',
  go_back: 'back',
  browserBack: 'back',
  browser_back: 'back',
  navigateBack: 'back',
  navigate_back: 'back',
  historyBack: 'back',
  history_back: 'back',
  goForward: 'forward',
  go_forward: 'forward',
  browserForward: 'forward',
  browser_forward: 'forward',
  navigateForward: 'forward',
  navigate_forward: 'forward',
  historyForward: 'forward',
  history_forward: 'forward',
  // The same for the two actions Record Steps added: `refresh` and the drag
  // spellings are what a model reaches for first.
  refresh: 'reload',
  reloadPage: 'reload',
  reload_page: 'reload',
  refreshPage: 'reload',
  refresh_page: 'reload',
  browserReload: 'reload',
  browser_reload: 'reload',
  browserRefresh: 'reload',
  browser_refresh: 'reload',
  dragTo: 'drag',
  drag_to: 'drag',
  dragAndDrop: 'drag',
  drag_and_drop: 'drag',
  dragDrop: 'drag',
  drag_drop: 'drag',
  dragAndDropTo: 'drag',
  // docs/specs/SPEC-web-survey-fixes.md §2.2. Every one of these was sent by
  // gpt-6-luna in the web survey and refused; {@link ALIAS_DEFAULTS} adds the
  // field that makes each one mean what its name says.
  doubleClick: 'click',
  dblclick: 'click',
  dblClick: 'click',
  rightClick: 'click',
  contextClick: 'click',
  contextMenu: 'click',
  // §2.24: press and hold is a click held down before release.
  longPress: 'click',
  longClick: 'click',
  pressAndHold: 'click',
  clickAndHold: 'click',
  holdClick: 'click',
  // §2.1. The six spellings the survey's runs sent for "answer the dialog".
  acceptDialog: 'dialog',
  acceptAlert: 'dialog',
  acceptConfirm: 'dialog',
  acceptPrompt: 'dialog',
  confirmDialog: 'dialog',
  handleDialog: 'dialog',
  handleAlert: 'dialog',
  dismissDialog: 'dialog',
  dismissAlert: 'dialog',
  dismissConfirm: 'dialog',
  cancelDialog: 'dialog',
  alert: 'dialog',
  'api': 'api_call',
  'http': 'api_call',
  'request': 'api_call',
  'http_request': 'api_call',
  'fetch': 'api_call',
  'csrf': 'extract_csrf',
  'get_csrf': 'extract_csrf',
  'switch_page': 'switchPage',
  'switchTab': 'switchPage',
  'switch_tab': 'switchPage',
  'switchWindow': 'switchPage',
  'switch_window': 'switchPage',
  'closeTab': 'closePage',
  'close_tab': 'closePage',
  'close_page': 'closePage',
  'closeWindow': 'closePage',
  'close_window': 'closePage',
  'open_page': 'openPage',
  'openTab': 'openPage',
  'open_tab': 'openPage',
  'openWindow': 'openPage',
  'open_window': 'openPage',
  'newTab': 'openPage',
  'new_tab': 'openPage',
  'newWindow': 'openPage',
  'new_window': 'openPage',
  'open_browser': 'openBrowser',
  'newBrowser': 'openBrowser',
  'new_browser': 'openBrowser',
  'switch_browser': 'switchBrowser',
  'close_browser': 'closeBrowser',
  'press': 'keyboard',
  'key': 'keyboard',
  'key_press': 'keypress',
  'attach': 'upload',
  'attach_file': 'upload',
  'attachFile': 'upload',
  'file_upload': 'upload',
  'upload_file': 'upload',
  'uploadFile': 'upload',
  'set_files': 'upload',
  'setFiles': 'upload',
  'setInputFiles': 'upload',
};

/**
 * Every spelling the parser resolves, folded: each alias under its folded
 * name, then each valid type under its own — last, so a canonical name always
 * resolves to itself even if an alias were ever added that folds onto it.
 *
 * A Map rather than an object, so a type the model named "constructor" or
 * "toString" finds nothing instead of the prototype's function (which JSON
 * then drops, taking the transcript's record of what the model sent with it).
 */
const FOLDED_ACTION_TYPES: ReadonlyMap<string, ActionType> = new Map<string, ActionType>([
  ...Object.entries(ACTION_TYPE_ALIASES).map(
    ([alias, type]) => [foldActionName(alias), type] as [string, ActionType],
  ),
  ...[...VALID_ACTION_TYPES].map((type) => [foldActionName(type), type] as [string, ActionType]),
]);

/**
 * The field an alias implies, keyed by FOLDED alias. `doubleClick` is a
 * `click`, but a single click would be the wrong action: the alias has to say
 * how many. A field the model sent itself wins over the default.
 */
/** How long a press-and-hold holds when the step does not say (§2.24). */
const DEFAULT_HOLD_MS = 2000;
/** The longest hold accepted; a press nobody would make is a model mistake. */
const MAX_HOLD_MS = 30_000;

const ALIAS_DEFAULTS: ReadonlyMap<string, Partial<AIAction>> = new Map<string, Partial<AIAction>>([
  ['doubleclick', { clickCount: 2 }],
  ['dblclick', { clickCount: 2 }],
  ['rightclick', { button: 'right' }],
  ['contextclick', { button: 'right' }],
  ['contextmenu', { button: 'right' }],
  ['longpress', { holdMs: DEFAULT_HOLD_MS }],
  ['longclick', { holdMs: DEFAULT_HOLD_MS }],
  ['pressandhold', { holdMs: DEFAULT_HOLD_MS }],
  ['clickandhold', { holdMs: DEFAULT_HOLD_MS }],
  ['holdclick', { holdMs: DEFAULT_HOLD_MS }],
  ['acceptdialog', { value: 'accept' }],
  ['acceptalert', { value: 'accept' }],
  ['acceptconfirm', { value: 'accept' }],
  ['acceptprompt', { value: 'accept' }],
  ['confirmdialog', { value: 'accept' }],
  ['dismissdialog', { value: 'dismiss' }],
  ['dismissalert', { value: 'dismiss' }],
  ['dismissconfirm', { value: 'dismiss' }],
  ['canceldialog', { value: 'dismiss' }],
]);

/**
 * Apply {@link ALIAS_DEFAULTS} for the name the model actually sent, then put
 * a `dialog` action's answer in one spelling: `value` is `accept` or
 * `dismiss`, whatever word or flag the model used for it.
 */
function applyAliasDefaults(action: AIAction, rawActionType: string): void {
  const defaults = ALIAS_DEFAULTS.get(foldActionName(rawActionType));
  if (defaults !== undefined) {
    for (const [key, value] of Object.entries(defaults)) {
      const field = key as keyof AIAction;
      if (action[field] === undefined) (action as unknown as Record<string, unknown>)[field] = value;
    }
  }
  if (action.action === 'dialog') {
    const answer = (action.value ?? '').trim().toLowerCase();
    action.value = ['dismiss', 'cancel', 'no', 'reject', 'decline', 'false'].includes(answer)
      ? 'dismiss'
      : 'accept';
  }
}

/**
 * The canonical type the model meant by `raw` — itself, an alias, or either
 * in another case or separator style — or `undefined` when it names nothing
 * the framework has.
 */
export function canonicalActionType(raw: string): ActionType | undefined {
  return FOLDED_ACTION_TYPES.get(foldActionName(raw));
}

/**
 * A file path a model copied out of a step is the one place its JSON reliably
 * breaks. `"\\attachments\\logo.png"` is INVALID JSON — `\\a` is not an
 * escape — so `JSON.parse` rejects the whole response and the turn is lost,
 * before any field-level normalisation could have helped
 * (stories/upload-action.md §2).
 *
 * The repair runs only after a parse has already failed, and only inside the
 * value of a `filePath` / `filePaths` key. That scoping is the point: a blanket
 * backslash fix would corrupt a `read` action's `pattern` (a regex `\\d` would
 * silently become `/d`) or a `value` the step meant literally. A correctly
 * escaped `"attachments\\\\logo.png"` is left alone — it already parses, and
 * `normaliseUploadPath` folds its separator afterwards.
 */
const UPLOAD_PATH_VALUE =
  /("file(?:Path|Paths)"\s*:\s*)("(?:[^"\\]|\\.)*"|\[(?:\s*"(?:[^"\\]|\\.)*"\s*,?)*\s*\])/g;
/**
 * A valid escape, or a stray backslash. Matching the valid form FIRST and
 * keeping it is what makes this safe over consecutive backslashes: a correctly
 * escaped `\\\\` is consumed whole, so its second character is never mistaken
 * for the start of a bad escape.
 */
const JSON_ESCAPE_OR_STRAY = /\\(["\\/bfnrtu]|u[0-9a-fA-F]{4})|\\/g;

function fixEscapes(text: string): string {
  return text.replace(JSON_ESCAPE_OR_STRAY, (whole, valid: string | undefined) =>
    (valid === undefined ? '/' : whole));
}

/** The scoped repair: path values only, so a `read` action's regex `pattern`
 *  cannot be collateral damage. */
function repairUploadPathEscapes(json: string): string {
  return json.replace(UPLOAD_PATH_VALUE, (_whole, key: string, value: string) =>
    key + fixEscapes(value));
}

/**
 * `JSON.parse`, with one retry through {@link repairUploadPathEscapes}. Throws
 * the ORIGINAL parse error when the repair changed nothing or still fails, so
 * the message names the model's own output rather than our repaired copy.
 */
function parseWithUploadPathRepair(jsonString: string): unknown {
  try {
    return JSON.parse(jsonString);
  } catch (err) {
    // Scoped first — it is the safe one, and it covers the common case.
    const scoped = repairUploadPathEscapes(jsonString);
    if (scoped !== jsonString) {
      try {
        const parsed: unknown = JSON.parse(scoped);
        logger.debug('Repaired unescaped backslashes in an upload path before parsing the AI response');
        return parsed;
      } catch { /* still broken — widen below */ }
    }
    // Still unparseable, so the turn is lost either way. Widen the repair to
    // every string: a model that echoed the step's path into `description` as
    // well as into `filePath` is the ordinary shape of this failure. A
    // mangled regex somewhere else in the response is a worse outcome than a
    // clean parse, but a better one than throwing the whole turn away.
    const broad = fixEscapes(jsonString);
    if (broad !== jsonString) {
      try {
        const parsed: unknown = JSON.parse(broad);
        logger.debug('Repaired unescaped backslashes across the AI response before parsing it');
        return parsed;
      } catch { /* genuinely malformed */ }
    }
    throw err;
  }
}

/**
 * Has the "a model emitted `mapping`" warning been written this PROCESS?
 *
 * Per process, not per run, and the difference is real: a Sessions API server
 * runs every test in one process, so the first emitted `mapping` uses the
 * warning up for the life of that server. See the comment at the check itself
 * for why that is accepted and what is logged per occurrence instead.
 *
 * Exported only so a test can reset it — there is no way to observe such a
 * latch from outside otherwise, and a test that ran second would assert on a
 * warning the first test had already used up.
 */
let warnedAboutEmittedMapping = false;

/** Reset the once-per-process `mapping` warning. Tests only. */
export function resetEmittedMappingWarning(): void {
  warnedAboutEmittedMapping = false;
}

// ── readTable validation (SPEC-structured-table-reads.md §6.2) ──────────────
//
// Every rule here rejects the WHOLE action. That is the one design decision
// this block exists to enforce: a dropped malformed column would run a partial
// read, and a row record missing a field the later steps name is a convincing
// lie — worse than a step that failed and said why.

/** Alias and variable names: a plain identifier, as §4.1 requires. */
const SAFE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names that are legal identifiers but poison an object literal. */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);
/** The one property the runtime writes itself, so no alias may claim it (§4.5). */
const ROW_NUMBER_KEY = '_row';
/** §7.5 — a table wider than this is a mis-typed selector, not a table.
 *  Exported because `src/browser/actions.ts` re-exports it rather than
 *  spelling the number a second time (§9.2). */
export const MAX_TABLE_COLUMNS = 20;
/** §7.5 — the structured row cap, and therefore the ceiling on `limit`.
 *  Exported for the same reason. */
export const MAX_TABLE_ROWS = 500;
/** §6.2 — a position past this is a typo, not a column. */
const MAX_COLUMN_INDEX = 100;

/**
 * Validate a `readTable` request's `columns` and `limit` — the whole of §6.2
 * that is not about `selector`/`as` — and answer them in canonical form.
 *
 * ONE validator, because §9.2 requires identical validation on both paths into
 * the extractor: today's AI action, which arrives here as raw JSON, and phase
 * 3's generated `tables.read`, which calls `readTableRecords` directly and
 * never passes through this file. Re-checking only the 20-column cap there
 * left every other rule to the parser, so the same malformed request got a
 * precise refusal from one path and a silently wrong read from the other —
 * `{ key: '_row' }` overwritten by the row number, `{ key: '__proto__' }`
 * dropped from every record, a column naming neither header nor index
 * answered with "there is no cell at position undefined", `limit: 0` storing
 * `[]` successfully and `limit: 99999` stepping past the 500-row cap.
 *
 * `where` is what the messages are prefixed with — `readTable action at index
 * 2` from the parser, plain `readTable` from the extractor — so the two differ
 * in that phrase and in nothing else.
 *
 * Every rule rejects the WHOLE request. A dropped malformed column would run a
 * partial read, and a row record missing a field the later steps name is a
 * convincing lie — worse than a step that failed and said why.
 */
export function validateTableRead(
  raw: { columns: unknown; limit?: unknown },
  where: string,
): { columns: TableReadColumn[]; limit?: number } {
  const rawColumns = raw.columns;
  if (!Array.isArray(rawColumns)) {
    throw new Error(`${where} missing required "columns" array (name at least one column to read)`);
  }
  if (rawColumns.length === 0) {
    throw new Error(`${where} has an empty "columns" array — name at least one column to read`);
  }
  if (rawColumns.length > MAX_TABLE_COLUMNS) {
    throw new Error(
      `${where} requests ${rawColumns.length} columns — the maximum is ${MAX_TABLE_COLUMNS}`,
    );
  }

  const columns: TableReadColumn[] = [];
  const seenKeys = new Set<string>();
  rawColumns.forEach((rawColumn, i) => {
    const at = `${where}: column ${i + 1}`;
    if (typeof rawColumn !== 'object' || rawColumn === null || Array.isArray(rawColumn)) {
      throw new Error(`${at} is not an object`);
    }
    const col = rawColumn as Record<string, unknown>;

    // PRESENT means present-and-not-undefined, and `null` is present. A model
    // that emits `"index": null` beside a header has contradicted itself, and
    // `{ "index": null }` alone is a column that names nothing; reading either
    // as "absent" ran a read the author did not ask for. Same rule for
    // "limit" and "mode" below, so all three refuse a null the same way.
    const hasHeader = col['header'] !== undefined;
    const hasIndex = col['index'] !== undefined;
    if (hasHeader && hasIndex) {
      throw new Error(
        `${at} has both "header" and "index" — a column is named by its header text OR by its position, never both`,
      );
    }
    if (!hasHeader && !hasIndex) {
      throw new Error(
        `${at} has neither "header" nor "index" — name the column by its header text or by its one-based position`,
      );
    }

    let header: string | undefined;
    let columnIndex: number | undefined;
    if (hasHeader) {
      if (typeof col['header'] !== 'string' || !col['header'].trim()) {
        throw new Error(
          `${at} has a blank "header" ${JSON.stringify(col['header'])} — copy the header text exactly as the page renders it`,
        );
      }
      header = col['header'];
    } else {
      const raw = col['index'];
      if (
        typeof raw !== 'number' ||
        !Number.isInteger(raw) ||
        raw < 1 ||
        raw > MAX_COLUMN_INDEX
      ) {
        throw new Error(
          `${at} has an invalid "index" ${JSON.stringify(raw)} — use a one-based whole number from 1 to ${MAX_COLUMN_INDEX}`,
        );
      }
      columnIndex = raw;
    }

    const key = col['key'];
    if (typeof key !== 'string' || !SAFE_NAME_RE.test(key)) {
      throw new Error(
        `${at} has an invalid "key" ${JSON.stringify(key)} — use letters, digits and underscores, starting with a letter or underscore`,
      );
    }
    if (key === ROW_NUMBER_KEY) {
      throw new Error(
        `${at} uses the reserved key "${ROW_NUMBER_KEY}" — the runtime writes the row number on every record`,
      );
    }
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`${at} uses the reserved key "${key}"`);
    }
    // Key uniqueness also settles §6.2's duplicated `(header, key)` /
    // `(index, key)` pair: a repeated pair repeats its key.
    if (seenKeys.has(key)) {
      throw new Error(`${at} repeats the key "${key}" — every column needs its own name`);
    }
    seenKeys.add(key);

    const mode = col['mode'];
    if (mode !== undefined && mode !== 'text') {
      throw new Error(
        `${at} uses mode ${JSON.stringify(mode)}, which is phase 2 — phase 1 reads rendered text only, so omit "mode" or set it to "text"`,
      );
    }

    columns.push({
      ...(header !== undefined && { header }),
      ...(columnIndex !== undefined && { index: columnIndex }),
      key,
      ...(mode === 'text' && { mode: 'text' as const }),
    });
  });

  const rawLimit = raw.limit;
  if (rawLimit === undefined) return { columns };
  if (
    typeof rawLimit !== 'number' ||
    !Number.isInteger(rawLimit) ||
    rawLimit < 1 ||
    rawLimit > MAX_TABLE_ROWS
  ) {
    throw new Error(
      `${where} has an invalid "limit" ${JSON.stringify(rawLimit)} — use a whole number from 1 to ${MAX_TABLE_ROWS}`,
    );
  }
  return { columns, limit: rawLimit };
}

/**
 * Validate and copy a `readTable` action's `selector`, `as`, `columns` and
 * `limit` (SPEC-structured-table-reads.md §6.2). Mutates `action` on success;
 * throws with a precise message on any rejection.
 *
 * The parser's other fields are copied opportunistically — an unrecognised
 * `direction` is dropped and the action still runs. These are not: a column
 * list is the whole meaning of the action.
 */
function applyTableReadFields(action: AIAction, obj: Record<string, unknown>, index: number): void {
  const where = `readTable action at index ${index}`;

  if (typeof action.selector !== 'string' || !action.selector.trim()) {
    throw new Error(`${where} missing required "selector" field (a CSS selector for one native <table>)`);
  }
  if (typeof action.as !== 'string' || !action.as.trim()) {
    throw new Error(`${where} missing required "as" field (the variable the row records are stored in)`);
  }
  if (!SAFE_NAME_RE.test(action.as)) {
    throw new Error(
      `${where} has an invalid "as" name "${action.as}" — use letters, digits and underscores, starting with a letter or underscore`,
    );
  }

  const { columns, limit } = validateTableRead(
    { columns: obj['columns'], limit: obj['limit'] },
    where,
  );
  action.columns = columns;
  if (limit !== undefined) action.limit = limit;
}

/**
 * Parse the raw string response from the AI into a structured AIResponse.
 * Handles JSON wrapped in markdown code blocks, whitespace, and minor formatting issues.
 */
export function parseAIResponse(rawResponse: string): AIResponse {
  const jsonString = extractJson(rawResponse);

  let parsed: unknown;
  try {
    parsed = parseWithUploadPathRepair(jsonString);
  } catch (err) {
    throw new Error(
      `AI response is not valid JSON: ${String(err)}\nRaw response:\n${rawResponse.substring(0, 500)}`,
    );
  }

  return validateAndNormaliseResponse(parsed);
}

/**
 * Parse the AI response for an assertion code generation request.
 * Extracts the `code` field — a self-executing JS function string.
 */
export function parseAssertionCode(rawResponse: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawResponse));
  } catch (err) {
    // A reply that is not JSON at all may still be the code, fenced.
    const fenced = fencedCode(rawResponse);
    if (fenced !== undefined) return fenced;
    throw new Error(`Assertion code response is not valid JSON: ${String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Assertion code response must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj['code'] === 'string' && obj['code'].trim()) return obj['code'];

  // The assertion prompt is sent beside the ACTION system prompt, which
  // teaches `{ "actions": [...] }`, and the model sometimes answers in that
  // shape with the code inside the action. Measured in the web survey: two
  // predicate checks ("is a number", "equals") failed on both attempts this way
  // (docs/specs/SPEC-web-survey-fixes.md §2.14).
  const actions = obj['actions'];
  if (Array.isArray(actions)) {
    for (const action of actions) {
      const code = (action as Record<string, unknown> | null)?.['code'];
      if (typeof code === 'string' && code.trim()) return code;
    }
  }
  const fenced = fencedCode(rawResponse);
  if (fenced !== undefined) return fenced;
  throw new Error('Assertion code response missing "code" field');
}

/** The body of the first ```js / ```javascript fence that holds a function. */
function fencedCode(raw: string): string | undefined {
  const match = /```(?:js|javascript)\s*\n([\s\S]*?)```/i.exec(raw);
  const body = match?.[1]?.trim();
  return body && /=>|function\b/.test(body) ? body : undefined;
}

/**
 * What to tell the model when its assertion reply could not be read, so the
 * second attempt is not the first one asked again (§2.14).
 */
export const ASSERTION_CODE_REMINDER =
  'Your previous reply could not be used: it was not a JSON object with a "code" field. '
  + 'Do not reply with "actions". Reply with ONLY this JSON object: '
  + '{ "code": "(() => { ... return { pass, actual }; })()" }';

/**
 * Parse the AI response for a branched (conditional) step.
 * Extracts the `matched` field in addition to standard actions.
 */
export function parseBranchedResponse(
  rawResponse: string,
  opts: {
    /**
     * Accept a response with no `actions` array at all.
     *
     * Off for the watch form, where the actions ARE the answer — a reply
     * without them is a lost turn and re-asking is right. On for the condition
     * judge (stories/control-flow.md §"Condition evaluation"), which forbids
     * acting: there, a missing array is the model obeying, and treating it as
     * malformed would burn the 30 s budget on a correct answer.
     */
    actionsOptional?: boolean;
  } = {},
): BranchedAIResponse {
  const jsonString = extractJson(rawResponse);

  let parsed: unknown;
  try {
    parsed = parseWithUploadPathRepair(jsonString);
  } catch (err) {
    throw new Error(
      `Branched AI response is not valid JSON: ${String(err)}\nRaw response:\n${rawResponse.substring(0, 500)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Branched AI response must be a JSON object with a "matched" field');
  }

  const obj = parsed as Record<string, unknown>;

  const matched = typeof obj['matched'] === 'string' ? obj['matched'] : undefined;
  if (!matched) {
    throw new Error('Branched AI response missing required "matched" field');
  }

  // For "waiting" responses, actions are optional/empty
  if (matched.toLowerCase() === 'waiting') {
    const reasoning =
      typeof obj['reasoning'] === 'string' ? obj['reasoning'] : 'Page still transitioning';
    return { matched: 'waiting', actions: [], reasoning };
  }

  // Otherwise parse normally for actions
  if (opts.actionsOptional && !Array.isArray(obj['actions']) && typeof obj['action'] !== 'string') {
    const reasoning =
      typeof obj['reasoning'] === 'string' ? obj['reasoning'] : 'No reasoning provided';
    return { matched, actions: [], reasoning };
  }
  const base = validateAndNormaliseResponse(parsed);
  return { matched, ...base };
}

/** Extract JSON from a string that may contain markdown code fences or extra whitespace */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const codeFenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (codeFenceMatch?.[1]) {
    return codeFenceMatch[1].trim();
  }

  // Find the first { or [ and walk braces with depth counting to find the matching
  // close. This isolates the FIRST complete JSON value, ignoring trailing prose or
  // — more importantly — additional JSON objects emitted by indecisive models that
  // return a bare action object followed by a wrapped { actions: [...] } form.
  //
  // Example raw AI response we have seen from gpt-5.4-mini:
  //
  //   {
  //     "action": "click",
  //     "selector": "button[type=submit]",
  //     "description": "Click the Sign in button"
  //   }
  //   {
  //     "actions": [
  //       {
  //         "action": "click",
  //         "selector": "button[type=submit]",
  //         "description": "Click the Sign in button"
  //       }
  //     ],
  //     "reasoning": "Submitting the login form."
  //   }
  //
  // Both blocks are valid JSON and describe the same action; we keep only the
  // first and discard the rest.
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace === -1) {
    throw new Error('No JSON object or array found in response');
  }

  const end = findMatchingBrace(trimmed, firstBrace);
  return end === -1 ? trimmed.substring(firstBrace) : trimmed.substring(firstBrace, end + 1);
}

/**
 * Find the index of the brace that matches the opening brace at `start`,
 * accounting for nested braces and string literals (with escape sequences).
 * Returns -1 if no matching close is found.
 */
function findMatchingBrace(text: string, start: number): number {
  const open = text[start];
  if (open !== '{' && open !== '[') return -1;
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function validateAndNormaliseResponse(parsed: unknown): AIResponse {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('AI response must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  // Accept three response shapes:
  //   1. { actions: [...] }            — canonical
  //   2. [...]                         — bare array
  //   3. { action: "...", ... }        — single action object (models that read
  //                                      "Return exactly ONE action" literally and
  //                                      skip the actions wrapper; about 1 response
  //                                      in 16 in live runs). Flagged below when it
  //                                      also leaves needs_reeval unstated.
  let rawActions: unknown[];
  let bare = false;
  if (Array.isArray(obj)) {
    rawActions = obj;
    bare = true;
  } else if (Array.isArray(obj['actions'])) {
    rawActions = obj['actions'];
  } else if (typeof obj['action'] === 'string') {
    rawActions = [obj];
    bare = true;
  } else {
    throw new Error('AI response must have an "actions" array');
  }

  const actions: AIAction[] = rawActions.map((rawAction, index) => {
    return parseAction(rawAction, index);
  });

  const reasoning =
    typeof obj['reasoning'] === 'string' ? obj['reasoning'] : 'No reasoning provided';

  const needs_reeval = obj['needs_reeval'] === true ? true : undefined;
  // A bare action or bare array that says nothing about needs_reeval has not
  // told us the step is done — see AIResponse.reevalUnstated. An explicit
  // false still is. (An array cannot carry the field at all.)
  const reevalUnstated = bare && typeof obj['needs_reeval'] !== 'boolean';

  return {
    actions,
    reasoning,
    ...(needs_reeval !== undefined && { needs_reeval }),
    ...(reevalUnstated && { reevalUnstated: true as const }),
  };
}

function parseAction(raw: unknown, index: number): AIAction {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Action at index ${index} is not an object`);
  }

  const obj = raw as Record<string, unknown>;

  const rawActionType = obj['action'];
  if (typeof rawActionType !== 'string') {
    throw new Error(`Action at index ${index} missing required "action" field`);
  }

  // Normalise to the canonical type: the name itself, an alias, or either in
  // another case or separator style ("Click", "SWITCH_PAGE", "read_table").
  // Before folding, those three were refused as unknown and cost a retry.
  const actionType = canonicalActionType(rawActionType) ?? rawActionType;
  if (actionType !== rawActionType) {
    logger.info(`Normalised action type "${rawActionType}" → "${actionType}" at index ${index}`);
  }

  // Kept, not thrown. The parser is shared (the condition judge and the branch
  // poller read `matched` and ignore actions), and the step loop has not yet
  // recorded this turn's reply when it parses it: a throw here would drop the
  // reply from the report and reach the retry with no failure to describe.
  // The refusal is the step loop's: it refuses the whole turn before any of it
  // runs, records the ✗ against this action, and the retry prompt lists the
  // types the model may send instead.
  if (!isKnownActionType(actionType)) {
    logger.warn(
      `Unknown action type "${actionType}" at index ${index} — kept as the model wrote it; ` +
        'the step loop refuses the turn',
    );
  }

  const description =
    typeof obj['description'] === 'string'
      ? obj['description']
      : `${actionType} action`;

  const action: AIAction = {
    action: actionType as ActionType,
    description,
  };

  // `mapping` is RUNTIME-OWNED and is dropped here, whatever the model emits
  // and on whatever action (SPEC-structured-table-reads.md §6.1/§7.10).
  //
  // Dropping it is not a courtesy: a mapping is only legal after the runtime
  // has validated it against the live page, and one arriving from a plan has
  // been validated against nothing. Copied through, it would pin a `readTable`
  // to a table the model believes is there and then be written into the step
  // cache as if it had been proved — a wrong read that replays forever with no
  // model call left to notice it. The field never appears in any prompt, so an
  // emitted one is a hallucination by construction.
  //
  // Nothing below copies it, so this is only the WARNING — and the latch on it
  // is once per PROCESS, which is worth being honest about rather than calling
  // it once per run.
  //
  // For the CLI the two are the same thing: one process runs one test. For the
  // Sessions API server they are not. That process outlives every run on it,
  // so the first model that emits a `mapping` uses the warning up and the
  // hundredth run's is silent. That is accepted rather than unnoticed: the
  // field appears in no prompt, so an emitted one is a hallucination by
  // construction and nothing downstream is affected either way — the parser
  // has already refused to copy it. Making it per-run would mean threading a
  // run identity into a pure parser to improve a line nobody acts on.
  //
  // What the latch must not do is lose the EVIDENCE, so every occurrence is
  // logged at debug, where a per-action line costs nothing and a test that
  // reads a table in a loop is not buried.
  if (obj['mapping'] !== undefined) {
    const ignored =
      `Ignoring "mapping" on a ${actionType} action at index ${index} — a table read's `
      + 'mapping is written by the runtime after it has been validated against the page, '
      + 'never by the model (SPEC-structured-table-reads.md §7.10).';
    logger.debug(ignored);
    if (!warnedAboutEmittedMapping) {
      warnedAboutEmittedMapping = true;
      logger.warn(ignored);
    }
  }

  // Optional fields — only add if present
  if (typeof obj['selector'] === 'string') action.selector = obj['selector'];
  // `drag`'s drop target. On the allow-list, because a field this copy does not
  // name never reaches the executor — which would then fail every drag for a
  // missing target the model DID send. The spellings a model reaches for are
  // read too, for a drag only: `to` is a scroll's and a switchBrowser's field,
  // and `source` an extract_csrf's, everywhere else.
  if (actionType === 'drag') {
    const target = [obj['target'], obj['targetSelector'], obj['dropTarget'], obj['dropSelector'], obj['to']]
      .find((v): v is string => typeof v === 'string' && v.trim() !== '' && v !== 'top' && v !== 'bottom');
    if (target !== undefined) action.target = target;
    if (action.selector === undefined && typeof obj['source'] === 'string') action.selector = obj['source'];
  }
  if (typeof obj['value'] === 'string') action.value = obj['value'];
  if (typeof obj['url'] === 'string') action.url = obj['url'];
  // docs/specs/SPEC-web-survey-fixes.md §2.2, §2.4, §2.8, §2.1. Each is read
  // only on the action that uses it: `button` and `text` are common words a
  // model could put on any action, and a stray one must not change a type.
  if (actionType === 'click') {
    const count = Number(obj['clickCount']);
    if (count === 2) action.clickCount = 2;
    const button = obj['button'];
    if (button === 'right' || button === 'middle') action.button = button;
    const hold = Number(obj['holdMs'] ?? obj['holdDuration']);
    if (Number.isFinite(hold) && hold > 0) action.holdMs = Math.min(Math.round(hold), MAX_HOLD_MS);
  }
  if (actionType === 'select' && Array.isArray(obj['values'])) {
    const values = obj['values'].filter((v): v is string => typeof v === 'string' && v !== '');
    if (values.length > 0) action.values = values;
  }
  if (actionType === 'count' && obj['includeHidden'] === true) action.includeHidden = true;
  if (actionType === 'dialog') {
    const text = [obj['text'], obj['promptText'], obj['input']]
      .find((v): v is string => typeof v === 'string');
    if (text !== undefined) action.text = text;
  }
  applyAliasDefaults(action, rawActionType);
  // Upload paths (stories/upload-action.md §2). Normalised here so the cached
  // action and the compiled code-behind carry a relative, forward-slashed path
  // whatever spelling the model used. Normalisation ALSO runs at the point of
  // use, because a `{{param}}` path is interpolated after this parser has run.
  const rawFilePaths = obj['filePaths'];
  let filePaths: string[] | undefined;
  if (Array.isArray(rawFilePaths)) {
    const cleaned = rawFilePaths
      .filter((p): p is string => typeof p === 'string')
      .map(normaliseUploadPath)
      .filter((p) => p !== '');
    if (cleaned.length > 0) filePaths = cleaned;
  }
  // A lone path under the plural key is a shape the model will produce; read it
  // as the singular rather than dropping it and costing a turn.
  const singularPath =
    typeof obj['filePath'] === 'string'
      ? normaliseUploadPath(obj['filePath'])
      : typeof rawFilePaths === 'string'
        ? normaliseUploadPath(rawFilePaths)
        : '';
  if (filePaths !== undefined) {
    action.filePaths = filePaths;
    if (singularPath !== '' && typeof obj['filePath'] === 'string') {
      logger.warn('Upload action carried both "filePath" and "filePaths" — using "filePaths"');
    }
  } else if (singularPath !== '') {
    action.filePath = singularPath;
  }
  if (typeof obj['condition'] === 'string') action.condition = obj['condition'];
  if (typeof obj['expected'] === 'string') action.expected = obj['expected'];
  if (typeof obj['key'] === 'string') action.key = obj['key'];
  if (typeof obj['question'] === 'string') action.question = obj['question'];

  // Preserve the AI's explicit wait kind. Without this the field was silently
  // dropped and executeWait fell back to inferWaitType(condition) every time —
  // ignoring the model's choice and mis-handling conditions the heuristic reads
  // wrong (e.g. a text wait whose condition looks like a selector/URL).
  if (
    obj['waitType'] === 'selector' || obj['waitType'] === 'hidden' ||
    obj['waitType'] === 'text' || obj['waitType'] === 'url' ||
    obj['waitType'] === 'load' || obj['waitType'] === 'duration' ||
    obj['waitType'] === 'count' || obj['waitType'] === 'attribute' ||
    obj['waitType'] === 'navigation' || obj['waitType'] === 'stable'
  ) {
    action.waitType = obj['waitType'];
  }

  if (typeof obj['direction'] === 'string') {
    const dir = obj['direction'];
    if (dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right') {
      action.direction = dir;
    }
  }

  // Absolute scroll target. Guarded exactly like `direction`: an unrecognised
  // value ("middle", "end") is dropped silently so the action falls through to
  // its other fields, rather than failing the step over harmless noise.
  if (typeof obj['to'] === 'string') {
    const to = obj['to'];
    if (to === 'top' || to === 'bottom') {
      action.to = to;
    }
  }

  if (typeof obj['amount'] === 'number') action.amount = obj['amount'];
  if (typeof obj['timeout'] === 'number') action.timeout = obj['timeout'];

  // API action fields
  if (typeof obj['method'] === 'string') action.method = obj['method'];
  if (obj['body'] !== undefined) action.body = obj['body'];
  if (typeof obj['source'] === 'string') action.source = obj['source'];
  if (typeof obj['path'] === 'string') action.path = obj['path'];
  if (typeof obj['as'] === 'string') action.as = obj['as'];
  if (typeof obj['attribute'] === 'string') action.attribute = obj['attribute'];
  if (obj['multiple'] === true) action.multiple = true;
  if (typeof obj['pattern'] === 'string') action.pattern = obj['pattern'];
  if (typeof obj['frame'] === 'string') action.frame = obj['frame'];
  if (typeof obj['page'] === 'string') action.page = obj['page'];

  // Multi-browser fields. The browser-action subset uses different keys
  // for the label depending on operation: openBrowser writes `as`,
  // switchBrowser writes `to` (also accepted as `browserLabel`),
  // closeBrowser writes `as` (also `browserLabel`). Normalise all into
  // `browserLabel` for the executor.
  if (typeof obj['browserLabel'] === 'string') action.browserLabel = obj['browserLabel'];
  if (action.action === 'switchBrowser' && typeof obj['to'] === 'string' && !action.browserLabel) {
    action.browserLabel = obj['to'];
  }
  if ((action.action === 'openBrowser' || action.action === 'closeBrowser')
      && typeof obj['as'] === 'string' && !action.browserLabel) {
    action.browserLabel = obj['as'];
  }
  const rawEngine = obj['engine'];
  if (rawEngine === 'chromium' || rawEngine === 'firefox' || rawEngine === 'webkit') {
    action.engine = rawEngine;
  }
  if (typeof obj['channel'] === 'string') action.channel = obj['channel'];
  if (typeof obj['headed'] === 'boolean') action.headed = obj['headed'];

  // Required-label check for the three browser actions. Loud failure ≫ soft
  // fallback — same policy applied to switchBrowser unknown labels at runtime.
  if (action.action === 'openBrowser' && !action.browserLabel) {
    throw new Error(
      `openBrowser action at index ${index} missing required "as" field (the label this new browser is registered under)`,
    );
  }
  if (action.action === 'switchBrowser' && !action.browserLabel) {
    throw new Error(
      `switchBrowser action at index ${index} missing required "to" field (the label of the browser to switch to)`,
    );
  }
  if (action.action === 'closeBrowser' && !action.browserLabel) {
    throw new Error(
      `closeBrowser action at index ${index} missing required "as" field (the label of the browser to close)`,
    );
  }

  // Structured table reads. Validated as a unit AFTER the scalar fields are
  // copied, because every rule reads `selector` / `as` off the canonical
  // action rather than the raw object (SPEC-structured-table-reads.md §6.2).
  if (action.action === 'readTable') {
    applyTableReadFields(action, obj, index);
  }

  const modeRaw = obj['apiMode'];
  if (modeRaw === 'browser' || modeRaw === 'standalone') {
    action.apiMode = modeRaw;
  }

  if (typeof obj['apiHeaders'] === 'object' && obj['apiHeaders'] !== null && !Array.isArray(obj['apiHeaders'])) {
    const rawHeaders = obj['apiHeaders'] as Record<string, unknown>;
    const safeHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v === 'string') safeHeaders[k] = v;
    }
    action.apiHeaders = safeHeaders;
  }

  // Assert-specific optional fields
  if (action.action === 'assert') {
    // A CONCESSION: `"holds": false` is the model reporting, in its own
    // judgment, that the step cannot be done — the shape rule 24 of the system
    // prompt teaches for a step asking to change surface, and the one the
    // retry after an unknown action type offers when no action does what the
    // step asks. Nothing is evaluated, so none of an evaluated assert's fields
    // is required. Measured on gpt-5.6-luna, the reply is
    // `{"action":"assert","holds":false,"evidence":"…"}` and nothing more, and
    // requiring `description` threw it away: the step failed in the parser's
    // words, and the model's evidence never reached the report.
    // The step loop fails the step with the evidence and does not retry it.
    //
    // Only `false` is believed. `"holds": true` would be the model certifying
    // its own pass, so it is dropped and the assert is evaluated like any other.
    if (obj['holds'] === false) {
      action.holds = false;
      const evidence = typeof obj['evidence'] === 'string' ? obj['evidence'].trim() : '';
      if (evidence !== '') action.evidence = evidence;
      if (typeof obj['description'] !== 'string' || !obj['description'].trim()) {
        action.description = 'Report the step as unachievable';
      }
      return action;
    }

    const rawPoll = obj['poll'];
    if (typeof rawPoll === 'object' && rawPoll !== null && !Array.isArray(rawPoll)) {
      const pollObj = rawPoll as Record<string, unknown>;
      const poll: { timeoutMs?: number; intervalMs?: number } = {};
      if (typeof pollObj['timeoutMs'] === 'number') poll.timeoutMs = pollObj['timeoutMs'];
      if (typeof pollObj['intervalMs'] === 'number') poll.intervalMs = pollObj['intervalMs'];
      action.poll = poll;
    } else if (rawPoll === true) {
      action.poll = {};
    }

    const rawAgainst = obj['against'];
    if (
      rawAgainst === 'dom' ||
      rawAgainst === 'api' ||
      rawAgainst === 'both' ||
      rawAgainst === 'predicate'
    ) {
      action.against = rawAgainst;
    }

    // Required fields for assert: description and condition (always);
    // expected (required for dom/api/both, REJECTED for predicate).
    // description is already populated above with a fallback; reject if it
    // was the synthetic fallback rather than a real value.
    if (typeof obj['description'] !== 'string' || !obj['description'].trim()) {
      throw new Error(`Assert action at index ${index} missing required "description" field`);
    }
    if (typeof obj['condition'] !== 'string' || !obj['condition'].trim()) {
      throw new Error(`Assert action at index ${index} missing required "condition" field`);
    }

    if (action.against === 'predicate') {
      // Predicate mode: `expected` is meaningless because both sides of the
      // comparison are already in `condition`. Strict reject if the AI
      // sends one anyway — fails loudly when modes get confused, rather
      // than silently picking a side.
      if (obj['expected'] !== undefined && obj['expected'] !== null && obj['expected'] !== '') {
        throw new Error(
          `Assert action at index ${index} sets "against": "predicate" but also includes "expected" — these are mutually exclusive. Drop "expected" for predicate mode, or remove "against" to use the default DOM mode.`,
        );
      }
    } else {
      // dom / api / both / undefined (defaults to dom in the runner).
      //
      // PRESENT, not non-empty: `""` is the right expectation for "the
      // Reference cell is empty", so the old `.trim()` test rejected the model
      // exactly when it answered correctly, and the step failed in the parser
      // before any page was read. An empty cell is a legitimate thing to
      // assert (SPEC-structured-table-reads.md §8.3, "Empty values"); what is
      // not legitimate is omitting the field, which is a half-built action.
      if (typeof obj['expected'] !== 'string') {
        throw new Error(
          `Assert action at index ${index} missing required "expected" field (or set "against": "predicate" for self-contained predicates over already-substituted values)`,
        );
      }
    }
  }

  return action;
}

/**
 * Extract the code-behind entry from a `buildStepCodePrompt` response
 * (stories/step-codebehind.md, "Generation").
 *
 * `AiClient.complete` forces `responseFormat: json_object`, so the model
 * CANNOT return a bare fenced block — the primary shape is the assertion-code
 * envelope, `{"entry": "<object literal as a string>"}`. The fence/raw paths
 * below remain as fallbacks for clients without JSON mode, and for models
 * that nest a fence inside the envelope string.
 */
export function parseStepCode(rawResponse: string): string {
  const decoded = parseStepCodeOrDecline(rawResponse);
  if (decoded.kind === 'declined') {
    throw new Error(`Step code response declined: ${decoded.reason}`);
  }
  return decoded.entry;
}

/**
 * A `[use ai]` step's answer (stories/use-ai-step.md, decision 5), read three
 * ways because the runner treats them three ways:
 *
 *  - `value` — the answer. `as` is the model's name for it, present only when
 *    it wrote a non-empty string there; the runner decides whether to believe
 *    it.
 *  - `error` — the model saying the step cannot be done as written. A real
 *    outcome, not a formatting slip: the step fails with the reason and is
 *    NOT retried, because asking again until the model stops refusing is how
 *    a guess gets stored.
 *  - `malformed` — anything else, with `why` written for two readers at once:
 *    the step's error, and the retry prompt that tells the model what to fix.
 */
export type UseAiReply =
  | { kind: 'value'; as?: string; value: string }
  | { kind: 'error'; reason: string }
  | { kind: 'malformed'; why: string };

/**
 * Parse a `[use ai]` reply: `{"as": name, "value": v}` or `{"error": reason}`
 * and nothing else.
 *
 * On top of {@link extractJson}, so a fence or prose around the object is
 * tolerated the way every other reply parser here tolerates it — the value
 * inside is still the only thing stored, which is the property that matters:
 * nothing conversational ever reaches a variable.
 *
 * `value` is a string, or a number or boolean stored as its string form (`42`
 * → `"42"`, as a `count` stores). An object or an array is refused — lists
 * are not in this story — and so is a value that is empty once trimmed, which
 * would otherwise store `""` and pass green. The value is TRIMMED: the model
 * is asked for the value alone, and leading or trailing whitespace is never
 * part of what an author asked for.
 */
export function parseUseAiReply(rawResponse: string): UseAiReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawResponse));
  } catch {
    return { kind: 'malformed', why: 'the reply was not a JSON object' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', why: 'the reply was not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const hasValue = Object.hasOwn(obj, 'value');
  const hasError = Object.hasOwn(obj, 'error');
  if (hasValue && hasError) {
    return {
      kind: 'malformed',
      why: 'the reply had both "value" and "error"; send exactly one of them',
    };
  }
  if (!hasValue && !hasError) {
    return { kind: 'malformed', why: 'the reply had neither "value" nor "error"' };
  }

  if (hasError) {
    const reason = obj['error'];
    if (typeof reason !== 'string' || reason.trim() === '') {
      return {
        kind: 'malformed',
        why: '"error" must be a sentence saying why the step cannot be done',
      };
    }
    return { kind: 'error', reason: reason.trim() };
  }

  const raw = obj['value'];
  let value: string;
  if (typeof raw === 'string') value = raw.trim();
  else if (typeof raw === 'number' && Number.isFinite(raw)) value = String(raw);
  else if (typeof raw === 'boolean') value = String(raw);
  else if (Array.isArray(raw)) {
    return { kind: 'malformed', why: '"value" was a list; this step stores one piece of text' };
  } else if (raw !== null && typeof raw === 'object') {
    return { kind: 'malformed', why: '"value" was an object; this step stores one piece of text' };
  } else {
    return { kind: 'malformed', why: '"value" was not text' };
  }
  if (value === '') return { kind: 'malformed', why: '"value" was empty' };

  const as = obj['as'];
  return {
    kind: 'value',
    value,
    ...(typeof as === 'string' && as.trim() !== '' && { as: as.trim() }),
  };
}

/** A generation answer: code, or a reasoned refusal. */
export type StepCodeAnswer =
  | { kind: 'entry'; entry: string }
  | { kind: 'declined'; reason: string };

/**
 * `parseStepCode`, plus the compiler's decline case
 * (stories/codebehind-compile.md, "Generate").
 *
 * `{"entry": null, "reason": "..."}` is how the model says a step needs a
 * framework action, interactive input, or a judgement code can't express. The
 * compiler turns that into an `ai: true` entry carrying the reason, so the
 * author sees exactly what stayed AI and why — strictly better than a silent
 * omission, which is indistinguishable from the model failing.
 */
export function parseStepCodeOrDecline(
  rawResponse: string,
  /**
   * Which function the entry must define: `run` for a step (the default, and
   * every caller before condition entries existed), `condition` for a
   * condition line's entry (stories/codebehind-loops-and-conditions.md,
   * decision 4). The other function is not refused here — an entry carrying
   * both is the generator's static check to complain about, with a re-ask —
   * but the one asked for must be there, or there is nothing to run.
   */
  expect: 'run' | 'condition' = 'run',
): StepCodeAnswer {
  let body = rawResponse;
  try {
    const parsed: unknown = JSON.parse(extractJson(rawResponse));
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const entry = obj['entry'];
      if (entry === null || (typeof entry === 'string' && !entry.trim())) {
        const reason = obj['reason'];
        return {
          kind: 'declined',
          reason: typeof reason === 'string' && reason.trim()
            ? reason.trim()
            : 'the model declined without giving a reason',
        };
      }
      if (typeof entry === 'string') {
        body = decodeDoubleEscapedNewlines(entry);
      }
    }
  } catch {
    // Not a JSON envelope — treat the raw response as the body.
  }
  return { kind: 'entry', entry: parseEntryLiteral(body, expect) };
}

/**
 * Pull the entry object literal out of a decoded response body.
 *
 * Exported for tests. `expect` names the function the entry must define — see
 * {@link parseStepCodeOrDecline}.
 */
export function parseEntryLiteral(body: string, expect: 'run' | 'condition' = 'run'): string {

  const fenced = /```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/i.exec(body);
  const inner = (fenced?.[1] ?? body).trim();

  // Some models wrap the entry in `export default defineSteps([...])` despite
  // being asked for one entry; take the first object literal in that case.
  const open = inner.indexOf('{');
  if (open === -1) {
    throw new Error('Step code response contains no object literal');
  }
  const entry = inner.slice(open).trim().replace(/[,;]+$/, '');
  if (!entry.startsWith('{')) {
    throw new Error('Step code response is not an object literal');
  }
  if (!/\bsource\s*:/.test(entry)) {
    throw new Error('Step code entry is missing a `source` property');
  }
  if (expect === 'run' && !/\brun\s*[(:]/.test(entry)) {
    throw new Error('Step code entry is missing a `run` function');
  }
  // A condition line's entry answers with `condition` in place of `run`
  // (stories/codebehind-loops-and-conditions.md, decision 4).
  if (expect === 'condition' && !/\bcondition\s*[(:]/.test(entry)) {
    throw new Error('Condition code entry is missing a `condition` function');
  }
  return entry;
}

/**
 * Undo a model double-escaping the envelope: `"entry": "{ ... \\n ... }"`
 * parses to an entry whose CODE positions hold literal backslash-n, which can
 * only ever be a syntax error. Decode `\n`/`\t` sequences — but only when the
 * entry has no real newlines at all, so genuinely multi-line code that uses a
 * legitimate `'\n'` string literal is never touched. A wrong guess here is
 * caught by the writer's esbuild validation, which refuses the write.
 *
 * Exported because every envelope carrying code has the same problem — the
 * compiler's review (`{"file": ...}`) and repair passes reuse it.
 */
export function decodeDoubleEscapedNewlines(entry: string): string {
  if (entry.includes('\n') || !entry.includes('\\n')) return entry;
  return entry.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/**
 * Shortest resolved parameter value the leak guard will look for.
 *
 * A one- or two-character value ("1", "AU") occurs incidentally in almost any
 * code — matching on it would reject every generation and teach nobody
 * anything. Nothing that short is a secret worth keeping out of a file.
 */
export const MIN_GUARDED_VALUE_LENGTH = 3;

/**
 * The post-generation guard: refuse code that inlines a resolved parameter
 * value (stories/step-codebehind.md, rule 1). This is what keeps
 * `{{password}}` out of a committed `.steps.ts`.
 *
 * Returns the offending parameter's name, or undefined when the code is
 * clean. Deliberately a plain substring test over the whole entry — a value
 * that appears in a comment, a selector or a template literal is just as
 * committed as one in a string literal.
 */
export function findInlinedParameterValue(
  code: string,
  parameters: Array<{ name: string; value: string }>,
): string | undefined {
  for (const { name, value } of parameters) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length < MIN_GUARDED_VALUE_LENGTH) continue;
    if (code.includes(trimmed)) return name;
  }
  return undefined;
}
