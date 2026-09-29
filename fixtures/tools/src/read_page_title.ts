import { defineTool } from 'steptix/tools';

/**
 * Reads `document.title` from the current page and stores it as `page_title`.
 * Trivial — this exists to demonstrate that a tool can drive `page` directly,
 * including running JS in the page via `page.evaluate`.
 */
export default defineTool({
  name: 'read_page_title',
  description: 'Capture the current page title into the variable scope.',
  parameters: {},
  outputs: {
    page_title: { type: 'string', description: 'value of document.title' },
  },
  async run(_args, { page, step, log }) {
    const title = await page.title();
    log.info(`page title: ${title}`);
    step.setVar('page_title', title);
  },
});
