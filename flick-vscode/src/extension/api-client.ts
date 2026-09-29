// Thin client for the Steptix Sessions API (see SPEC-SESSIONS-API.md).
// Uses the global `fetch` available in the VS Code extension host (Node 18+).

import type { FlickSettings, StepStatus } from '../shared/protocol';

/** Per-step result exactly as the API returns it (screenshot still base64). */
export interface RawStepResult {
  step: string;
  /** Shared with the webview's `StepResult` rather than spelled out again: the
   *  union gained `skipped` when `If … then return` shipped, and two copies of
   *  it is how one of them gets missed (stories/step-flow-control.md). */
  status: StepStatus;
  actions: Array<{ action: string; [key: string]: unknown }>;
  reasoning: string;
  outputs: Record<string, string>;
  screenshot: string | null;
}

export interface RawStepsResponse {
  sessionId: string;
  status: 'passed' | 'failed' | 'error';
  stepsCompleted: number;
  stepsTotal: number;
  results: RawStepResult[];
  outputs: Record<string, string>;
  /** Per-key provenance for `outputs`, same keys, labelled by where the
   *  variable came from. Optional — an older server omits it. */
  outputSources?: Record<string, 'parameter' | 'capture' | 'toolOutput'>;
  error: { step: number; message: string } | null;
}

export interface StepsRequestConfig {
  baseUrl?: string;
  timeout?: string;
  /** CDP attach hint — passed through to the runner. Present only on the
   *  first request for a CDP-adopted session. */
  cdp?: { port: number; tab?: string };
}

/** Raised for any non-2xx HTTP response or network failure. */
export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export class SessionsApiClient {
  constructor(private settings: FlickSettings) {}

  update(settings: FlickSettings): void {
    this.settings = settings;
  }

  private baseUrl(): string {
    return this.settings.apiUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.settings.apiKey,
    };
  }

  /** POST /sessions/:id/steps — execute a batch of steps synchronously. */
  async submitSteps(
    sessionId: string,
    steps: string[],
    config: StepsRequestConfig | null,
  ): Promise<RawStepsResponse> {
    const body: Record<string, unknown> = { steps };
    if (config && (config.baseUrl || config.timeout || config.cdp)) {
      const out: StepsRequestConfig = {};
      if (config.baseUrl) out.baseUrl = config.baseUrl;
      if (config.timeout) out.timeout = config.timeout;
      if (config.cdp) out.cdp = config.cdp;
      body.config = out;
    }
    const url = `${this.baseUrl()}/sessions/${encodeURIComponent(sessionId)}/steps`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(
        `Cannot reach the API server. Check your connection and settings. (${(err as Error).message})`,
      );
    }
    if (!res.ok) {
      const detail = await safeText(res);
      throw new ApiError(
        `API returned ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
        res.status,
      );
    }
    return (await res.json()) as RawStepsResponse;
  }

  /**
   * GET /sessions/:id — used for stale-session detection.
   * Returns 'active' | 'missing' | 'unreachable'.
   */
  async sessionState(sessionId: string): Promise<'active' | 'missing' | 'unreachable'> {
    const url = `${this.baseUrl()}/sessions/${encodeURIComponent(sessionId)}`;
    try {
      const res = await fetch(url, { method: 'GET', headers: this.headers() });
      if (res.status === 404) return 'missing';
      if (!res.ok) return 'unreachable';
      return 'active';
    } catch {
      return 'unreachable';
    }
  }

  /** GET /sessions — used as the connectivity ping. */
  async ping(): Promise<boolean> {
    const url = `${this.baseUrl()}/sessions`;
    try {
      const res = await fetch(url, { method: 'GET', headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * GET /sessions — return the active sessions the server is currently
   * holding. Used by the "Adopt server session" dropdown so users can pick
   * up an existing browser instead of starting a fresh one. Throws ApiError
   * on any non-2xx response or network failure so the UI can surface the
   * message; callers handle the empty-list case in the response, not here.
   */
  async listSessions(): Promise<ServerSessionItem[]> {
    const url = `${this.baseUrl()}/sessions`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers: this.headers() });
    } catch (err) {
      throw new ApiError(
        `Cannot reach the API server. Check your connection and settings. (${(err as Error).message})`,
      );
    }
    if (!res.ok) {
      const detail = await safeText(res);
      throw new ApiError(
        `API returned ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
        res.status,
      );
    }
    const body = (await res.json()) as { sessions?: ServerSessionItem[] };
    return Array.isArray(body.sessions) ? body.sessions : [];
  }
}

/** Shape returned by GET /sessions — matches the server's SessionListItem. */
export interface ServerSessionItem {
  sessionId: string;
  status: string;
  currentUrl: string;
  pageTitle: string;
  totalStepsExecuted: number;
}

async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}
