/**
 * Keeping the panel's per-file state apart (stories/compile-tail-progress.md).
 *
 * The Steptix panel is ONE webview that every run controller posts to, while
 * what it renders is whichever file the editor is showing. Everything that
 * belongs to a file — its Output lines, its compile strip — therefore has to be
 * stored under that file's URI and read back by the active one, or the panel
 * shows whichever test spoke last: test B's panel carrying test A's run log was
 * the pre-existing bug, and two concurrent compiles interleaving their
 * generation lines in one pane was the one this story would have added.
 *
 * Pure and separate from the component so the rules can be tested without a
 * DOM. Every function returns a NEW map (or the same one when nothing changed),
 * so React's identity check does the right thing.
 */

/** Nothing yet for this file. One frozen array, so an empty log does not hand
 *  React a fresh identity on every render. */
export const EMPTY_LOG = Object.freeze([]);

/**
 * Append one entry to `uri`'s log.
 *
 * A null/undefined key means the message belongs to no file we can name — the
 * panel is on a non-test document, say — and is dropped rather than pooled into
 * a shared bucket that would later leak into some file's view.
 *
 * @param {Record<string, Array<object>>} logs
 * @param {string|null|undefined} uri
 * @param {object} entry
 * @returns {Record<string, Array<object>>}
 */
export function appendLogLine(logs, uri, entry) {
  if (uri === null || uri === undefined) return logs;
  return { ...logs, [uri]: [...(logs[uri] ?? EMPTY_LOG), entry] };
}

/**
 * The log the panel renders — the active file's, and only ever the active
 * file's.
 * @param {Record<string, Array<object>>} logs
 * @param {string|null|undefined} uri
 * @returns {Array<object>}
 */
export function logFor(logs, uri) {
  if (uri === null || uri === undefined) return EMPTY_LOG;
  return logs[uri] ?? EMPTY_LOG;
}

/**
 * Clear ONE file's log. Another file's compile may still be running and its
 * lines are still its own.
 * @param {Record<string, Array<object>>} logs
 * @param {string|null|undefined} uri
 * @returns {Record<string, Array<object>>}
 */
export function clearLogFor(logs, uri) {
  if (uri === null || uri === undefined || logs[uri] === undefined) return logs;
  const next = { ...logs };
  delete next[uri];
  return next;
}

/**
 * Set (or, with `state: null`, take down) one file's compile strip.
 * @param {Record<string, object>} strips
 * @param {string|null|undefined} uri
 * @param {object|null} state
 * @returns {Record<string, object>}
 */
export function setStrip(strips, uri, state) {
  if (uri === null || uri === undefined) return strips;
  if (state === null || state === undefined) {
    if (strips[uri] === undefined) return strips;
    const next = { ...strips };
    delete next[uri];
    return next;
  }
  return { ...strips, [uri]: state };
}

/**
 * The strip the panel renders, or null. Never another file's: a panel showing
 * github.md with securebank.md's counts on it reads as the wrong file's state.
 * @param {Record<string, object>} strips
 * @param {string|null|undefined} uri
 * @returns {object|null}
 */
export function stripFor(strips, uri) {
  if (uri === null || uri === undefined) return null;
  return strips[uri] ?? null;
}
