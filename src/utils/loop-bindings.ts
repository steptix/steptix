/**
 * The loop-binding registry: which dotted names in a given variable map a
 * `For each` pass bound there. Imports nothing, so both the masking rules
 * (src/utils/secrets.ts) and the map writers (src/parser/parameters.ts,
 * src/runner/control-runtime.ts) can depend on it without a cycle.
 */

/**
 * Which dotted names in a given variable map a `For each` pass BOUND there.
 *
 * The map is mixed, and nothing about a name says which half it came from.
 * `resolveParameters` (src/parser/parameters.ts) merges every cell of a data
 * file's row into the same map under the row's own heading, so an
 * author-chosen dotted heading — `user.apikey`, `login.passkey` — sits beside
 * a loop's `row.keyword`. §7.6 draws the line by WHOSE names they are, and
 * only a `For each` pass writes page-derived ones, so the pass says so:
 * `applyPassBindings` (src/runner/control-runtime.ts) marks what it bound and
 * `clearDottedKeys` unmarks what it drops.
 *
 * A `WeakMap` keyed on the map object rather than a parameter threaded through
 * every signature: `redactMap`, `secretValues` and `redactReport` already hold
 * the map itself, and the alternative was a new argument on a dozen call
 * sites, most of which have no idea what a loop is.
 *
 * Identity is the whole mechanism, so a COPY of the map carries no marks —
 * see {@link inheritLoopBindings} for the one place that matters.
 */
const loopBindings = new WeakMap<object, Set<string>>();

/** Record that `names` were bound into `map` by a loop pass. Flat names may be
 *  passed too (a pass always binds its base name); nothing consults the
 *  registry for one, so they are simply remembered. */
export function markLoopBindings(map: object, names: Iterable<string>): void {
  let marked = loopBindings.get(map);
  if (!marked) {
    marked = new Set<string>();
    loopBindings.set(map, marked);
  }
  for (const name of names) marked.add(name);
}

/** Forget `names` — called with exactly the keys a rebind deletes, so the mark
 *  and the entry go together. A later entry of the same name is then nobody's
 *  binding, which is what a `Set {{order}} to "none"` after a loop leaves. */
export function unmarkLoopBindings(map: object, names: Iterable<string>): void {
  const marked = loopBindings.get(map);
  if (!marked) return;
  for (const name of names) marked.delete(name);
  if (marked.size === 0) loopBindings.delete(map);
}

/** Did a loop pass bind this name into this map? */
export function isLoopBinding(map: object, name: string): boolean {
  const marked = loopBindings.get(map);
  return marked !== undefined && marked.has(name);
}

/**
 * Carry `from`'s marks onto `to` — for a map that is a COPY of the live one.
 *
 * The registry is by object identity, so `{ ...resolvedParameters, ...frameInputs }`
 * (src/server/session-manager.ts) arrives here unmarked and every dotted
 * binding in it would fall back to the author rule, masking `AU` because a
 * column is called `keyword`. One line at the copy restores the answer.
 */
export function inheritLoopBindings(from: object, to: object): void {
  const marked = loopBindings.get(from);
  if (marked && marked.size > 0) markLoopBindings(to, marked);
}
