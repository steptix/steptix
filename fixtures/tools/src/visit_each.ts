import { defineTool } from 'ai-ui-automation/tools';

/**
 * Visit every URL in `urls` in order, capturing each page's title into the
 * `titles` output as a string[]. Demonstrates the arrays-in-tools pipeline:
 *
 *   1. A `read multiple: true` action upstream populates a list var.
 *   2. The author writes `[tool: visit_each urls={{links}}]`.
 *   3. The bridge JSON-decodes the stored value into a typed string[]
 *      so this tool can iterate naturally.
 *   4. `step.setVar('titles', titles)` JSON-encodes back into the param map
 *      for the next step (or another tool) to consume.
 */
export default defineTool({
  name: 'visit_each',
  description: 'Visit every URL in `urls` and capture its document.title.',
  parameters: {
    urls: { type: 'string[]', description: 'URLs to visit, in order' },
  },
  outputs: {
    titles: { type: 'string[]', description: 'document.title for each URL, index-aligned with `urls`' },
    visited_count: { type: 'number', description: 'how many URLs were visited' },
  },
  async run({ urls }, { page, step, log }) {
    const titles: string[] = [];
    log.info(`visiting ${urls.length} url(s)`);
    for (const url of urls) {
      log.info(`→ ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      titles.push(await page.title());
    }
    step.setVar('titles', titles);
    step.setVar('visited_count', titles.length);
  },
});
