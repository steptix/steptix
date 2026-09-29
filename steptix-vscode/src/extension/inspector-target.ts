/**
 * Where to attach the Node debugger for tool step-into (story
 * server-lifecycle §7).
 *
 * This is a pure decision function, separate from the VS Code call that acts
 * on it, because the integration harness cannot exercise
 * `vscode.debug.startDebugging` — a real attach attempt hangs for ~10 s
 * against a port with no inspector. The decision is the part with the bug
 * history; keeping it pure is what makes it testable at all.
 */

export type InspectorTarget =
  /** Attach here. */
  | { kind: 'attach'; host: string; port: number; source: 'health' | 'settings' }
  /** The server reported it has no inspector — do NOT attach blindly. */
  | { kind: 'none' };

/**
 * Decide the attach target.
 *
 * @param healthInspector  `health.inspector` from the pre-run probe:
 *   - a ws:// URL  ⇒ ground truth from inside the server process; use it.
 *   - `null`       ⇒ the server HAS no inspector. Attaching to the settings
 *                    port here is exactly the wrong-process bug this story
 *                    fixes: another node process holding 9229 would get the
 *                    attach, the ack would release the server, and the user's
 *                    breakpoint would silently never hit.
 *   - `undefined`  ⇒ no health data at all (older server, or the legacy §5.4
 *                    path). Fall back to today's settings behaviour.
 */
export function resolveInspectorTarget(
  healthInspector: string | null | undefined,
  settings: { host: string; port: number },
): InspectorTarget {
  if (healthInspector === null) return { kind: 'none' };

  if (typeof healthInspector === 'string') {
    const parsed = parseInspectorUrl(healthInspector);
    // A ws URL we can't parse is not evidence the server lacks an inspector,
    // so fall through to the settings rather than refusing to attach.
    if (parsed) return { kind: 'attach', ...parsed, source: 'health' };
  }

  return { kind: 'attach', host: settings.host, port: settings.port, source: 'settings' };
}

/**
 * Whether an already-running debug session is the one we want.
 *
 * The type check alone is not enough: a user debugging some unrelated node
 * process would satisfy it, we would skip our own attach, and then ack the
 * server against a debugger pointed somewhere else — the same silent
 * wrong-process failure §7 exists to eliminate, one step removed. Comparing
 * the configured port is what makes "already attached" mean "attached to
 * THIS inspector".
 *
 * Takes the minimal shape rather than a `vscode.DebugSession` so it can be
 * tested without the VS Code API.
 */
export function shouldReuseDebugSession(
  active: { type?: string; configuration?: Record<string, unknown> } | undefined,
  target: { host: string; port: number },
): boolean {
  if (active?.type !== 'pwa-node') return false;
  // `Number(...)`, not `===`: debug configurations round-trip through JSON,
  // so the port can arrive as a string, and a strict compare would re-attach
  // on every tool step.
  if (Number(active.configuration?.['port']) !== target.port) return false;
  // Host as well as port — the same port number on a different address is a
  // different process, and reusing it would ack against the wrong one.
  const address = active.configuration?.['address'];
  return typeof address !== 'string' || address === target.host;
}

/**
 * Parse host + port out of an inspector ws URL, normalizing bind addresses
 * that cannot be dialled.
 *
 * A server launched with `--inspect=0.0.0.0:9229` reports the BIND address,
 * and Windows cannot connect to `0.0.0.0` — the attach fails with a confusing
 * error. Same for `::` (and its bracketed `[::]` form in a URL).
 */
export function parseInspectorUrl(
  url: string,
): { host: string; port: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // This value arrives in the body of an UNAUTHENTICATED /health response,
  // and `service` is a self-declared string, not proof of anything. So the
  // scheme and host are constrained here rather than trusted: tool step-into
  // already requires a loopback SERVER_URL, and a real Node inspector on a
  // local server always reports a local address, so nothing legitimate is
  // lost — while a responder that named `ws://attacker.example/…` would
  // otherwise have VS Code's debug adapter dial out and speak CDP to it.
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;

  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) return null;

  // URL.hostname strips the brackets from [::], leaving '::'.
  const raw = parsed.hostname.toLowerCase();
  const host = raw === '0.0.0.0' || raw === '::' || raw === '[::]' ? '127.0.0.1' : raw;
  if (!LOOPBACK_HOSTS.has(host)) return null;
  return { host, port };
}

/** Hosts an inspector may legitimately live on, post-normalization. Mirrors
 *  `isLoopbackUrl` in server-manager.ts; kept local so this module stays
 *  dependency-free. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Which of the given breakpoint file paths are code-behind files — the
 * signal the run-start debugger auto-attach keys on
 * (stories/codebehind-debugging.md §Flow 1). The caller feeds it the fsPaths
 * of the ENABLED source breakpoints; a match anywhere is enough, because the
 * filename pattern is the user's intent ("I want to debug steps code"), not
 * a claim about which steps this particular run binds — that matching is
 * server-side, and a spurious attach is harmless.
 *
 * Pure and VS Code-free for the same reason the rest of this module is: the
 * integration harness cannot exercise a real attach, so the decision is the
 * part that gets tested.
 */
export function stepsFileBreakpoints(paths: string[]): string[] {
  return paths.filter((p) => /\.steps\.ts$/i.test(p));
}
