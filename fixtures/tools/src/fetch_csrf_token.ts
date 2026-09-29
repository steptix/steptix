import { defineTool } from 'steptix/tools';

/**
 * Calls the test-app's `/api/csrf-token` endpoint via the active browser
 * context's request fixture (so it carries the same cookies as the page).
 *
 * Demonstrates a tool that talks directly to the backend — work the AI loop
 * cannot do, since it only drives the browser UI. The captured token is
 * exposed as the `csrf` output, available as `{{csrf}}` in subsequent steps.
 */
export default defineTool({
  name: 'fetch_csrf_token',
  description: 'Fetch a fresh CSRF token from /api/csrf-token using the active browser context.',
  parameters: {
    baseUrl: {
      type: 'string',
      description: 'origin of the test-app, e.g. http://127.0.0.1:8787',
    },
  },
  outputs: {
    csrf: {
      type: 'string',
      description: 'the CSRF token returned by the API',
    },
  },
  async run({ baseUrl }, { context, step, log }) {
    const url = `${baseUrl.replace(/\/$/, '')}/api/csrf-token`;
    log.info(`GET ${url}`);
    const res = await context.request.get(url);
    if (!res.ok()) {
      throw new Error(`csrf-token request failed: ${res.status()} ${res.statusText()}`);
    }
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0) {
      throw new Error(`unexpected response shape: ${JSON.stringify(body)}`);
    }
    step.setVar('csrf', body.token);
    log.info(`captured token (${body.token.length} chars)`);
  },
});
