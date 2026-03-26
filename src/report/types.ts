import type { AIAction, AssertionEvaluation } from '../ai/types.js';

export type StepStatus = 'passed' | 'failed' | 'skipped';

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
}

/** Result of an assertion embedded in a step */
export interface AssertionResult extends AssertionEvaluation {
  expected: string;
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
  reports: TestReport[];
}
