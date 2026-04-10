import type { AIAction, AIResponse, BranchedAIResponse, AssertionEvaluation, ActionType } from './types.js';
import { logger } from '../utils/logger.js';

const VALID_ACTION_TYPES: Set<ActionType> = new Set([
  'click', 'type', 'select', 'navigate', 'upload',
  'hover', 'wait', 'scroll', 'switchFrame', 'switchPage', 'closePage', 'dismiss',
  'assert', 'keyboard', 'keypress', 'prompt',
  'api_call', 'extract_csrf', 'extract_value',
  'read', 'count',
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
 * Parse an assertion evaluation response from the AI.
 */
export function parseAssertionEvaluation(rawResponse: string): AssertionEvaluation {
  const jsonString = extractJson(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new Error(`Assertion response is not valid JSON: ${String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Assertion response must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  return {
    pass: Boolean(obj['pass']),
    actual: typeof obj['actual'] === 'string' ? obj['actual'] : String(obj['actual'] ?? ''),
    explanation:
      typeof obj['explanation'] === 'string'
        ? obj['explanation']
        : 'No explanation provided',
  };
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

  // Find the first { or [ and extract from there to matching closing brace
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace === -1) {
    throw new Error('No JSON object or array found in response');
  }

  const jsonStart = trimmed.substring(firstBrace);
  const lastBrace = Math.max(jsonStart.lastIndexOf('}'), jsonStart.lastIndexOf(']'));

  if (lastBrace === -1) {
    return jsonStart;
  }

  return jsonStart.substring(0, lastBrace + 1);
}

function validateAndNormaliseResponse(parsed: unknown): AIResponse {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('AI response must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  // Handle both { actions: [...] } and a bare array [...]
  let rawActions: unknown[];
  if (Array.isArray(obj)) {
    rawActions = obj;
  } else if (Array.isArray(obj['actions'])) {
    rawActions = obj['actions'];
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

  if (typeof obj['direction'] === 'string') {
    const dir = obj['direction'];
    if (dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right') {
      action.direction = dir;
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
  if (typeof obj['frame'] === 'string') action.frame = obj['frame'];
  if (typeof obj['page'] === 'string') action.page = obj['page'];

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

  return action;
}
