/**
 * The `GET /health` contract, shared by the server that serves it and the CLI
 * that probes it.
 *
 * Deliberately dependency-free: `aiui status` must be able to answer "is it
 * running?" without dragging in express, the session manager, or (through it)
 * playwright. Importing this from `api-server.ts` would cost a browser stack
 * to print one line.
 */

/**
 * Identity marker in the health body. Clients MUST check it before treating a
 * port as ours — that check is what makes "never spawn on top of a foreign
 * process's port" enforceable (stories/server-lifecycle.md §1, §5.3).
 */
export const HEALTH_SERVICE_ID = 'ai-ui-automation';

export interface HealthResponse {
  ok: true;
  service: typeof HEALTH_SERVICE_ID;
  version: string;
  pid: number;
  startedAt: string;
  openSessions: number;
  runsInFlight: number;
  /** `node:inspector`'s ws URL, or null when the process has no inspector
   *  (started without `--inspect`, or the requested port was taken). */
  inspector: string | null;
  /** null when no idle shutdown is armed. */
  idleTimeoutMinutes: number | null;
}

/**
 * Outcome of a health probe. The three arms are the three things a caller can
 * do about it, which is why "reachable but not recognizably ours" is its own
 * arm rather than folded into `down`: an older aiui server whose Express 404s
 * `/health` is indistinguishable from a foreign process by this probe, and
 * both must NOT be spawned on top of.
 */
export type HealthProbeResult =
  | { kind: 'ok'; health: HealthResponse }
  | { kind: 'down'; detail: string }
  | { kind: 'unrecognized'; detail: string };

/** Strip trailing slashes so callers can append `/health`, `/admin/shutdown`
 *  etc. without doubling the separator. The single owner of that rule. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Probe `<baseUrl>/health`. Never throws.
 *
 * `signal` lets a caller cut a probe short — the MCP server polls this for up
 * to 20 s while waiting for a server it spawned, and an agent host can cancel
 * the tool call underneath it.
 *
 * CALLER BEWARE: an aborted fetch lands in the `catch` below and is reported
 * as `down`, exactly like a connection refusal. That is right for the two CLI
 * callers, which have no signal — but a polling caller MUST check
 * `signal.aborted` before acting on a `down`, or it will report "the server
 * never came up" when the truth is "you cancelled".
 */
export async function probeHealth(
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HealthProbeResult> {
  let res: Response;
  try {
    // `exactOptionalPropertyTypes` is on, so the property is built
    // conditionally rather than passed as a possibly-undefined value.
    const timeout = AbortSignal.timeout(timeoutMs);
    res = await fetch(`${normalizeBaseUrl(baseUrl)}/health`, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (err) {
    // Connection refused, DNS failure, timeout, abort — nothing answered,
    // which for every caller without a signal means "down".
    return { kind: 'down', detail: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    return { kind: 'unrecognized', detail: `HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'unrecognized', detail: 'response was not JSON' };
  }

  if (!isHealthResponse(body)) {
    const service = (body as { service?: unknown } | null)?.service;
    return {
      kind: 'unrecognized',
      detail:
        typeof service === 'string'
          ? `service is "${service}", not "${HEALTH_SERVICE_ID}"`
          : 'response is not an ai-ui-automation health body',
    };
  }

  return { kind: 'ok', health: body };
}

function isHealthResponse(body: unknown): body is HealthResponse {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return b.service === HEALTH_SERVICE_ID && b.ok === true;
}
