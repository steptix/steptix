/**
 * The MCP side of "this session has no browser yet" —
 * SPEC-use-computer.md §4.6.
 *
 * Two things, and the first is the one that rots silently: the MCP process
 * recognises the server's 409 by MATCHING ITS SENTENCE, because it does not
 * import `manager.ts` (that module loads Playwright, and an MCP process has no
 * business doing that to recognise a string). A copied constant with no test
 * between the two is a contract that breaks the first time either side is
 * reworded, and breaks by degrading to the generic error — no failure, just a
 * worse answer.
 */
import { describe, it, expect } from 'vitest';
import { NO_BROWSER_LAUNCHED_MESSAGE } from '../src/browser/manager.js';
import { NO_BROWSER_LAUNCHED_WIRE_MESSAGE, pageContentNoBrowserYet } from '../src/mcp/errors.js';

describe('the wire copy of the no-browser sentence', () => {
  it('is the sentence the tracker actually throws', () => {
    expect(NO_BROWSER_LAUNCHED_WIRE_MESSAGE).toBe(NO_BROWSER_LAUNCHED_MESSAGE);
  });
});

describe('pageContentNoBrowserYet', () => {
  /** The one text block an `isError` result carries. */
  const err = { message: pageContentNoBrowserYet('s-1').content[0]!.text };

  it('names the session and says the session itself is fine', () => {
    expect(err.message).toContain('"s-1"');
    expect(err.message).toContain('has not opened a browser yet');
  });

  // The wrong lesson for an agent to take is "this session is gone" — it would
  // create another one and lose whatever the first had done.
  it('does not tell the agent the session is missing', () => {
    expect(err.message).not.toMatch(/no session named/i);
    expect(err.message).not.toMatch(/does not exist/i);
  });

  it('names the thing that produces a page, and the tab alternative', () => {
    expect(err.message).toContain('run_steps');
    expect(err.message).toContain('peek_tab');
    expect(err.message).toContain('[use browser]');
  });

  // That `get_page_content` actually ROUTES a 409 carrying the sentence to this
  // message — and a navigation-lost 409 away from it — is driven through the
  // tool in mcp-seam.test.ts ("answers the no-browser-yet 409 …").
});
