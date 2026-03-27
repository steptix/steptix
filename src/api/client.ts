import type { Page } from 'playwright';
import type { ApiCallResult } from './types.js';
import { logger } from '../utils/logger.js';

export interface ApiCallOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Standalone HTTP client using Node's built-in fetch.
 * Used for Private, Serverless, and Public APIs that do not need browser session cookies.
 */
export async function callApiStandalone(opts: ApiCallOptions): Promise<ApiCallResult> {
  const startTime = Date.now();

  const headers: Record<string, string> = { ...opts.headers };

  const fetchOpts: RequestInit = {
    method: opts.method,
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  };

  if (opts.body !== undefined && opts.method !== 'GET' && opts.method !== 'HEAD') {
    fetchOpts.body = JSON.stringify(opts.body);
    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json';
    }
  }

  logger.debug(`API standalone: ${opts.method} ${opts.url}`);

  const response = await fetch(opts.url, fetchOpts);
  const durationMs = Date.now() - startTime;

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const body = await parseResponseBody(response);

  return { status: response.status, headers: responseHeaders, body, durationMs };
}

/**
 * HTTP client using Playwright's APIRequestContext from the browser context.
 * Automatically carries all cookies from the current browser session.
 * Used for Front Proxy and Experience APIs.
 */
export async function callApiBrowserContext(
  page: Page,
  opts: ApiCallOptions,
): Promise<ApiCallResult> {
  const startTime = Date.now();

  const headers: Record<string, string> = { ...opts.headers };

  if (opts.body !== undefined && opts.method !== 'GET' && opts.method !== 'HEAD') {
    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json';
    }
  }

  logger.debug(`API browser-context: ${opts.method} ${opts.url}`);

  const requestContext = page.context().request;

  const fetchOpts: Parameters<typeof requestContext.fetch>[1] = {
    method: opts.method,
    headers,
    timeout: opts.timeoutMs ?? 30_000,
  };

  if (opts.body !== undefined && opts.method !== 'GET' && opts.method !== 'HEAD') {
    fetchOpts.data = JSON.stringify(opts.body);
  }

  const response = await requestContext.fetch(opts.url, fetchOpts);
  const durationMs = Date.now() - startTime;

  const headersArray = await response.headersArray();
  const responseHeaders: Record<string, string> = Object.fromEntries(
    headersArray.map((h) => [h.name.toLowerCase(), h.value]),
  );

  let body: unknown;
  const contentType = responseHeaders['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    body = await response.json() as unknown;
  } else {
    body = await response.text();
  }

  return { status: response.status(), headers: responseHeaders, body, durationMs };
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json() as Promise<unknown>;
  }
  return response.text();
}
