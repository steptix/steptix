// Rung 2 — `tool()` helper. Filename becomes the tool name (`check_health`).
// Returned boolean is captured as the single output `{{check_health}}`.
import { tool } from 'steptix/tools';

export default tool(async ({ baseUrl, context }) => {
  const res = await context.request.get(`${baseUrl}/api/csrf-token`);
  return res.ok();
});
