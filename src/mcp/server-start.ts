/**
 * Auto-start: guarantee a Sessions API server is listening at the project's
 * `SERVER_URL` before any tool sends it a request (stories/mcp-server.md §5).
 *
 * The shape is a four-arm decision tree over one `/health` probe:
 *
 *  1. healthy and it says it is ours          → proceed
 *  2. answered but unidentifiable             → REFUSE. Never spawn, never
 *                                               proceed
 *  3. down, and the host is not loopback      → refuse; it is not our machine
 *  4. down and loopback                       → spawn, then poll until healthy
 *
 * Arm 2 is the one that looks wrong and is not. TestBench's equivalent treats
 * an unrecognized answer as "probably an older aiui server" and proceeds — it
 * only ever sends a step payload. We would send `SERVER_API_KEY` *and the
 * project's entire composed `.env`* as the request's `env` field, which for
 * this repo means AI, banking and GitHub credentials handed to whatever
 * process happens to hold the port. `aiui stop` already refuses on the same
 * check before sending merely the key.
 *
 * Ported from `testbench-native/src/extension/server-manager.ts` (a separate
 * bundle, so genuinely a port, not an import). `describeHealth` and
 * `decideServerAction` were deliberately NOT ported: both map "unrecognized"
 * onto the legacy proceed path, which is exactly what arm 2 reverses.
 */
import { spawn as spawnChild, type SpawnOptions } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
} from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeBaseUrl,
  probeHealth,
  type HealthProbeResult,
} from '../server/health.js';
import {
  autoStartFailed,
  autoStartSuppressed,
  badServerUrl,
  distEntryMissing,
  remoteServerDown,
  unrecognizedService,
} from './errors.js';
import {
  clearStartFailure,
  lastStartFailure,
  recordStartFailure,
  withSingleFlightStart,
} from './registry.js';
import { PreflightFailure, type EnsureServerReady, type ProjectContext } from './types.js';
import { canonicalServerKey, isLoopbackHost, normalizeSpawnHost } from './url.js';

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * Budget for the single probe that decides the arm.
 *
 * Two seconds, matching `aiui status`/`aiui stop`, rather than the one second
 * the poll uses: this probe's failure mode is expensive in a way the poll's is
 * not. A server busy with a long run can be slow to answer, and reading that
 * as "down" makes us spawn a second server which dies of EADDRINUSE and costs
 * the caller the full 20 s poll before reporting a failure that never was.
 */
const INITIAL_PROBE_TIMEOUT_MS = 2_000;

/** Poll cadence while waiting for a server we just spawned. */
const HEALTH_POLL_INTERVAL_MS = 250;

/** Per-probe budget during the poll. A local server answers in single-digit
 *  ms, and a 2 s budget here would make the 250 ms cadence meaningless. */
const HEALTH_PROBE_TIMEOUT_MS = 1_000;

/** Total time we wait for a spawned server to identify itself. */
const START_TIMEOUT_MS = 20_000;

/** How long a failed start suppresses further attempts for the same URL.
 *  Long enough to cover an agent fanning out a batch of tool calls, short
 *  enough that fixing the cause and retrying works without restarting the
 *  host. */
const AUTO_START_BACKOFF_MS = 60_000;

/**
 * `serve --idle-timeout` is in MINUTES, and 60 is a product decision rather
 * than a technical one: long enough that an agent coming back from a break
 * still has its session and browser, at the cost of holding that browser for
 * an hour after someone walks away. It also decides whether TestBench finds a
 * live server later on.
 */
const IDLE_TIMEOUT_MINUTES = 60;

// ---------------------------------------------------------------------------
// Log file
// ---------------------------------------------------------------------------

/** Relative to the project root. `.aiui/` is gitignored. */
const LOG_RELATIVE_PATH = path.join('.aiui', 'mcp-server.log');

/** Truncate the rolling log once it passes this, at open time. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** How much of the tail to quote in a failure message. */
const LOG_TAIL_BYTES = 2_000;
const LOG_TAIL_LINES = 5;

// ---------------------------------------------------------------------------
// Injection seam
// ---------------------------------------------------------------------------

/** The slice of `ChildProcess` this module touches. Narrow on purpose: a test
 *  double is then two methods, not a fake EventEmitter. */
export interface SpawnedChild {
  on(event: 'error', listener: (err: Error) => void): unknown;
  unref(): void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedChild;

/**
 * Everything auto-start touches that a test must not really do.
 *
 * `spawn` is injected at the raw `child_process` level rather than behind a
 * "spawn the server" helper so tests can assert the argv and the option bag
 * themselves — the normalized `--host`, `shell:false` and the composed `env`
 * are the whole point of this workstream, and a helper-shaped seam would hide
 * all three.
 */
export interface AutoStartDeps {
  probe: (
    baseUrl: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<HealthProbeResult>;
  spawn: SpawnFn;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Absolute path of the built entry the child runs. */
  distEntry: string;
}

function defaultDeps(): AutoStartDeps {
  return {
    probe: probeHealth,
    spawn: spawnChild,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    distEntry: resolveDistEntry(),
  };
}

/**
 * Absolute path of `dist/index.js`, by the same relative walk
 * `src/utils/version.ts` uses to find `package.json`.
 *
 * It works for a checkout, for `tsx`-from-source and for an npm install alike
 * because `src/mcp/` and `dist/mcp/` sit at the same depth. A bare
 * `../index.js` would resolve to `src/index.js` under `tsx` — this repo's own
 * dev loop — which does not exist, so the child would die with
 * MODULE_NOT_FOUND and the caller would wait out the full 20 s poll to be told
 * something misleading.
 */
export function resolveDistEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The production entry, pinned to the `types.ts` contract.
 *
 * The annotation is not decoration: W3 hands this to `McpDeps`, and a drift in
 * the signature would otherwise only show up there.
 */
export const ensureServerReady: EnsureServerReady = (project, signal) =>
  ensureServerReadyWith(project, signal);

/**
 * Refuse to talk to whatever holds the port unless it identifies as ours.
 *
 * For the tools that only report on what is already there — `list_sessions`,
 * `close_session`, `get_last_run`, `get_page_content`, `list_cdp_browsers`.
 * They still send
 * `SERVER_API_KEY`, and without this they send it to any process that happens
 * to hold the port: an agent calling `list_sessions` as a harmless "what's
 * running?" probe would hand the project's key to a squatter. That is the same
 * hazard §5 arm 2 exists for, and the same one `aiui stop` guards before
 * sending merely the key.
 *
 * Deliberately NOT `ensureServerReady`: asking what is running must never start
 * a server. A `down` server is allowed through so the caller's own request
 * fails with an ordinary connect error rather than a confusing refusal.
 *
 * The test is what a tool is FOR, not whether it happens to talk to the server.
 * One whose purpose is to make something exist belongs on `ensureServerReady`:
 * `start_cdp_browser` was routed here by the helper it shares with the probes
 * and inherited this rule, so against a stopped server it died on a bare
 * ECONNREFUSED while `run_test_file` from the same agent would have started
 * one. Keep this list in step with `withProject`'s `autoStart` in
 * [tools.ts](./tools.ts).
 */
export async function assertServerRecognized(
  project: ProjectContext,
  signal?: AbortSignal,
  overrides: Partial<AutoStartDeps> = {},
): Promise<void> {
  const probe = overrides.probe ?? probeHealth;
  const health = await probe(project.serverUrl, INITIAL_PROBE_TIMEOUT_MS, signal);
  signal?.throwIfAborted();
  if (health.kind === 'unrecognized') {
    throw new PreflightFailure(
      unrecognizedService(normalizeBaseUrl(project.serverUrl), health.detail),
    );
  }
}

/** {@link ensureServerReady} with its collaborators exposed. Tests drive this. */
export async function ensureServerReadyWith(
  project: ProjectContext,
  signal?: AbortSignal,
  overrides: Partial<AutoStartDeps> = {},
): Promise<void> {
  const deps: AutoStartDeps = { ...defaultDeps(), ...overrides };
  const url = parseServerUrl(project.serverUrl);

  const health = await deps.probe(project.serverUrl, INITIAL_PROBE_TIMEOUT_MS, signal);

  // `probeHealth` folds EVERY fetch rejection into `down`, an abort included
  // (its own header says so). Interpreting this `down` without checking first
  // would turn "the agent cancelled the tool call" into "your server never
  // came up", and — worse — would spawn a server nobody asked for.
  signal?.throwIfAborted();

  switch (health.kind) {
    case 'ok':
      // A healthy server never reaches the backoff check, so this is not
      // required for correctness now — it is here so a start that failed,
      // succeeded by other means, and later fails again is not silently
      // suppressed by a record from ten minutes ago.
      clearStartFailure(project.serverUrl);
      return;

    case 'unrecognized':
      throw new PreflightFailure(
        unrecognizedService(normalizeBaseUrl(project.serverUrl), health.detail),
      );

    case 'down':
      break;

    default: {
      // Fail closed on an arm added to `HealthProbeResult` later. The spec
      // records what the open version of this mistake costs elsewhere: the CLI
      // tests `kind === 'unrecognized'` with an `if`, so a new arm silently
      // falls past `aiui stop`'s refusal and posts SERVER_API_KEY to a foreign
      // process. This is the one place that can refuse instead.
      const unreachable: never = health;
      void unreachable;
      throw new PreflightFailure(
        unrecognizedService(normalizeBaseUrl(project.serverUrl), 'unrecognised probe result'),
      );
    }
  }

  if (!isLoopbackHost(url.hostname)) {
    throw new PreflightFailure(remoteServerDown(normalizeBaseUrl(project.serverUrl)));
  }

  assertSpawnable(url, project.serverUrl);
  await startAndWait(project, url, deps, signal);
}

// ---------------------------------------------------------------------------
// SERVER_URL validation
// ---------------------------------------------------------------------------

/**
 * Checks that apply on every path, healthy server included.
 *
 * A path component is refused here rather than at spawn time because it
 * poisons the probe itself: `probeHealth` appends `/health` to the normalized
 * base, so `http://h:3100/api` probes `/api/health`, gets a 404, and lands in
 * arm 2 — which would report "something else is on that port" about our own
 * server.
 */
function parseServerUrl(serverUrl: string): URL {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new PreflightFailure(badServerUrl(serverUrl, 'it is not a URL.'));
  }

  // Compared against `origin` rather than checking `pathname` alone, because
  // that one property is four problems: a path, a query and a fragment all
  // survive `normalizeBaseUrl` and turn `/health` into a 404 — which lands in
  // arm 2 and reports "something else is on that port" about our own server —
  // while embedded credentials (`http://user:pass@host`) would be echoed
  // verbatim by every error message that names the URL.
  if (normalizeBaseUrl(serverUrl) !== url.origin) {
    // Echoed without userinfo but WITH the path/query/fragment: naming what is
    // wrong is the whole value of this message, while `http://user:pass@host`
    // credentials must not be repeated back into a tool result the agent keeps.
    const redacted = `${url.origin}${url.pathname}${url.search}${url.hash}`;
    throw new PreflightFailure(
      badServerUrl(
        redacted,
        'it must be a bare origin like http://localhost:3100 — no path, query, ' +
          'fragment or credentials. The health check and every session route ' +
          'are appended to it.',
      ),
    );
  }
  return url;
}

/**
 * Checks that apply only once we are about to spawn.
 *
 * Deliberately not folded into {@link parseServerUrl}: a server that is
 * already answering must keep working. `aiui` behind an HTTPS reverse proxy is
 * a configuration TestBench allows today, and refusing it up front would break
 * a setup that works — but *starting* a child for it cannot work, because
 * `serve` speaks plain HTTP only.
 */
function assertSpawnable(url: URL, serverUrl: string): void {
  if (url.protocol !== 'http:') {
    throw new PreflightFailure(
      badServerUrl(
        serverUrl,
        `nothing is listening there and \`aiui serve\` speaks plain HTTP, so a ` +
          `"${url.protocol}" URL cannot be started automatically. Start the server ` +
          'yourself behind your proxy, or point SERVER_URL at the http:// origin.',
      ),
    );
  }

  // `new URL('http://localhost/').port` is '', and `serve` parses `--port`
  // with a bare `parseInt`, so the child would call `app.listen(NaN)` and die
  // of ERR_SOCKET_BAD_PORT. Defaulting to 80/443 would be worse: we would bind
  // a privileged port nobody asked for.
  if (url.port === '') {
    throw new PreflightFailure(
      badServerUrl(
        serverUrl,
        'nothing is listening there and it names no port, so there is no port to ' +
          'start a server on. Write it out, e.g. http://localhost:3100.',
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Spawn + poll
// ---------------------------------------------------------------------------

async function startAndWait(
  project: ProjectContext,
  url: URL,
  deps: AutoStartDeps,
  signal: AbortSignal | undefined,
): Promise<void> {
  // Checked before anything else because it is the fastest, most actionable
  // failure there is: a fresh clone has no `dist/`, and without this the
  // caller waits 20 s to be told the server "did not become healthy".
  if (!existsSync(deps.distEntry)) {
    throw new PreflightFailure(distEntryMissing(deps.distEntry));
  }

  const logPath = path.join(project.projectRoot, LOG_RELATIVE_PATH);
  const args = [
    // Both clients share one server, so whoever starts it decides whether
    // TestBench's tool step-into can attach — `/health` reporting
    // `inspector: null` makes the extension refuse.
    '--inspect=0',
    deps.distEntry,
    'serve',
    '--host',
    normalizeSpawnHost(url.hostname),
    '--port',
    url.port,
    '--idle-timeout',
    String(IDLE_TIMEOUT_MINUTES),
  ];
  const command = formatCommand(process.execPath, args);

  const failedAt = lastStartFailure(project.serverUrl);
  const sinceFailure = failedAt === undefined ? undefined : deps.now() - failedAt;
  if (sinceFailure !== undefined && sinceFailure < AUTO_START_BACKOFF_MS) {
    // A suppressed attempt has no fresh spawn of its own, so the diagnostic
    // re-reads the log the *previous* attempt left — otherwise the message
    // that most needs an explanation is the one with none.
    throw new PreflightFailure(
      autoStartSuppressed(
        command,
        logPath,
        readLogTail(logPath, attemptLogOffsets.get(canonicalServerKey(project.serverUrl)) ?? 0) ?? '',
        AUTO_START_BACKOFF_MS - sinceFailure,
      ),
    );
  }

  // Auto-start is pre-flight, and the §6 session mutex is entered after
  // pre-flight — so without this two parallel tool calls against a down server
  // would both probe, both see "down + loopback", and both spawn. The registry
  // owns the signal the shared work runs under; this caller only races its own
  // against the result.
  await withSingleFlightStart(project.serverUrl, signal, (startSignal) =>
    spawnAndPoll({ project, deps, args, command, logPath, startSignal }),
  );
}

async function spawnAndPoll(opts: {
  project: ProjectContext;
  deps: AutoStartDeps;
  args: string[];
  command: string;
  logPath: string;
  startSignal: AbortSignal;
}): Promise<void> {
  const { project, deps, args, command, logPath, startSignal } = opts;
  const serverUrl = project.serverUrl;

  const { fd: logFd, startOffset } = openLogFile(logPath);
  // Remembered so a *suppressed* retry quotes this attempt's output rather
  // than reaching back into an earlier server's log.
  attemptLogOffsets.set(canonicalServerKey(serverUrl), startOffset);
  try {
    const child = deps.spawn(process.execPath, args, {
      cwd: project.projectRoot,
      detached: true,
      // Stated rather than left to the default because the extension uses
      // `shell: true`: its input is a user-configured command *string*, ours
      // is a known argv array. A shell would also demand quoting for
      // `process.execPath`, routinely `C:\Program Files\nodejs\node.exe`.
      shell: false,
      // Or a console window flashes on screen on every auto-start.
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv(project),
    });

    // MANDATORY. Node reports a missing `cwd`, EPERM and EACCES
    // asynchronously on this event, and with no listener EventEmitter
    // rethrows them as an uncaught exception — which in an MCP server drops
    // the host connection entirely. The child writes nothing in that case, so
    // appending here is also the only way the failure message below has
    // anything to quote.
    child.on('error', (err) => {
      try {
        appendFileSync(logPath, `\n[aiui mcp] failed to start ${command}: ${err.message}\n`);
      } catch {
        // The log is best-effort; never let logging a failure become one.
      }
    });

    // A call, NOT a `spawn` option — Node silently ignores an unknown
    // `unref` key. Measured with exactly this option set: without the call
    // the parent stayed alive 5046 ms (the child's whole lifetime) versus
    // 0 ms with it. Our child lives up to the 60-minute idle timeout, so an
    // MCP process that started one would never exit when the host closes
    // stdin, orphaning a process per host session.
    child.unref();
  } catch (err) {
    // Nearly unreachable — the everyday failures arrive on 'error' above —
    // but a synchronous throw means no child exists to poll for.
    recordStartFailure(serverUrl, deps.now());
    throw new PreflightFailure(
      autoStartFailed(
        command,
        logPath,
        `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  } finally {
    // The child holds its own dup of the descriptor; ours is done.
    closeSync(logFd);
  }

  // Poll rather than watch for the child's `exit`: "our child died" and "the
  // run can proceed" are not mutually exclusive. When two hosts race, the
  // loser's child dies of EADDRINUSE while the winner's server answers the
  // loser's poll — so polling makes the race self-resolving and no
  // cross-process locking is needed.
  const deadline = deps.now() + START_TIMEOUT_MS;
  while (deps.now() < deadline) {
    startSignal.throwIfAborted();
    await deps.sleep(HEALTH_POLL_INTERVAL_MS);
    startSignal.throwIfAborted();

    const health = await deps.probe(serverUrl, HEALTH_PROBE_TIMEOUT_MS, startSignal);
    // Same trap as the opening probe: an aborted fetch reads as `down`.
    startSignal.throwIfAborted();

    if (health.kind === 'ok') {
      clearStartFailure(serverUrl);
      return;
    }
    // `unrecognized` keeps polling. A server mid-boot can answer oddly for a
    // moment, and this cannot become arm 2's hole: we never *proceed* on an
    // unrecognized answer here — the worst case is spending the rest of the
    // budget and failing, with EADDRINUSE in the log tail to explain it.
  }

  recordStartFailure(serverUrl, deps.now());
  throw new PreflightFailure(
    autoStartFailed(command, logPath, readLogTail(logPath, startOffset) ?? ''),
  );
}

/**
 * Where each server URL's most recent start attempt began writing.
 *
 * Module-level for the same reason the registry's maps are: one process, and a
 * suppressed retry needs the offset an earlier call recorded.
 */
const attemptLogOffsets = new Map<string, number>();

/**
 * The child's environment: this process's, with the project's composed `.env`
 * layered on top.
 *
 * Inheritance alone is not enough, in two different ways. `serve` hard-exits
 * before binding when `SERVER_API_KEY` is unset, so a host started without one
 * yields an instantly-dead child and a 20 s wait for nothing. And
 * `loadDefaultEnvFileSync` reads only the base `.env` — never the
 * `.env.<name>` overlay — and does not override keys already in `process.env`,
 * so the child would hold the *base* key while we send the *overlay* key: a
 * permanent 401 that looks like a bug in the server.
 */
/**
 * Variables a project's `.env` may NOT set on the server we spawn.
 *
 * These are interpreted by the Node runtime before a line of framework code
 * runs, so they are not configuration — they are code execution. `NODE_OPTIONS`
 * honours `--require`/`--import`; `NODE_EXTRA_CA_CERTS` silently trusts an
 * interception CA for every AI and application call the server subsequently
 * makes; `PATH` redirects any child process it launches.
 *
 * That a project's own files can run that project's own code is the product
 * working as designed. The reason this list exists is that the boundary here is
 * wider: one server serves *every* project pointing at that `SERVER_URL`, holds
 * each one's composed `.env`, and lives for the whole idle window — so without
 * the filter, project A's `.env` gets code execution inside the process that
 * later handles project B's credentials.
 *
 * A deny-list rather than an allow-list because the overlay's whole job is to
 * carry arbitrary project configuration; only the loader-influencing names are
 * dangerous. Do not quietly shorten it.
 */
const UNSAFE_CHILD_ENV_KEYS = new Set(
  [
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'NODE_REPL_EXTERNAL_MODULE',
    'ELECTRON_RUN_AS_NODE',
    'PATH',
    'NODE_PATH',
  ].map((key) => key.toLowerCase()),
);

function childEnv(project: ProjectContext): NodeJS.ProcessEnv {
  // `project.apiKey` is pinned explicitly because it may not be in
  // `project.env` at all: §4's discovery fallback lets SERVER_API_KEY come
  // from `process.env`, and that value is deliberately kept out of the map we
  // send to the server. The child and the client must agree on it regardless.
  const overlay: Record<string, string> = { SERVER_API_KEY: project.apiKey };
  for (const [key, value] of Object.entries(project.env)) {
    if (UNSAFE_CHILD_ENV_KEYS.has(key.toLowerCase())) continue;
    overlay[key] = value;
  }
  // Re-pin after the loop, so a project `.env` cannot shadow it.
  overlay['SERVER_API_KEY'] = project.apiKey;
  const merged: NodeJS.ProcessEnv = { ...process.env };

  if (process.platform !== 'win32') return Object.assign(merged, overlay);

  // Windows environment lookups are case-insensitive, but spreading
  // `process.env` preserves the parent's casing — so a parent `Server_Api_Key`
  // and an overlay `SERVER_API_KEY` would both survive into the child's block
  // and Windows would pick a winner for us. Replace the colliding key instead.
  const canonical = new Map<string, string>();
  for (const key of Object.keys(merged)) canonical.set(key.toLowerCase(), key);

  for (const [key, value] of Object.entries(overlay)) {
    const existing = canonical.get(key.toLowerCase());
    if (existing !== undefined && existing !== key) delete merged[existing];
    merged[key] = value;
    canonical.set(key.toLowerCase(), key);
  }
  return merged;
}

/** Quoted so the command in a failure message can be pasted into a shell —
 *  `process.execPath` contains a space on most Windows installs. */
function formatCommand(exe: string, args: readonly string[]): string {
  return [exe, ...args].map((token) => (/\s/.test(token) ? `"${token}"` : token)).join(' ');
}

// ---------------------------------------------------------------------------
// The log the child writes to
// ---------------------------------------------------------------------------

/**
 * Open `<project_root>/.aiui/mcp-server.log` for append, rolling it over when
 * oversized.
 *
 * `0o600` is correct and free on POSIX, but it is INERT on win32 — measured,
 * the file lands mode 666, because Node on Windows can only express the
 * read-only bit. It also applies at creation only; an existing looser file
 * keeps its permissions. So it is not a mitigation to lean on: on this
 * project's primary platform this log — which holds whatever the server prints
 * — is readable by every user on the box.
 */
/**
 * Open the rolling log, and report where *this* attempt's output will start.
 *
 * The offset is the security-relevant half. The log is append-only across
 * server lifetimes, and the server writes step text with `${env.X}` already
 * resolved — so quoting "the last five lines" after a child that wrote nothing
 * quotes the *previous* server's steps, secrets included, into a tool result
 * that reaches the agent and its model provider.
 */
function openLogFile(logPath: string): { fd: number; startOffset: number } {
  mkdirSync(path.dirname(logPath), { recursive: true });
  let startOffset = 0;
  try {
    const size = statSync(logPath).size;
    if (size > LOG_MAX_BYTES) truncateSync(logPath, 0);
    else startOffset = size;
  } catch {
    // No file yet — nothing to truncate, and nothing written before us.
  }
  return { fd: openSync(logPath, 'a', 0o600), startOffset };
}

/**
 * Last few lines of the server log, for a failure message.
 *
 * "The server did not start; see the log" is a far worse error than the same
 * sentence followed by `Cannot find module`. Cheap by construction: reads at
 * most the final {@link LOG_TAIL_BYTES} rather than a file that may be 5 MB,
 * and returns undefined instead of throwing.
 */
/**
 * Last few lines of the log, never reaching earlier than `fromOffset`.
 *
 * The floor is not a nicety: without it a child that died before writing
 * anything makes us quote the previous server's output — which contains step
 * text with environment values already substituted.
 */
export function readLogTail(logPath: string, fromOffset = 0): string | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(logPath).size;
    if (size <= fromOffset) return undefined;
    const available = size - fromOffset;
    const length = Math.min(available, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fd = openSync(logPath, 'r');
    readSync(fd, buf, 0, length, size - length);
    const lines = buf
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
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
