import type { AIAction, AIResponse, BranchedAIResponse, ActionType } from './types.js';
import { logger } from '../utils/logger.js';

const VALID_ACTION_TYPES: Set<ActionType> = new Set([
  'click', 'type', 'select', 'navigate', 'upload',
  'hover', 'wait', 'scroll', 'switchFrame', 'switchPage', 'closePage', 'openPage',
  'openBrowser', 'switchBrowser', 'closeBrowser',
  'dismiss',
  'assert', 'keyboard', 'keypress', 'prompt',
  'api_call', 'extract_csrf', 'extract_value',
  'read', 'count',
  'find', 'expand',
  'noop',
]);

/**
 * Normalise common AI action type variants to canonical types.
 * AI models sometimes return "api", "http", "request" etc. instead of "api_call".
 */
const ACTION_TYPE_ALIASES: Record<string, ActionType> = {
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
};

/**
 * Parse the raw string response from the AI into a structured AIResponse.
 * Handles JSON wrapped in markdown code blocks, whitespace, and minor formatting issues.
 */
export function parseAIResponse(rawResponse: string): AIResponse {
  const jsonString = extractJson(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
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
  const jsonString = extractJson(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new Error(`Assertion code response is not valid JSON: ${String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Assertion code response must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj['code'] !== 'string' || !obj['code'].trim()) {
    throw new Error('Assertion code response missing "code" field');
  }

  return obj['code'];
}

/**
 * Parse the AI response for a branched (conditional) step.
 * Extracts the `matched` field in addition to standard actions.
 */
export function parseBranchedResponse(rawResponse: string): BranchedAIResponse {
  const jsonString = extractJson(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
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
  //   3. { action: "...", ... }        — single action object (common with smaller
  //                                      models that read "Return exactly ONE action"
  //                                      literally and skip the actions wrapper)
  let rawActions: unknown[];
  if (Array.isArray(obj)) {
    rawActions = obj;
  } else if (Array.isArray(obj['actions'])) {
    rawActions = obj['actions'];
  } else if (typeof obj['action'] === 'string') {
    rawActions = [obj];
  } else {
    throw new Error('AI response must have an "actions" array');
  }

  const actions: AIAction[] = rawActions.map((rawAction, index) => {
    return parseAction(rawAction, index);
  });

  const reasoning =
    typeof obj['reasoning'] === 'string' ? obj['reasoning'] : 'No reasoning provided';

  const needs_reeval = obj['needs_reeval'] === true ? true : undefined;

  return { actions, reasoning, ...(needs_reeval !== undefined && { needs_reeval }) };
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

  // Normalise common AI variants to canonical action types
  const actionType = ACTION_TYPE_ALIASES[rawActionType] ?? rawActionType;
  if (actionType !== rawActionType) {
    logger.info(`Normalised action type "${rawActionType}" → "${actionType}" at index ${index}`);
  }

  if (!VALID_ACTION_TYPES.has(actionType as ActionType)) {
    logger.warn(`Unknown action type "${actionType}" at index ${index} — treating as unknown`);
  }

  const description =
    typeof obj['description'] === 'string'
      ? obj['description']
      : `${actionType} action`;

  const action: AIAction = {
    action: actionType as ActionType,
    description,
  };

  // Optional fields — only add if present
  if (typeof obj['selector'] === 'string') action.selector = obj['selector'];
  if (typeof obj['value'] === 'string') action.value = obj['value'];
  if (typeof obj['url'] === 'string') action.url = obj['url'];
  if (typeof obj['filePath'] === 'string') action.filePath = obj['filePath'];
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
      if (typeof obj['expected'] !== 'string' || !obj['expected'].trim()) {
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
 * The model is asked for a fenced `ts` block holding a single object literal.
 * A response with no fence is accepted as long as it is itself an object
 * literal — models drop the fence often enough that refusing would cost a
 * generation for no gain.
 */
export function parseStepCode(rawResponse: string): string {
  const fenced = /```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/i.exec(rawResponse);
  const body = (fenced?.[1] ?? rawResponse).trim();

  // Some models wrap the entry in `export default defineSteps([...])` despite
  // being asked for one entry; take the first object literal in that case.
  const open = body.indexOf('{');
  if (open === -1) {
    throw new Error('Step code response contains no object literal');
  }
  const entry = body.slice(open).trim().replace(/[,;]+$/, '');
  if (!entry.startsWith('{')) {
    throw new Error('Step code response is not an object literal');
  }
  if (!/\bsource\s*:/.test(entry)) {
    throw new Error('Step code entry is missing a `source` property');
  }
  if (!/\brun\s*[(:]/.test(entry)) {
    throw new Error('Step code entry is missing a `run` function');
  }
  return entry;
}

/**
 * Shortest resolved parameter value the leak guard will look for.
 *
 * A one- or two-character value ("1", "AU") occurs incidentally in almost any
 * code — matching on it would reject every generation and teach nobody
 * anything. Nothing that short is a secret worth keeping out of a file.
 */
const MIN_GUARDED_VALUE_LENGTH = 3;

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
