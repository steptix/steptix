// The vault, spoken to through the Bitwarden CLI (SPEC 29 §4–§5).
//
// Bitwarden is the SAFE and nothing else: it stores, syncs and hands over
// credentials. It never touches a page. Everything about typing lives in
// login-fields.ts and broker.ts.
//
// Two rules this file exists to keep:
//
//  1. **Nothing secret is ever an argv entry.** Command lines are readable by
//     every process on the machine (`wmic process get CommandLine`, `ps`), so
//     the master password goes down stdin and the session key goes in the
//     child's environment. The page URL is not secret but is attacker-shaped,
//     so `spawn` is called with an args array and `shell: false` — there is no
//     shell to inject into.
//  2. **Secrets are fetched as late as possible and never retained.** The
//     lookup that chooses an item returns names and URIs only; the username and
//     password are fetched in a second call, after approval, and dropped by the
//     caller as soon as they are typed.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { originForLookup } from './domain-match.js';
import type { VaultFailure, VaultItem, VaultProvider, VaultSecret } from './types.js';
import { VaultError } from './types.js';

/** How long any one `bw` invocation gets. Generous: `sync` talks to the network. */
const BW_TIMEOUT_MS = 30_000;

/** What `bw` prints on the two failures worth naming separately. */
const NOT_LOGGED_IN = /not logged in|you are not logged in/i;
const LOCKED = /vault is locked|session key|BW_SESSION/i;

/** The variable `bw` reads to decide whether it may prompt. See `childEnv`. */
const NO_INTERACTION = 'BW_NOINTERACTION';

interface BwResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Characters allowed in an argument, checked before any child is spawned.
 *
 * Every `bw` argument this file passes is either a fixed literal, a validated
 * origin (`originForLookup`), or a vault item id. None of them legitimately
 * contains a space or a shell metacharacter, so anything that does is refused
 * rather than quoted — quoting is where this class of bug reappears, and the
 * `cmd.exe` path below makes the stakes real.
 */
const SAFE_ARG = /^[A-Za-z0-9._:/@-]+$/;

/** Extensions Windows will run, in the order `where` would find them. */
const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat'];

/**
 * Find the real file behind a bare binary name on Windows.
 *
 * `npm i -g @bitwarden/cli` installs `bw.cmd`, not `bw.exe` — and Node's
 * `spawn` with `shell: false` refuses a `.cmd` outright with `EINVAL`
 * (deliberately, since CVE-2024-27980). So the single most likely way for a
 * user to have installed Bitwarden produces a spawn error that names neither
 * the file nor the problem. Resolving the extension ourselves means we know
 * which of the two launch paths we need, and can still say "not installed"
 * when it really is not.
 */
export function resolveBinary(binary: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return binary;
  if (binary.includes('/') || binary.includes('\\') || /\.[a-z]+$/i.test(binary)) return binary;
  const pathValue = env['PATH'] ?? env['Path'] ?? '';
  for (const dir of pathValue.split(';')) {
    if (dir === '') continue;
    for (const ext of WINDOWS_EXTENSIONS) {
      const candidate = `${dir.replace(/[\\/]+$/, '')}\\${binary}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return binary;
}

/**
 * Characters `cmd.exe` acts on even inside double quotes — `%` expands a
 * variable, `"` ends the quoting — plus line breaks, which end the command. A
 * binary path containing any of them cannot be handed to `cmd.exe` safely at
 * all, so it is refused rather than escaped.
 */
const CMD_UNSAFE_IN_QUOTES = /["%\r\n]/;

/** How to start one `bw` command. `verbatim` is `windowsVerbatimArguments`. */
export interface BwLaunch {
  command: string;
  args: string[];
  verbatim: boolean;
}

/**
 * The command line that runs `binary` with `args`: the one launch rule shared
 * by the one-shot calls below and the login driver (bw-login.ts).
 *
 * A `.cmd` or `.bat` cannot be spawned directly (see `resolveBinary`), so on
 * Windows it goes through `cmd.exe` — and `cmd.exe` parses the WHOLE line,
 * binary path included. So the line is built the way Node builds its own
 * `shell: true` line: `/d /s /c ""<binary>" <args>"`, passed verbatim. `/s`
 * strips exactly the outer pair of quotes and leaves the binary quoted, which
 * is what makes a path with a space in it work — the default npm-global
 * location is `%APPDATA%\npm`, under a profile folder that often has one.
 * (Node's own quoting plus `/s` did not: `/s` stripped Node's quotes off the
 * path and `cmd.exe` split it at the space.) Inside those quotes `&`, `|`,
 * `^`, `<` and `>` are literal; `CMD_UNSAFE_IN_QUOTES` covers what is not,
 * and the arguments themselves are fixed literals or values that cleared
 * `SAFE_ARG`, so none of them needs quoting.
 *
 * Note what the wrapping costs: the program becomes a CHILD of the process we
 * spawn, and stopping the wrapper does not always stop it
 * (stories/bitwarden-sign-in.md §1 fact 10).
 *
 * `platform` is a parameter so the Windows branch is testable anywhere.
 */
export function bwLaunch(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): BwLaunch {
  const viaCmd = platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
  if (!viaCmd) return { command: binary, args, verbatim: false };
  if (CMD_UNSAFE_IN_QUOTES.test(binary)) {
    throw new VaultError('unreadable', 'The Bitwarden CLI path contains characters cmd.exe would interpret.');
  }
  // After `/s` strips the outer quotes the arguments stand outside any quotes,
  // where cmd.exe acts on everything. Every caller passes SAFE_ARG-clean values
  // today; this is where that stops being a promise and becomes a check.
  if (!args.every((arg) => SAFE_ARG.test(arg))) {
    throw new VaultError('unreadable', 'Refusing to run the vault CLI with an unexpected argument.');
  }
  return {
    command: env['COMSPEC'] ?? 'cmd.exe',
    // `/v:off`: delayed expansion can be switched on machine-wide in the
    // registry, `/d` does not undo that, and with it on a `!` in the path
    // would expand even inside quotes.
    args: ['/d', '/v:off', '/s', '/c', `""${binary}" ${args.join(' ')}"`],
    verbatim: true,
  };
}

/** How `bw` is actually invoked. A seam, so the sync and retry rules below can
 *  be tested without spawning anything. */
export type BwRunner = (
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
) => Promise<BwResult>;

/**
 * How long the local vault cache is trusted before another `bw sync`.
 *
 * `bw list` reads a cache on disk; only `sync` refreshes it from the server.
 * This used to be "sync once per process", which is wrong for a server that
 * runs for days: an item added or a password rotated on another device stayed
 * invisible until restart. A stale *password* is the worse half — the site
 * rejects a login that looks correct from here.
 *
 * A minute is short against how often anyone edits their vault, and long
 * against a burst of calls inside one multi-page sign-in.
 */
const SYNC_TTL_MS = 60_000;

export interface BitwardenOptions {
  /** The binary. Overridable so a test can point at a stub. */
  binary?: string;
  /** Session key from an earlier unlock, or the ambient `BW_SESSION`. */
  session?: string | undefined;
  /** Ambient environment for the child. Injected so tests need not mutate `process.env`. */
  environment?: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to actually running `bw`. */
  runner?: BwRunner;
  /** Injected so cache expiry is testable without waiting a minute. */
  now?: () => number;
}

/**
 * Run `bw` with the given arguments.
 *
 * `input` is written to stdin and never appears anywhere else — it is how the
 * master password reaches `bw unlock` without being visible in the process
 * list. The child's stdout is captured whole because `bw` emits one JSON
 * document per call.
 */
function runBw(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<BwResult> {
  return new Promise((resolve, reject) => {
    for (const arg of args) {
      if (!SAFE_ARG.test(arg)) {
        reject(new VaultError('unreadable', 'Refusing to run the vault CLI with an unexpected argument.'));
        return;
      }
    }

    // Safe to hand to `cmd.exe` only because every argument passed the
    // `SAFE_ARG` gate above, and `bwLaunch` refuses a binary path cmd.exe
    // would interpret — see `bwLaunch`.
    let launch: BwLaunch;
    try {
      launch = bwLaunch(binary, args, env);
    } catch (err) {
      reject(err);
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, {
        // Never `shell: true`. The origin we pass reaches here from a web page,
        // and a shell would turn a metacharacter in it into a command.
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new VaultError('unreadable', `The Bitwarden CLI did not answer within ${BW_TIMEOUT_MS}ms.`));
    }, BW_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT here is the ordinary "you have not installed it yet" case, and
      // deserves to say so rather than surfacing as a spawn stack trace.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reject(new VaultError('cli-missing', `The Bitwarden CLI ("${binary}") is not installed or not on PATH.`));
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (input !== undefined) child.stdin?.write(input);
    child.stdin?.end();
  });
}

/** Classify a non-zero `bw` exit into something the broker can act on. */
function classify(result: BwResult): VaultFailure {
  const text = `${result.stderr}\n${result.stdout}`;
  if (NOT_LOGGED_IN.test(text)) return 'not-logged-in';
  if (LOCKED.test(text)) return 'locked';
  return 'unreadable';
}

/** The subset of a `bw` item we read. Everything else is ignored. */
interface BwItem {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  login?: {
    username?: unknown;
    password?: unknown;
    totp?: unknown;
    uris?: unknown;
  };
}

function toVaultItem(raw: BwItem): VaultItem | null {
  // type 1 is a login. Cards, notes and identities have no credential to type.
  if (raw.type !== 1) return null;
  const id = typeof raw.id === 'string' ? raw.id : null;
  if (!id) return null;
  const uris: string[] = [];
  if (Array.isArray(raw.login?.uris)) {
    for (const entry of raw.login.uris as Array<{ uri?: unknown }>) {
      if (entry && typeof entry.uri === 'string' && entry.uri !== '') uris.push(entry.uri);
    }
  }
  return {
    id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : '(unnamed item)',
    uris,
    hasTotp: typeof raw.login?.totp === 'string' && raw.login.totp !== '',
  };
}

/**
 * `VaultProvider` backed by the real Bitwarden CLI.
 *
 * Holds a session key in memory when one was obtained by `unlock`. That key is
 * never written to disk and dies with the process — the same shape as the
 * fleet console's own decision to keep decrypted values in memory rather than
 * re-deriving them per use.
 */
export class BitwardenVault implements VaultProvider {
  private readonly binary: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly run: BwRunner;
  private readonly now: () => number;
  private session: string | undefined;
  /** When the local cache was last refreshed. 0 = never. */
  private lastSyncAt = 0;

  constructor(opts: BitwardenOptions = {}) {
    this.environment = opts.environment ?? process.env;
    this.run = opts.runner ?? runBw;
    this.now = opts.now ?? Date.now;
    // `STEPTIX_BW_BINARY` for a `bw` that is installed but not on PATH — which on
    // Windows is the normal outcome of an npm-global or Scoop install seen from
    // a service-spawned process, where PATH is not the user's shell PATH.
    this.binary = resolveBinary(
      opts.binary ?? this.environment['STEPTIX_BW_BINARY'] ?? 'bw',
      this.environment,
    );
    // An ambient BW_SESSION is honoured deliberately: it lets the user unlock
    // in their own terminal, with their master password going only to
    // Bitwarden's own binary and never through our dialog. That is the safer
    // of the two unlock paths and should stay available.
    this.session = opts.session ?? this.environment['BW_SESSION'] ?? undefined;
  }

  /**
   * The child environment, carrying the session key if we hold one.
   *
   * `BW_NOINTERACTION` decides whether `bw` may stop at an interactive prompt
   * (its every check is `process.env.BW_NOINTERACTION !== "true"`). It must be
   * set for some calls and ABSENT for others:
   *
   * - `'no-prompts'` — status, sync, list, get. Set to `"true"`. With it unset,
   *   a lookup against a locked vault does not fail: `bw` runs an inline
   *   unlock and draws a "Master password:" prompt on a stdin nobody will
   *   answer. With it set, the same lookup answers `Vault is locked.`, which
   *   `LOCKED` classifies.
   * - `'prompts'` — unlock. REMOVED, in any casing. `bw unlock` takes a
   *   password from argv, a file, a named variable, or its interactive prompt,
   *   and `unlock()` below uses the prompt so the password travels down stdin;
   *   with `BW_NOINTERACTION=true` that prompt is never drawn and `bw` refuses
   *   ("Master password is required. Try again in interactive mode…"). That
   *   includes a `BW_NOINTERACTION=true` in the user's OWN environment, which
   *   is why it is deleted rather than merely not added. (The login driver,
   *   bw-login.ts, strips it from its own child environment for the same
   *   reason.)
   *
   * This replaces `BITWARDENCLI_NOINTERACTION`, a name `bw` never reads — the
   * guard it claimed to be was a no-op, and unlock worked only because it was.
   */
  private childEnv(mode: 'no-prompts' | 'prompts'): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    // In any casing: a copied `process.env` is a plain object, so on Windows
    // `Bw_NoInteraction` would survive an exact-key delete and still be read.
    for (const [name, value] of Object.entries(this.environment)) {
      if (name.toUpperCase() !== NO_INTERACTION) env[name] = value;
    }
    if (this.session) env['BW_SESSION'] = this.session;
    if (mode === 'no-prompts') env[NO_INTERACTION] = 'true';
    return env;
  }

  /** Is a vault reachable, and what state is it in? */
  async status(): Promise<'unlocked' | 'locked' | 'unauthenticated' | 'cli-missing'> {
    let result: BwResult;
    try {
      result = await this.run(this.binary, ['status', '--raw'], this.childEnv('no-prompts'));
    } catch (err) {
      if (err instanceof VaultError && err.kind === 'cli-missing') return 'cli-missing';
      throw err;
    }
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { status?: unknown };
      const status = String(parsed.status ?? '');
      if (status === 'unlocked' || status === 'locked' || status === 'unauthenticated') return status;
    } catch {
      // Fall through — an unreadable status is treated as locked, which is the
      // conservative reading: it prompts rather than assuming access.
    }
    return 'locked';
  }

  /**
   * Exchange a master password for a session key.
   *
   * The password arrives as an argument, is written to the child's stdin, and
   * is not stored, logged, or returned. The caller is expected to have obtained
   * it from the user directly and to drop its own copy immediately.
   */
  async unlock(masterPassword: string): Promise<boolean> {
    // Through `this.run`, like every other call, so the environment and input
    // it receives are testable. Prompts allowed: see `childEnv`.
    const result = await this.run(
      this.binary,
      ['unlock', '--raw'],
      this.childEnv('prompts'),
      `${masterPassword}\n`,
    );
    if (result.code !== 0) return false;
    const key = result.stdout.trim();
    if (key === '') return false;
    this.adoptSession(key);
    return true;
  }

  /**
   * Hold a session key obtained some other way than `unlock` — today, the
   * one `bw login --raw` prints (stories/bitwarden-sign-in.md §4.6). In memory
   * only, like every key here; the sync clock restarts because a fresh key can
   * mean a different account's cache.
   */
  adoptSession(key: string): void {
    this.session = key;
    this.lastSyncAt = 0;
  }

  /** True when a session key is held (ambient or from `unlock`). */
  get unlocked(): boolean {
    return this.session !== undefined && this.session !== '';
  }

  /**
   * What the login driver needs to start `bw` the same way this class does:
   * the resolved binary and the ambient environment. The driver builds its own
   * child environment from the latter (story §4.1) — never from `childEnv()`,
   * which would hand it this class's session key.
   */
  get launchContext(): { binary: string; environment: NodeJS.ProcessEnv } {
    return { binary: this.binary, environment: this.environment };
  }

  /**
   * Turn a failed `bw` call into the error to throw — and forget the session
   * key if `bw` says nobody is signed in.
   *
   * A key for a signed-out CLI opens nothing, and holding one makes every
   * later call skip the check that would have found the sign-in dialog
   * (story §2.3). But only the key the failed call actually USED is dropped:
   * a call that started with a stale key can finish after a sign-in stored a
   * fresh one, and throwing the fresh one away would sign the user out of
   * what they just signed in to.
   */
  private failure(result: BwResult, usedKey: string | undefined, message: string): VaultError {
    const kind = classify(result);
    if (kind === 'not-logged-in' && this.session === usedKey) this.session = undefined;
    return new VaultError(kind, message);
  }

  /**
   * Refresh the local cache if it is older than `SYNC_TTL_MS`, or if `force`.
   *
   * Best-effort: a failed sync means the cache is stale, not that the vault is
   * unusable, and failing hard here would break logins for credentials that
   * are present. The timestamp still advances on failure, so a `bw` that is
   * refusing to sync cannot turn every lookup into a network round trip.
   */
  private async ensureSynced(force = false): Promise<void> {
    if (!force && this.lastSyncAt !== 0 && this.now() - this.lastSyncAt < SYNC_TTL_MS) return;
    try {
      await this.run(this.binary, ['sync'], this.childEnv('no-prompts'));
    } catch {
      // Deliberately swallowed; see above.
    }
    this.lastSyncAt = this.now();
  }

  async itemsForUrl(url: string): Promise<VaultItem[]> {
    if (!this.unlocked) {
      throw new VaultError('locked', 'The vault is locked.');
    }
    // The origin, not the URL — see `originForLookup`. A page whose URL has no
    // usable origin has no credential either, and answering "none" beats
    // handing an unvalidated string to a child process.
    const origin = originForLookup(url);
    if (origin === null) return [];

    await this.ensureSynced();
    let items = await this.listFor(origin);

    // Nothing found? Sync and ask once more before saying so.
    //
    // "No saved login for this site" is the one answer a user is most likely
    // to be able to contradict — they can see the item in Bitwarden — and the
    // most common reason for it is a cache older than the item. Paying for one
    // extra sync on the way to a refusal is cheap; it is not on the path of any
    // successful login.
    if (items.length === 0) {
      await this.ensureSynced(true);
      items = await this.listFor(origin);
    }
    return items;
  }

  /** One `bw list items --url`, parsed. */
  private async listFor(origin: string): Promise<VaultItem[]> {
    const usedKey = this.session;
    const result = await this.run(this.binary, ['list', 'items', '--url', origin], this.childEnv('no-prompts'));
    if (result.code !== 0) {
      throw this.failure(result, usedKey, result.stderr.trim() || 'The Bitwarden CLI refused the lookup.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim() || '[]');
    } catch {
      throw new VaultError('unreadable', 'The Bitwarden CLI returned something that is not JSON.');
    }
    if (!Array.isArray(parsed)) return [];
    const items: VaultItem[] = [];
    for (const raw of parsed) {
      const item = toVaultItem(raw as BwItem);
      if (item) items.push(item);
    }
    // The parsed array carried the passwords too — that is how `bw list` works.
    // Nothing above copies them anywhere, so they die with `parsed`.
    return items;
  }

  async secretFor(itemId: string): Promise<VaultSecret> {
    if (!this.unlocked) throw new VaultError('locked', 'The vault is locked.');
    const usedKey = this.session;
    const result = await this.run(this.binary, ['get', 'item', itemId], this.childEnv('no-prompts'));
    if (result.code !== 0) {
      throw this.failure(result, usedKey, 'The Bitwarden CLI would not return that item.');
    }
    let parsed: BwItem;
    try {
      parsed = JSON.parse(result.stdout.trim()) as BwItem;
    } catch {
      throw new VaultError('unreadable', 'The Bitwarden CLI returned something that is not JSON.');
    }
    const username = typeof parsed.login?.username === 'string' ? parsed.login.username : '';
    const password = typeof parsed.login?.password === 'string' ? parsed.login.password : '';
    return { username, password };
  }

  async totpFor(itemId: string): Promise<string | null> {
    if (!this.unlocked) throw new VaultError('locked', 'The vault is locked.');
    const result = await this.run(this.binary, ['get', 'totp', itemId], this.childEnv('no-prompts'));
    if (result.code !== 0) return null;
    const code = result.stdout.trim();
    return code === '' ? null : code;
  }
}
