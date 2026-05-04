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
  name: 'print_all',
  description: 'Print all items for debug purposes.',
  parameters: {
    items: { type: 'string[]', description: 'Array of string items' },
  },
  outputs: {
    titles: { type: 'string[]', description: 'document.title for each URL, index-aligned with `urls`' },
    visited_count: { type: 'number', description: 'how many URLs were visited' },
  },
  async run({ items }, { page, step, log }) {
    log.info(`Item count ${items.length}`);
    for (const item of items) {
      log.info(`${item}`);
    }
  },
});
