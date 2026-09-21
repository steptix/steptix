/**
 * Review 6, finding 4: the MCP result's `captures{}`.
 *
 * Every other string a folded run carries is text the SERVER masked on its
 * way out. A `capture` event is the exception, and deliberately so: it exists
 * so TestBench's Variables panel can hold the real value and reveal it on
 * request, so the server sends it raw and each client decides what to show.
 * The MCP client made no such decision — `foldRun`'s `captures{}` went into
 * `run_test_file`, `run_steps` and `run_errand`'s results verbatim
 * (src/mcp/tools.ts), so a `[store as: password]` reached the agent, and its
 * transcript, in clear.
 *
 * Three rules apply here, the §7.6 order: the author's own NAME, the value's
 * record SHAPE, then the free text.
 */
import { describe, it, expect } from 'vitest';
import { foldRun, type FoldInput } from '../src/mcp/run-fold.js';
import type { RunEvent } from '../src/mcp/types.js';
import { MASK } from '../src/utils/secrets.js';

const TEST_FILE = 'c:/proj/tests/payments.md';

function fold(events: RunEvent[]) {
  return foldRun({
    events,
    streamDropped: false,
    sentSteps: ['step one'],
    sourceLines: [10],
    testFilePath: TEST_FILE,
    expansionPossible: false,
    screenshotsReturn: 'none',
  } satisfies FoldInput);
}

/** One passing step plus the captures it made. */
function run(...captures: Array<[string, string]>) {
  const events: RunEvent[] = [{ type: 'step:start', line: 10 }];
  for (const [name, value] of captures) {
    events.push({ type: 'capture', line: 10, name, value, source: 'capture' });
  }
  events.push({ type: 'step:pass', line: 10 }, { type: 'done', status: 'passed' });
  return fold(events).captures;
}

describe('foldRun — captures reach the agent masked', () => {
  it('masks a capture whose author-chosen name says secret', () => {
    expect(run(['password', 'hunter2!x'])).toEqual({ password: MASK });
  });

  it('says (empty) rather than *** for a secret-named capture with no value', () => {
    // Nothing is disclosed by saying a field was blank, and the two cases are
    // the ones an agent most needs told apart.
    expect(run(['password', ''])).toEqual({ password: '(empty)' });
  });

  it('masks a secret COLUMN of a record capture, under a name that says nothing', () => {
    // `[store as: payments]` on a `readTable`: one table under a name nothing
    // can judge, and a three-character cell is below the free-text floor, so
    // only the record rule reaches it.
    expect(run(['payments', '[{"payee":"Acme","password":"abc"}]'])).toEqual({
      payments: `[{"payee":"Acme","password":"${MASK}"}]`,
    });
  });

  it('masks a secret-named capture where a LATER capture spells it out', () => {
    // The reason this runs over the whole map at the end rather than per
    // event: at the moment `receipt` arrives, `token` is already known.
    expect(
      run(['token', 'tok-abcdef'], ['receipt', 'paid with tok-abcdef, thanks']),
    ).toEqual({ token: MASK, receipt: `paid with ${MASK}, thanks` });
  });

  it('reads a DOTTED capture name whole, as the author’s own', () => {
    // Nothing in this map is a loop's pass binding — the server emits one
    // `capture` per NAMED capture, not one per property — so a dotted name
    // here was typed by a person and `user.apikey` is masked whole.
    expect(run(['user.apikey', 'uk_live_1234'])).toEqual({ 'user.apikey': MASK });
  });

  it('leaves an ordinary capture exactly as it arrived', () => {
    // The other half of the bargain: `captures{}` is what an agent reads the
    // run's result out of, and over-masking it would be the more expensive
    // mistake.
    expect(run(['orderId', 'ORD-1001'], ['total', '37.76'])).toEqual({
      orderId: 'ORD-1001',
      total: '37.76',
    });
  });

  it('masks after the truncation cap, not before', () => {
    // The cap is about the size of a page-controlled value; masking is about
    // its content. A capture over the cap still gets the name rule.
    const long = 'x'.repeat(5_000);
    expect(run(['api_token', long])).toEqual({ api_token: MASK });
  });
});
