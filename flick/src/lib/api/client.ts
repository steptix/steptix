import type {
  StepConfig,
  StepResponse,
  SessionStatus,
  SessionListResponse,
} from "./types";

async function request<T>(
  apiUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    throw new Error("Unauthorized: check your API key");
  }
  if (res.status === 404) {
    throw new Error("Session not found");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${text}`);
  }

  return res.json();
}

export async function postSteps(
  apiUrl: string,
  apiKey: string,
  sessionId: string,
  steps: string[],
  config?: StepConfig,
): Promise<StepResponse> {
  const body: Record<string, unknown> = { steps };
  if (config) {
    body.config = config;
  }
  return request<StepResponse>(
    apiUrl,
    apiKey,
    "POST",
    `/sessions/${encodeURIComponent(sessionId)}/steps`,
    body,
  );
}

export async function getSession(
  apiUrl: string,
  apiKey: string,
  sessionId: string,
): Promise<SessionStatus> {
  return request<SessionStatus>(
    apiUrl,
    apiKey,
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function deleteServerSession(
  apiUrl: string,
  apiKey: string,
  sessionId: string,
): Promise<void> {
  await request<{ status: string }>(
    apiUrl,
    apiKey,
    "DELETE",
    `/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function getSessions(
  apiUrl: string,
  apiKey: string,
): Promise<SessionListResponse> {
  return request<SessionListResponse>(apiUrl, apiKey, "GET", "/sessions");
}
