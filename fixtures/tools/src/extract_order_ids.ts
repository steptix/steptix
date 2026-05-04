import { defineTool } from 'ai-ui-automation/tools';

/**
 * Calls the test-app's `/api/orders` endpoint via the browser context's
 * request API (so cookies the AI loop set up earlier go along for free)
 * and emits two outputs back into the test variable scope:
 *
 *   - `order_ids`: a `string[]` of every matching order id
 *   - `order_count`: the size of that list (scalar `number`)
 *
 * Demonstrates "tool returns an array": the `string[]` output is JSON-encoded
 * into `resolvedParameters` and decoded back into a typed `string[]` when a
 * downstream tool declares an `'string[]'` parameter and the author writes
 * `[tool: refund_each ids="{{order_ids}}"]`.
 *
 * The `status` parameter is optional — when set, only orders matching that
 * status are returned. Lets the test exercise both "give me everything" and
 * "give me only the failed ones" paths.
 */
export default defineTool({
  name: 'extract_order_ids',
  description: 'Hit /api/orders and return every matching order id as a string[].',
  parameters: {
    sinceDays: {
      type: 'number',
      default: 30,
      description: 'Window in days; orders older than this are excluded',
    },
    status: {
      type: 'string',
      default: '',
      description: 'Optional status filter (e.g. "paid", "failed", "refunded")',
    },
    baseUrl: {
      type: 'string',
      description: 'Base URL of the test-app (e.g. http://localhost:8787)',
    },
  },
  outputs: {
    order_ids: { type: 'string[]', description: 'IDs of orders in the window' },
    order_count: { type: 'number', description: 'Size of order_ids' },
  },
  async run({ sinceDays, status, baseUrl }, { context, step, log }) {
    const params = new URLSearchParams({ sinceDays: String(sinceDays) });
    if (status) params.set('status', status);
    const url = `${baseUrl.replace(/\/$/, '')}/api/orders?${params.toString()}`;

    log.info(`GET ${url}`);
    const res = await context.request.get(url);
    step.expect(
      res.ok(),
      `GET /api/orders returned ${res.status()} (expected 2xx)`,
    );

    const body = (await res.json()) as Array<{ id: string; status: string }>;
    const ids = body.map((o) => o.id);

    log.info(`extracted ${ids.length} order id(s)${status ? ` (status=${status})` : ''}`);

    step.setVar('order_ids', ids);          // ← string[] OUTPUT
    step.setVar('order_count', ids.length); // ← scalar OUTPUT
  },
});
