import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  openSync,
  closeSync,
  readdirSync,
  readSync,
  statSync,
  truncateSync,
  mkdirSync,
} from 'node:fs';
import * as path from 'node:path';
import { describeFetchError, userRootDir } from 'steptix-runner-core';

/**
 * Server lifecycle helpers for the extension: the `/health` identity probe and
 * the detached auto-start spawn. Kept out of `run-controller.ts` so the run
 * path reads as a decision tree over a couple of injected functions rather
 * than a mix of policy and process management.
 *
 * See stories/server-lifecycle.md §5.
 */

/** Must match the server's `HEALTH_SERVICE_ID` (src/server/health.ts). Nothing
 *  links the two copies — the extension bundles separately from the framework
 *  — so change both together. */
export const HEALTH_SERVICE_ID = 'steptix';

/** The subset of `GET /health` the extension actually uses. Fields it doesn't
 *  read are deliberately absent rather than optional-typed. */
export interface ServerHealth {
  service: string;
  version?: string;
  /** Short commit the server's `dist/` was built from; null when unknown,
   *  absent on a server predating it. */
  commit?: string | null;
  /** Whether that build held uncommitted changes; null when unknown. */
  modified?: boolean | null;
  pid?: number;
  openSessions?: number;
  runsInFlight?: number;
  /** ws:// inspector URL, or null when the process has no inspector. Absent
   *  entirely on a server predating this story — which is NOT the same as
   *  null, and §7 treats them differently. */
  inspector?: string | null;
  idleTimeoutMinutes?: number | null;
}

/**
 * Outcome of a health probe. Three arms because there are exactly three things
 * the run path can do about it (§5.2–5.5):
 *
 *  - `healthy`  — it's our server; proceed, and use its `inspector`.
 *  - `foreign`  — it answered, said it's a service, and that service isn't
 *                 ours. Refuse the run (STX027); never spawn on top of it.
 *  - `unknown`  — reachable but unidentifiable: non-2xx (an older Steptix server
 *                 whose Express 404s /health looks exactly like this), or a
 *                 body that isn't JSON, or JSON with no `service` field.
 *                 Proceed on the legacy path. Never spawn, never refuse.
 *  - `down`     — nothing listening. Spawn, if configured and local.
 */
export type HealthProbeResult =
  | { kind: 'healthy'; health: ServerHealth }
  | { kind: 'foreign'; service: string }
  | { kind: 'unknown'; detail: string }
  | { kind: 'down'; detail: string };

export type HealthProbe = (
  serverUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<HealthProbeResult>;

/** Strip trailing slashes so `${base}/health` (or `/admin/shutdown`) never
 *  doubles the separator. One owner for the rule. */
export function normalizeBaseUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

/**
 * True for a URL whose host is loopback — the only case auto-start fires for.
 * A remote SERVER_URL is somebody else's machine; starting a server here would
 * produce one that nothing is going to talk to.
 *
 * Lives here rather than in run-controller.ts so it is (a) reachable by the
 * `node --test` suite, which cannot import anything pulling in `vscode`, and
 * (b) shared with the manual Start Server command, which otherwise had no such
 * check and would happily spawn a local server for a remote URL.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // `new URL('http://[::1]:3100').hostname` keeps the brackets, so both
    // spellings must be accepted or an IPv6 loopback reads as remote.
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Combine a caller's signal with a timeout.
 *
 * Hand-rolled rather than `AbortSignal.any`, which needs Node 20.3+: this
 * extension declares `engines.vscode: ^1.85.0`, and VS Code 1.85 shipped
 * Electron 25 / Node 18. A `TypeError: AbortSignal.any is not a function`
 * inside the pre-run probe would fail every run on those hosts.
 */
function withTimeout(
  timeoutMs: number,
  signal?: AbortSignal,
): { signal: AbortSignal; release: () => void } {
  if (signal?.aborted) return { signal, release: () => {} };
  if (!signal) {
    // Same reason as the combined branch below, rather than
    // `AbortSignal.timeout`'s "The operation was aborted due to timeout"
    // — one wording for a timed-out probe wherever it was issued from.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutReason(timeoutMs)), timeoutMs);
    return { signal: controller.signal, release: () => clearTimeout(timer) };
  }

  const controller = new AbortController();
  // Each abort carries its reason, which is what `fetch` rejects with: the
  // probe's log line then says "timed out" or repeats the caller's reason
  // instead of the generic "This operation was aborted" for both.
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutReason(timeoutMs)), timeoutMs);
  // `release` must be called on EVERY exit, not just on abort. A spawn poll
  // issues ~80 probes against one long-lived run signal; if a successful
  // fetch left its timer and listener behind, they would all pile up on that
  // signal (and each timer would hold an event-loop ref) for the whole wait.
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    },
  };
}

/** What a probe's fetch rejects with when the server did not answer in time. */
function timeoutReason(timeoutMs: number): Error {
  return new Error(`no answer within ${timeoutMs} ms`);
}

/** The real probe. Never throws — every failure maps onto an arm above. */
export const defaultHealthProbe: HealthProbe = async (serverUrl, timeoutMs, signal) => {
  const attempt = withTimeout(timeoutMs, signal);
  try {
    let res: Response;
    try {
      res = await fetch(`${normalizeBaseUrl(serverUrl)}/health`, {
      signal: attempt.signal,
      // A probe of a loopback URL must be answered by that loopback process.
      // Following redirects would let it be handed off to an arbitrary host,
      // whose reply then decides `inspector` and the spawn/refuse branch.
      redirect: 'error',
    });
    } catch (err) {
      // An abort from the RUN's signal is a user Stop, not a down server — the
      // caller distinguishes by checking its own signal, but pass the reason
      // through so the log says which it was. `describeFetchError` unwraps
      // the cause Node hides behind "fetch failed" (refused / unresolvable /
      // bad certificate), which is the part a reader can act on.
      return { kind: 'down', detail: describeFetchError(err) };
    }

    if (!res.ok) return { kind: 'unknown', detail: `HTTP ${res.status}` };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: 'unknown', detail: 'response was not JSON' };
    }

    const service = (body as { service?: unknown } | null)?.service;
    if (typeof service !== 'string') {
      return { kind: 'unknown', detail: 'health body carries no "service" field' };
    }
    if (service !== HEALTH_SERVICE_ID) return { kind: 'foreign', service };

    return { kind: 'healthy', health: body as ServerHealth };
  } finally {
    attempt.release();
  }
};

// ---------------------------------------------------------------------------
// Auto-start
// ---------------------------------------------------------------------------

export interface SpawnServerArgs {
  command: string;
  cwd: string;
  /** Absolute path of the append-only log the child's stdout/stderr go to. */
  logPath: string;
}

export type ServerSpawner = (args: SpawnServerArgs) => void;

/** Truncate the log once it passes this, at open time. One rolling file. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Spawn the server detached so it outlives this VS Code window (a locked
 * requirement — the server is meant to survive the editor closing).
 *
 * We never kill this child: stopping goes through HTTP. That matters on
 * Windows, where `shell: true` means the detached child is the shell and
 * kill/unref semantics differ from POSIX.
 */
export const defaultServerSpawner: ServerSpawner = ({ command, cwd, logPath }) => {
  const logFd = openLogFile(logPath);
  try {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });

    // Node reports spawn failures ASYNCHRONOUSLY on the child's 'error'
    // event — a `cwd` that no longer exists is the everyday case, since
    // people move their checkouts. With no listener, EventEmitter rethrows it
    // as an uncaught exception in the extension host, and the surrounding
    // try/catch (synchronous) never sees it. Worse, the child writes nothing,
    // so STX028 arrives after the full timeout with no log tail — throwing
    // away the one explanation Node handed us. Append it to the log the
    // diagnostic already quotes.
    child.on('error', (err) => {
      try {
        appendFileSync(logPath, `\n[steptix] failed to start "${command}" in "${cwd}": ${err.message}\n`);
      } catch {
        // The log is best-effort; never let logging a failure become one.
      }
    });

    // Don't let the child keep the extension host's event loop alive.
    child.unref();
  } finally {
    // The child holds its own dup of the descriptor; ours is done.
    closeSync(logFd);
  }
};

/**
 * The server's version as a person reads it: `1.0.0-beta.1 (b700473)`, with
 * `, modified` after the commit for a build with uncommitted changes, and the
 * version alone when the commit is unknown. Mirrors `describeVersion` in the
 * framework's src/utils/version.ts, which this bundle cannot import.
 */
export function describeServerVersion(h: ServerHealth): string | undefined {
  if (!h.version) return undefined;
  return h.commit ? `${h.version} (${h.commit}${h.modified ? ', modified' : ''})` : h.version;
}

/**
 * One-line summary of a probe result, plus the detail line beneath it.
 *
 * Shared by the status-bar tooltip and the Server Status toast: they were two
 * switches over the same four-arm union producing near-identical prose, and a
 * fifth arm would have had to be added to both (neither returns a value, so
 * the compiler would not have caught the miss).
 */
export function describeHealth(
  serverUrl: string,
  result: HealthProbeResult,
): { headline: string; detail: string; warn: boolean } {
  switch (result.kind) {
    case 'healthy': {
      const h = result.health;
      const version = describeServerVersion(h);
      return {
        headline: `Steptix server on ${serverUrl}${version ? ` — v${version}` : ''}`,
        detail:
          `pid ${h.pid ?? '?'} · ${h.openSessions ?? '?'} session(s) open · ` +
          `${h.runsInFlight ?? '?'} run(s) in flight\n` +
          `inspector: ${h.inspector ?? 'none'}\n` +
          `idle timeout: ${h.idleTimeoutMinutes == null ? 'off' : `${h.idleTimeoutMinutes}m`}`,
        warn: false,
      };
    }
    case 'down':
      return {
        headline: `No Steptix server on ${serverUrl}`,
        detail: result.detail,
        warn: false,
      };
    case 'foreign':
      return {
        headline: `${serverUrl} is served by "${result.service}", not steptix`,
        detail: 'Runs against it will be refused — Steptix never starts a server on top of one it does not recognise.',
        warn: true,
      };
    case 'unknown':
      return {
        // Must NOT imply the port is foreign: per §5.4 an older Steptix server
        // without /health is indistinguishable from one by this probe, and
        // runs against it still work on the legacy path.
        headline: `Unrecognized response on ${serverUrl} (${result.detail})`,
        detail: 'May be an older Steptix server without /health; runs will still be attempted.',
        warn: true,
      };
  }
}

/** Open the rolling server log for append, truncating it when oversized. */
function openLogFile(logPath: string): number {
  mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    if (statSync(logPath).size > LOG_MAX_BYTES) truncateSync(logPath, 0);
  } catch {
    // No file yet — nothing to truncate.
  }
  return openSync(logPath, 'a');
}

// ---------------------------------------------------------------------------
// Spawn + wait-until-healthy
// ---------------------------------------------------------------------------

/** What to start and where: the command setting, or the installed runtime. */
export interface AutoStartConfig {
  command: string;
  cwd: string;
  readyTimeoutSeconds: number;
}

/** The §5 settings table, already read and trimmed. */
export interface AutoStartSettings extends AutoStartConfig {
  /** Start the installed runtime when `command` is empty. */
  useInstalledRuntime: boolean;
}

/** Default ready-timeout when the setting is absent or nonsense. */
const DEFAULT_READY_TIMEOUT_SECONDS = 20;

/**
 * Read the §5 settings.
 *
 * All four are declared `"scope": "machine"` in `contributes.configuration`,
 * so `getConfiguration` can only ever return a USER value for them — a
 * workspace's `.vscode/settings.json` is ignored by VS Code itself. That is a
 * security property, not a convenience: this extension executes `command`
 * verbatim, so a workspace-settable value would let any cloned repo run
 * arbitrary code the moment the user pressed Run.
 */
export function readAutoStartSettings(
  cfg: { get<T>(key: string, fallback: T): T; get<T>(key: string): T | undefined },
): AutoStartSettings {
  const seconds = cfg.get<number>(
    'serverAutoStart.readyTimeoutSeconds',
    DEFAULT_READY_TIMEOUT_SECONDS,
  );
  return {
    command: (cfg.get<string>('serverAutoStart.command') ?? '').trim(),
    cwd: (cfg.get<string>('serverAutoStart.cwd') ?? '').trim(),
    readyTimeoutSeconds:
      Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_READY_TIMEOUT_SECONDS,
    useInstalledRuntime: cfg.get<boolean>('serverAutoStart.useInstalledRuntime', true) !== false,
  };
}

// ---------------------------------------------------------------------------
// The installed runtime (packaging/runtime)
// ---------------------------------------------------------------------------

/** A Steptix runtime the installer put under the user root. */
export interface InstalledRuntime {
  version: string;
  /** Its folder: `<user root>/runtimes/<version>`. */
  dir: string;
}

export interface RuntimeSearch {
  /** Where installed runtimes live — named when there is none. */
  runtimesDir: string;
  /** The newest startable one there, or null. */
  runtime: InstalledRuntime | null;
}

export type RuntimeDiscovery = () => RuntimeSearch;

/**
 * The files a runtime folder must hold to be started. A folder missing one is
 * not a runtime to pick: an uninstall that could not finish — a running server
 * holds files open — leaves one behind.
 */
function runtimeLaunchFiles(platform: NodeJS.Platform): string[] {
  return [
    'runtime-launcher.cjs',
    path.join('server', 'dist', 'index.js'),
    // What the Windows installer ships for finding Node; elsewhere the
    // launcher is run by `node` directly (runtimeServeCommand).
    ...(platform === 'win32' ? ['steptix.cmd'] : []),
  ];
}

/**
 * The newest startable runtime in `runtimesDir`, or null.
 *
 * Newest rather than any: the installer puts each version in a folder of its
 * own and leaves the others, so after an upgrade both are there, and the one
 * just installed is the one meant.
 */
export function findInstalledRuntime(
  runtimesDir: string,
  platform: NodeJS.Platform = process.platform,
): InstalledRuntime | null {
  let names: string[];
  try {
    names = readdirSync(runtimesDir);
  } catch {
    return null;
  }
  const files = runtimeLaunchFiles(platform);
  const newest = names
    .filter((name) => files.every((file) => existsSync(path.join(runtimesDir, name, file))))
    .sort(compareVersions)
    .at(-1);
  return newest === undefined ? null : { version: newest, dir: path.join(runtimesDir, newest) };
}

/**
 * Where the installer puts runtimes: `<user root>/runtimes`, beside the
 * machine key. A location the user's own installer wrote, outside every
 * workspace — which is what makes it safe to start without a setting: no repo
 * the user merely opened can put a runtime there.
 */
export const defaultRuntimeDiscovery: RuntimeDiscovery = () => {
  const runtimesDir = path.join(userRootDir(), 'runtimes');
  return { runtimesDir, runtime: findInstalledRuntime(runtimesDir) };
};

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Semver precedence: a prerelease sorts below its release, and prerelease
 * identifiers compare numerically when both are numbers. A folder name that is
 * not a version sorts below every one that is.
 */
export function compareVersions(a: string, b: string): number {
  const va = VERSION_PATTERN.exec(a);
  const vb = VERSION_PATTERN.exec(b);
  if (!va || !vb) {
    if (va || vb) return va ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(va[i]) - Number(vb[i]);
    if (diff !== 0) return diff;
  }
  const pa = va[4]?.split('.') ?? [];
  const pb = vb[4]?.split('.') ?? [];
  // A release outranks every prerelease of itself.
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

/** How long a server Steptix started waits, with no work, before it stops
 *  itself — the value the setting descriptions suggest. */
const AUTO_START_IDLE_TIMEOUT_MINUTES = 60;

/**
 * The command that starts `runtime`'s server on `serverUrl`'s port.
 *
 * `--port` because the URL is what the run is about to dial and the server's
 * own default (3100) need not be it — a `SERVER_URL` naming another port
 * would otherwise start a server where nobody is looking and time out.
 *
 * On Windows through `steptix.cmd`, which is how the installer means the
 * runtime to be run and where its "Node from STEPTIX_NODE, else PATH" rule
 * lives. Elsewhere there is no such script, so the same rule is applied here
 * and the launcher run by Node directly. The launcher adds the localhost
 * inspector for `serve` either way.
 */
export function runtimeServeCommand(
  runtime: InstalledRuntime,
  serverUrl: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const url = new URL(serverUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const args = `serve --port ${port} --idle-timeout ${AUTO_START_IDLE_TIMEOUT_MINUTES}`;
  if (platform === 'win32') return `"${path.join(runtime.dir, 'steptix.cmd')}" ${args}`;
  const node = (opts.env ?? process.env)['STEPTIX_NODE']?.trim() || 'node';
  return `${shellQuote(node)} ${shellQuote(path.join(runtime.dir, 'runtime-launcher.cjs'))} ${args}`;
}

/** One POSIX `sh` word, whatever it holds. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Why a start attempt ended. Shared by the run path (which maps these onto
 * STX027/STX028 payloads) and the Start Server command (which maps them onto
 * toasts), so the spawn/poll policy itself exists once.
 */
export type StartServerResult =
  | { kind: 'ready'; health: ServerHealth }
  | { kind: 'aborted' }
  /** Never spawned — a precondition failed. */
  | { kind: 'refused'; reason: string }
  /** Something else took the port while we were starting. */
  | { kind: 'foreign'; service: string }
  | { kind: 'timeout'; seconds: number; logPath: string; logTail?: string };

/**
 * What to do about a server, given how it answered (§5.2–5.6).
 *
 * The decision lives here, not in either caller, because there are two: the
 * pre-run check and the manual Start Server command. When each made its own
 * triage they drifted immediately — the command path lost the "only auto-start
 * a LOCALHOST url" rule and would spawn a local server for a remote
 * SERVER_URL. Each caller now maps this union onto its own vocabulary
 * (STX027/STX028 for a run, toasts for a command), which is the only part that
 * legitimately differs.
 */
export type ServerAction =
  /** It's ours. Use `health.inspector` for tool step-into. */
  | { kind: 'proceed'; health: ServerHealth }
  /** Someone else's service. Refuse; never spawn on top of it. */
  | { kind: 'refuse-foreign'; service: string }
  /** Reachable but unidentifiable — indistinguishable from a Steptix server
   *  predating /health. Proceed with no health data; never spawn, never
   *  refuse. */
  | { kind: 'legacy'; detail: string }
  /** Nothing listening, and we are allowed to start one. `runtime` is set
   *  when `config` was made for the installed runtime rather than read from
   *  the command setting. */
  | { kind: 'spawn'; config: AutoStartConfig; runtime?: InstalledRuntime }
  /** Nothing listening and we must not start one. `reason` explains which
   *  precondition failed, for the log/toast. */
  | { kind: 'skip'; reason: string };

/**
 * `settings.command` wins whenever it is set: a user who wrote one (a
 * framework checkout, a pinned runtime) meant it. Only an empty one falls to
 * the installed runtime, and `discover` is called only then — a healthy
 * server costs no directory scan.
 */
export function decideServerAction(
  serverUrl: string,
  probe: HealthProbeResult,
  settings: AutoStartSettings,
  discover: RuntimeDiscovery = defaultRuntimeDiscovery,
): ServerAction {
  switch (probe.kind) {
    case 'healthy':
      return { kind: 'proceed', health: probe.health };
    case 'foreign':
      return { kind: 'refuse-foreign', service: probe.service };
    case 'unknown':
      return { kind: 'legacy', detail: probe.detail };
    case 'down': {
      if (!isLoopbackUrl(serverUrl)) {
        return { kind: 'skip', reason: `${serverUrl} is not a localhost URL` };
      }
      const { readyTimeoutSeconds } = settings;
      if (settings.command) {
        return { kind: 'spawn', config: { command: settings.command, cwd: settings.cwd, readyTimeoutSeconds } };
      }
      if (!settings.useInstalledRuntime) {
        return {
          kind: 'skip',
          reason:
            '"steptix.serverAutoStart.command" is not set and ' +
            '"steptix.serverAutoStart.useInstalledRuntime" is off',
        };
      }
      const { runtimesDir, runtime } = discover();
      if (!runtime) {
        return {
          kind: 'skip',
          reason:
            '"steptix.serverAutoStart.command" is not set and no Steptix runtime ' +
            `is installed in ${runtimesDir}`,
        };
      }
      return {
        kind: 'spawn',
        config: { command: runtimeServeCommand(runtime, serverUrl), cwd: runtime.dir, readyTimeoutSeconds },
        runtime,
      };
    }
  }
}

/** How long a failed auto-start suppresses further attempts. See
 *  {@link AutoStartGuard}. Long enough to cover a Test Explorer batch, short
 *  enough that fixing the build and re-running works without a reload. */
const AUTO_START_BACKOFF_MS = 60_000;

/**
 * Remembers that starting a server just failed, so the next run doesn't try
 * again immediately.
 *
 * Without this, a broken `serverAutoStart.command` (a `dist/` that isn't
 * built, say) turns a 40-test Test Explorer batch into 40 detached shell
 * spawns and 40 × readyTimeoutSeconds of stalling before reporting 40
 * identical STX028s — each test re-runs the whole pre-run phase, and nothing
 * connects one failure to the next.
 *
 * Keyed by server URL, and cleared on a success, so fixing the problem and
 * re-running works immediately rather than waiting out the backoff.
 */
export class AutoStartGuard {
  private readonly failures = new Map<string, number>();
  private readonly now: () => number;

  // Explicit assignment rather than a `private readonly` parameter property:
  // this module is imported directly by the `node --test` suite, and Node's
  // strip-only type stripping rejects parameter properties outright
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), which fails the whole file to load.
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** True when a start for this URL failed recently enough to skip retrying. */
  isSuppressed(serverUrl: string): boolean {
    const at = this.failures.get(serverUrl);
    if (at === undefined) return false;
    if (this.now() - at < AUTO_START_BACKOFF_MS) return true;
    this.failures.delete(serverUrl);
    return false;
  }

  recordFailure(serverUrl: string): void {
    this.failures.set(serverUrl, this.now());
  }

  /** Forget a URL — a successful start, or a deliberate manual retry. */
  clear(serverUrl: string): void {
    this.failures.delete(serverUrl);
  }

  /** Forget everything. Used when the test harness swaps the server
   *  collaborators, which means the next case starts from scratch. */
  clearAll(): void {
    this.failures.clear();
  }
}

/** Poll cadence while waiting for a freshly-spawned server. */
const HEALTH_POLL_INTERVAL_MS = 250;
/** Per-probe budget. A local server answers in single-digit ms. */
export const HEALTH_PROBE_TIMEOUT_MS = 1_000;

/**
 * Spawn the configured command, then poll `/health` until it identifies as
 * ours or the budget runs out.
 *
 * A dead child is detected by the poll timing out rather than by watching for
 * an `exit` event: the child is a detached shell on Windows, where exit
 * semantics differ — and more importantly, "our child died" and "the run can
 * proceed" are not mutually exclusive. In the two-window race (§5.7) the
 * loser's child dies on EADDRINUSE while the winner's server answers the
 * loser's poll, so poll-until-healthy makes the race self-resolving and no
 * locking is needed.
 */
export async function startServerAndWait(args: {
  serverUrl: string;
  config: AutoStartConfig;
  /** `<globalStorage>/server.log`, or undefined when the caller has no
   *  storage — in which case we refuse rather than discard the child's
   *  output, since that output is the only diagnosis a failure leaves. */
  logPath: string | undefined;
  probe: HealthProbe;
  spawn: ServerSpawner;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Injectable clock. Without it the timeout branch is only reachable by
   *  actually waiting, so a test either burns the budget in wall-clock or
   *  busy-spins the probe thousands of times inside a tiny one. */
  now?: () => number;
}): Promise<StartServerResult> {
  const { serverUrl, config, logPath, probe, spawn, sleep, signal, log } = args;
  const now = args.now ?? Date.now;

  // A blank cwd is refused rather than defaulted to the workspace folder.
  // The suggested command is cwd-relative (`dist/index.js`), so defaulting
  // would let a hostile repo decide WHAT the (user-scoped, workspace-unsettable)
  // command actually resolves to: opening a repo whose SERVER_URL points at a
  // down localhost port would run that repo's dist/index.js. See §5.
  if (!config.cwd) {
    return {
      kind: 'refused',
      reason:
        '"steptix.serverAutoStart.cwd" is not set. It is required whenever a command ' +
        'is configured, because the command is resolved relative to it',
    };
  }
  if (!logPath) {
    return { kind: 'refused', reason: 'the extension has no storage location for the server log' };
  }

  log?.(`starting server: ${config.command} (cwd=${config.cwd}) → ${logPath}`);
  try {
    spawn({ command: config.command, cwd: config.cwd, logPath });
  } catch (err) {
    return {
      kind: 'refused',
      reason: `the spawn itself failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const deadline = now() + config.readyTimeoutSeconds * 1000;
  while (now() < deadline) {
    if (signal?.aborted) return { kind: 'aborted' };
    await sleep(HEALTH_POLL_INTERVAL_MS);
    if (signal?.aborted) return { kind: 'aborted' };

    const result = await probe(serverUrl, HEALTH_PROBE_TIMEOUT_MS, signal);
    if (signal?.aborted) return { kind: 'aborted' };
    if (result.kind === 'healthy') return { kind: 'ready', health: result.health };
    if (result.kind === 'foreign') return { kind: 'foreign', service: result.service };
    // 'unknown' keeps polling: a server mid-boot can answer oddly for a
    // moment, and we would rather spend the remaining budget than fall back
    // to the legacy path against a server we just started ourselves.
  }

  const logTail = readLogTail(logPath);
  return {
    kind: 'timeout',
    seconds: config.readyTimeoutSeconds,
    logPath,
    ...(logTail && { logTail }),
  };
}

/** How much of the log tail to quote in an STX028 diagnostic. */
const LOG_TAIL_BYTES = 2_000;
const LOG_TAIL_LINES = 5;

/**
 * Last few lines of the server log, for the STX028 message — "see the log" is
 * a much worse error than "see the log; it says Cannot find module".
 *
 * Best-effort and cheap by construction: reads at most the final
 * {@link LOG_TAIL_BYTES}, never the whole file (it can be 5 MB), and returns
 * undefined rather than throwing if anything goes wrong.
 */
export function readLogTail(logPath: string): string | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(logPath).size;
    if (size === 0) return undefined;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fd = openSync(logPath, 'r');
    readSync(fd, buf, 0, length, size - length);
    const lines = buf
      .toString('utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return undefined;
    return lines.slice(-LOG_TAIL_LINES).join(' | ');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}
