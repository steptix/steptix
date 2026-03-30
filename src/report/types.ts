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
}

/** Result of a single test step */
export interface StepResult {
  /** 1-based step number */
  index: number;
  instruction: string;
  status: StepStatus;
  subActions: SubActionResult[];
  assertion?: AssertionResult;
  /** Screenshot captured at the start of the step */
  screenshotBase64?: string;
  /** DOM snapshot at the start of the step */
  domSnapshot?: string;
  durationMs: number;
  /** Whether this step was retried */
  retried: boolean;
  error?: string;
  /** AI explanation of what it was attempting (shown on failure) */
  aiExplanation?: string;
  /** All raw AI responses captured during this step */
  aiResponses?: AiInteraction[];
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
