/**
 * `decideViewportRecycle` — when an edited `## Config: viewport:` forces
 * Steptix to close the live session before the next run
 * (stories/per-test-viewport.md §5).
 *
 * The decision is tested here rather than through the extension host because
 * the interesting cases are all about VALUES, not about VS Code: the two
 * directions of set↔unset, the normalisation that must NOT restart a browser
 * (whitespace, casing), and the exact log line the story specifies — which is
 * the user's only evidence that the size in effect changed.
 *
 * The controller side of the seam (which runs are eligible at all — never a
 * continuation, a parked skill-step re-run, or a batch run) lives in
 * run-controller.ts and is covered by the integration suite; `sessionLive`
 * here is the one input that carries it.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decideViewportRecycle } from '../src/extension/viewport-recycle.ts';

/** Terser call for the common "there is a live session" case. */
const onLiveSession = (sentViewport, requestedViewport) =>
  decideViewportRecycle({ sessionLive: true, sentViewport, requestedViewport });

// ── The change that motivates the feature ───────────────────────────────────

test('a changed viewport recycles, and the line names both values as authored', () => {
  const decision = onLiveSession('mobile', '768x1024');
  assert.equal(decision.recycle, true);
  assert.equal(
    decision.logLine,
    'viewport changed (mobile → 768x1024) — restarting browser session',
  );
});

test('set → unset and unset → set both recycle, with "(none)" for the absent side', () => {
  // Deleting the key must restore the server's default size, which only a
  // relaunch can do — the live browser is still 390px wide.
  const removed = onLiveSession('mobile', undefined);
  assert.equal(removed.recycle, true);
  assert.equal(
    removed.logLine,
    'viewport changed (mobile → (none)) — restarting browser session',
  );

  // Adding the first `viewport:` line to a test whose session is already up.
  const added = onLiveSession(null, 'mobile');
  assert.equal(added.recycle, true);
  assert.equal(
    added.logLine,
    'viewport changed ((none) → mobile) — restarting browser session',
  );
});

// ── The non-changes: a needless restart loses the session's signed-in state ──

test('an unchanged viewport does not recycle', () => {
  assert.deepEqual(onLiveSession('mobile', 'mobile'), { recycle: false });
  assert.deepEqual(onLiveSession('390x844', '390x844'), { recycle: false });
});

test('a test that never declared a viewport never recycles', () => {
  // The minimum scenario: the sibling test with no `viewport:` key keeps
  // today's session-reuse behaviour byte-for-byte.
  assert.deepEqual(onLiveSession(null, undefined), { recycle: false });
});

test('whitespace and casing are the same viewport — §1 trims and is case-insensitive', () => {
  assert.deepEqual(onLiveSession('mobile', ' Mobile '), { recycle: false });
  assert.deepEqual(onLiveSession('390x844', '390X844'), { recycle: false });
  assert.deepEqual(onLiveSession('  tablet', 'TABLET  '), { recycle: false });
});

test('a blank value reads as unset, not as a viewport called ""', () => {
  // `- viewport:` with nothing after it does not even reach the config map
  // (the item regex needs a value), but an unresolved `$VAR` overlaying to an
  // empty string can — and "" must not read as a change away from no viewport,
  // nor produce `(none) → (none)`.
  assert.deepEqual(onLiveSession(null, '   '), { recycle: false });
  assert.deepEqual(onLiveSession('', undefined), { recycle: false });
});

// ── No session, nothing to recycle ──────────────────────────────────────────

test('with no live session the answer is always no — the next request carries config anyway', () => {
  // Closing here would be a DELETE against a session id the server has never
  // heard of, and the log line would announce a restart that did not happen.
  assert.deepEqual(
    decideViewportRecycle({ sessionLive: false, sentViewport: 'mobile', requestedViewport: 'desktop' }),
    { recycle: false },
  );
  assert.deepEqual(
    decideViewportRecycle({ sessionLive: false, sentViewport: null, requestedViewport: 'mobile' }),
    { recycle: false },
  );
});

// ── Deliberate limits of a dumb client ──────────────────────────────────────

test('a preset and its equivalent dimensions are treated as different (the server owns the resolver)', () => {
  // §3 keeps preset expansion server-side, so the client cannot know these are
  // the same 390×844. A wasted relaunch, never a wrong size — and the line
  // still tells the truth about what the file now says.
  const decision = onLiveSession('mobile', '390x844');
  assert.equal(decision.recycle, true);
  assert.equal(
    decision.logLine,
    'viewport changed (mobile → 390x844) — restarting browser session',
  );
});

test('an unresolved $VAR is compared like any other string', () => {
  // `viewport: $VIEWPORT` with no such key in .env travels literally (that is
  // `resolveValue`'s contract, so the server reports it by name). Two runs
  // with the same unresolved value are still the same session.
  assert.deepEqual(onLiveSession('$VIEWPORT', '$VIEWPORT'), { recycle: false });
  assert.equal(onLiveSession('$VIEWPORT', 'mobile').recycle, true);
});
