/**
 * "Did the test's viewport change since the live session was launched?" —
 * the decision behind Steptix's recycle-on-change (stories/per-test-viewport.md §5).
 *
 * Why a recycle exists at all: per-session `config` is WRITE-ONCE on the wire.
 * The server refuses a batch that carries `config` for a session it already
 * created, so Steptix sends the block once per session and omits it after
 * (`configSentForSession`). For `baseUrl` that is merely a little stale — steps
 * name absolute URLs often enough — but a viewport is the entire point of the
 * test that declares it: edit `mobile` to `768x1024`, press Run, and a
 * silently-reused session would keep rendering at 390px while the log, the
 * report and the file all say otherwise. So the CLIENT closes the session and
 * lets the next request create a fresh one at the new size.
 *
 * Why the decision lives here rather than inline in the run controller: the
 * controller needs `vscode`, so nothing in it can be exercised under
 * `node --test`. This module is import-clean (no `vscode`, no I/O) and holds
 * both halves — whether to recycle and what to say — in one function, so the
 * two can't drift into disagreeing about which values count as a change.
 */

/**
 * The comparison key for one authored viewport spec. `undefined` for "the file
 * declares no viewport", which is a state the comparison must handle in both
 * directions (set → unset restarts the browser back to the server's default;
 * unset → set is the first `viewport:` line someone adds mid-session).
 *
 * Trim + lowercase mirrors §1's authoring rules — the value is trimmed and
 * case-insensitive, so `mobile`, ` Mobile ` and `MOBILE` are one viewport and
 * must NOT restart a browser between runs. Deliberately no preset expansion:
 * the server owns the resolver (§3), so this cannot tell that `mobile` and
 * `390x844` are the same size. Editing one into the other recycles — a wasted
 * relaunch, not a wrong result, and the honest behaviour for a dumb client.
 */
function comparisonKey(spec: string | null | undefined): string | undefined {
  if (spec === null || spec === undefined) return undefined;
  const key = spec.trim().toLowerCase();
  return key === '' ? undefined : key;
}

/** How an absent viewport reads in the log line, per the story's wording. */
const NONE = '(none)';

export type ViewportRecycle =
  | { recycle: false }
  | {
      recycle: true;
      /**
       * Exactly the story's line. Carries the RAW values as authored (not the
       * comparison keys) because the reader is looking for the text they typed
       * in the file, not a normalised echo of it.
       */
      logLine: string;
    };

/**
 * Decide whether a new run must close the live server session before it starts.
 *
 * `sentViewport` is the spec that travelled in the live session's `config`
 * block — `null` when that block carried no `viewport` key, and only meaningful
 * while a live session exists. `requestedViewport` is what the file resolves to
 * NOW (post-`$VAR`), `undefined` when the file declares none.
 *
 * `sessionLive: false` short-circuits to no-recycle: with no session to reuse
 * the next request creates one and carries `config` anyway, so closing would
 * be a no-op DELETE against a session id the server has never heard of.
 */
export function decideViewportRecycle(args: {
  sessionLive: boolean;
  sentViewport: string | null;
  requestedViewport: string | undefined;
}): ViewportRecycle {
  const { sessionLive, sentViewport, requestedViewport } = args;
  if (!sessionLive) return { recycle: false };

  const was = comparisonKey(sentViewport);
  const now = comparisonKey(requestedViewport);
  if (was === now) return { recycle: false };

  const from = sentViewport?.trim() || NONE;
  const to = requestedViewport?.trim() || NONE;
  return {
    recycle: true,
    logLine: `viewport changed (${from} → ${to}) — restarting browser session`,
  };
}
