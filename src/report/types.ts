import type { AIAction, AssertionEvaluation } from '../ai/types.js';

export type StepStatus = 'passed' | 'failed' | 'skipped';

/** Captured data from an API call sub-action */
export interface ApiCallData {
  method: string;
  url: string;
  requestBody?: unknown;
  requestHeaders?: Record<string, string>;
  status: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
}

/** Result of a single sub-action execution */
export interface SubActionResult {
  /** 1-based index within the parent step */
  index: number;
  action: AIAction;
  /** Base64-encoded PNG screenshot taken after this action */
  screenshotBase64?: string;
  /** Cleaned DOM snapshot after this action */
  domSnapshot?: string;
  /** AI reasoning for this specific action */
  aiReasoning?: string;
  durationMs: number;
  error?: string;
  /** Populated for api_call sub-actions */
  apiCallData?: ApiCallData;
  /** Page URL at the time the screenshot was captured */
  pageUrl?: string;
  /** ISO 8601 timestamp when this sub-action completed */
  timestamp?: string;
}

/** Result of an assertion embedded in a step */
export interface AssertionResult extends AssertionEvaluation {
  expected: string;
}

/** A single captured AI response during step execution */
export interface AiInteraction {
  /** What triggered this AI call (e.g. "action-plan", "clarification", "assertion") */
  purpose: string;
  /** Which retry attempt this interaction belongs to (1 = first attempt, 2 = first retry, etc.) */
  attemptNumber?: number;
  /** Text-only messages sent to the AI (base64 images omitted; screenshots are captured separately) */
  requestMessages?: Array<{ role: string; content: string }>;
  /** The raw response text from the AI */
  response: string;
  /** Screenshot the AI saw when making this decision (page state at time of AI call) */
  screenshotBase64?: string;
  /** Page URL at the time of the AI call */
  pageUrl?: string;
  /** ISO 8601 timestamp when the AI was called */
  timestamp?: string;
}

/** A single turn within a step (AI decision + resulting actions) */
export interface TurnResult {
  /** 1-based turn number */
  turnNumber: number;
  /** Which retry attempt this turn belongs to (1 = first attempt, 2 = first retry, etc.) */
  attemptNumber: number;
  /** ISO 8601 timestamp when this turn started */
  timestamp: string;
  /** The AI interaction(s) for this turn (action-plan, and optionally clarification) */
  aiInteractions: AiInteraction[];
  /** Sub-actions executed from this turn's action plan */
  subActions: SubActionResult[];
}

/** Result of a single test step */
export interface StepResult {
  /** 1-based step number */
  index: number;
  instruction: string;
  status: StepStatus;
  /** Ordered turns — each groups an AI decision with the sub-actions it produced */
  turns: TurnResult[];
  assertion?: AssertionResult;
  /** AI interaction for the assertion evaluation (runs after all turns) */
  assertionAiInteraction?: AiInteraction;
  /** Screenshot captured at the end of the step */
  screenshotBase64?: string;
  /** Page URL at the time the end-of-step screenshot was captured */
  pageUrl?: string;
  /** DOM snapshot at the start of the step */
  domSnapshot?: string;
  durationMs: number;
  /** Whether this step was retried */
  retried: boolean;
  error?: string;
  /** AI explanation of what it was attempting (shown on failure) */
  aiExplanation?: string;
}

/** Complete test run report data */
export interface TestReport {
  testName: string;
  filePath: string;
  tags: string[];
  status: StepStatus;
  steps: StepResult[];
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  totalSubActions: number;
  durationMs: number;
  tokensUsed: number;
  /** Input (prompt) tokens consumed across all AI calls */
  inputTokens: number;
  /** Output (completion) tokens consumed across all AI calls */
  outputTokens: number;
  /** ISO 8601 date string */
  date: string;
  baseUrl?: string;
  parameters?: Record<string, string>;
  /** Data row number for data-driven tests (1-based) */
  dataRow?: number;
}

/** Summary across all test runs in a session */
export interface RunSummary {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  totalDurationMs: number;
  totalTokensUsed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  reports: TestReport[];
}

// ---------------------------------------------------------------------------
// Helpers for migrating consumers that used the old flat arrays
// ---------------------------------------------------------------------------

/** Extract all sub-actions from a step's turns (replaces step.subActions) */
export function getAllSubActions(step: StepResult): SubActionResult[] {
  return step.turns.flatMap((t) => t.subActions);
}

/** Extract all AI interactions from a step's turns + assertion (replaces step.aiResponses) */
export function getAllAiInteractions(step: StepResult): AiInteraction[] {
  const fromTurns = step.turns.flatMap((t) => t.aiInteractions);
  return step.assertionAiInteraction
    ? [...fromTurns, step.assertionAiInteraction]
    : fromTurns;
}
