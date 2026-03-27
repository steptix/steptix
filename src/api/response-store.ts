import type { StoredResponse } from './types.js';

/**
 * In-memory store for API responses during test execution.
 * Responses are accumulated and made available to the AI as context for subsequent steps.
 */
export class ApiResponseStore {
  private readonly responses: StoredResponse[] = [];

  add(response: StoredResponse): void {
    this.responses.push(response);
  }

  getAll(): StoredResponse[] {
    return [...this.responses];
  }

  getForStep(stepNumber: number): StoredResponse | undefined {
    return this.responses.find((r) => r.stepNumber === stepNumber);
  }

  hasResponses(): boolean {
    return this.responses.length > 0;
  }

  /**
   * Format all stored responses as a concise context block for the AI system prompt.
   * Response bodies are truncated to keep token usage reasonable.
   */
  formatForContext(): string {
    if (this.responses.length === 0) return '';

    return this.responses
      .map((r) => {
        const statusText = getStatusText(r.status);
        const bodyPreview = formatBodyPreview(r.body, 400);
        const requestPreview = r.requestBody !== undefined
          ? `\nRequest body: ${JSON.stringify(r.requestBody).substring(0, 200)}`
          : '';

        return `Step ${r.stepNumber} (API): ${r.method} ${r.endpoint} → ${r.status} ${statusText}${requestPreview}\nResponse summary: ${bodyPreview}`;
      })
      .join('\n\n');
  }

  clear(): void {
    this.responses.length = 0;
  }
}

function getStatusText(status: number): string {
  const texts: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity',
    500: 'Internal Server Error', 503: 'Service Unavailable',
  };
  return texts[status] ?? '';
}

function formatBodyPreview(body: unknown, maxLength: number): string {
  if (body === null || body === undefined) return '(empty)';
  if (typeof body === 'string') return body.substring(0, maxLength);
  try {
    return JSON.stringify(body).substring(0, maxLength);
  } catch {
    return String(body).substring(0, maxLength);
  }
}
