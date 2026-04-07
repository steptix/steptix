export interface StepConfig {
  baseUrl?: string;
  timeout?: string;
}

export interface StepRequest {
  config?: StepConfig;
  steps: string[];
}

export interface ActionDetail {
  type: string;
  [key: string]: unknown;
}

export interface StepResultItem {
  step: string;
  status: "passed" | "failed" | "error";
  actions: ActionDetail[];
  screenshot: string | null;
  reasoning: string;
  outputs: Record<string, string>;
}

export interface StepResponse {
  sessionId: string;
  status: "passed" | "failed" | "error";
  stepsCompleted: number;
  stepsTotal: number;
  results: StepResultItem[];
  outputs: Record<string, string>;
  error: { step: number; message: string } | null;
}

export interface SessionStatus {
  sessionId: string;
  status: "active" | "executing" | "queued";
  currentUrl: string;
  pageTitle: string;
  screenshot: string;
  outputs: Record<string, string>;
  totalStepsExecuted: number;
}

export interface SessionListItem {
  sessionId: string;
  status: string;
  currentUrl: string;
  pageTitle: string;
  totalStepsExecuted: number;
}

export interface SessionListResponse {
  sessions: SessionListItem[];
}
