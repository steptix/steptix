/**
 * A stored API response from a prior step.
 * Kept in memory during test execution; included in AI context for subsequent steps.
 */
export interface StoredResponse {
  stepNumber: number;
  /** Short endpoint path, e.g. "/api/delegates/v1/list" */
  endpoint: string;
  method: string;
  url: string;
  requestBody?: unknown;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  timestamp: number;
}

/** The raw result of an HTTP API call */
export interface ApiCallResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}
