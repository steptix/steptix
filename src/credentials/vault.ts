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
function resolveBinary(binary: string, env: NodeJS.ProcessEnv): string {
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

export interface BitwardenOptions {
  /** The binary. Overridable so a test can point at a stub. */
  binary?: string;
  /** Session key from an earlier unlock, or the ambient `BW_SESSION`. */
  session?: string | undefined;
  /** Ambient environment for the child. Injected so tests need not mutate `process.env`. */
  environment?: NodeJS.ProcessEnv;
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

    // A `.cmd` cannot be spawned directly (see `resolveBinary`), so it goes
    // through `cmd.exe`. Safe only because every argument passed the
    // `SAFE_ARG` gate above — none can carry `&`, `|`, `^`, `%` or a space,
    // which are the whole of what `cmd.exe` would do something with.
    const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
    const command = viaCmd ? (env['COMSPEC'] ?? 'cmd.exe') : binary;
    const commandArgs = viaCmd ? ['/d', '/s', '/c', binary, ...args] : args;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, commandArgs, {
        // Never `shell: true`. The origin we pass reaches here from a web page,
        // and a shell would turn a metacharacter in it into a command.
        shell: false,
        windowsHide: true,
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
  private session: string | undefined;
  /** Set once a sync has run, so a burst of logins does not re-sync per call. */
  private synced = false;

  constructor(opts: BitwardenOptions = {}) {
    this.environment = opts.environment ?? process.env;
    // `AIUI_BW_BINARY` for a `bw` that is installed but not on PATH — which on
    // Windows is the normal outcome of an npm-global or Scoop install seen from
    // a service-spawned process, where PATH is not the user's shell PATH.
    this.binary = resolveBinary(
      opts.binary ?? this.environment['AIUI_BW_BINARY'] ?? 'bw',
      this.environment,
    );
    // An ambient BW_SESSION is honoured deliberately: it lets the user unlock
    // in their own terminal, with their master password going only to
    // Bitwarden's own binary and never through our dialog. That is the safer
    // of the two unlock paths and should stay available.
    this.session = opts.session ?? this.environment['BW_SESSION'] ?? undefined;
  }

  /** The child environment, carrying the session key if we hold one. */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.environment };
    if (this.session) env['BW_SESSION'] = this.session;
    // Never let `bw` stop for input it will not get: the server has no console.
    env['BITWARDENCLI_NOINTERACTION'] = 'true';
    return env;
  }

  /** Is a vault reachable, and what state is it in? */
  async status(): Promise<'unlocked' | 'locked' | 'unauthenticated' | 'cli-missing'> {
    let result: BwResult;
    try {
      result = await runBw(this.binary, ['status', '--raw'], this.childEnv());
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
    const result = await runBw(
      this.binary,
      ['unlock', '--raw'],
      this.childEnv(),
      `${masterPassword}\n`,
    );
    if (result.code !== 0) return false;
    const key = result.stdout.trim();
    if (key === '') return false;
    this.session = key;
    this.synced = false;
    return true;
  }

  /** True when a session key is held (ambient or from `unlock`). */
  get unlocked(): boolean {
    return this.session !== undefined && this.session !== '';
  }

  private async ensureSynced(): Promise<void> {
    if (this.synced) return;
    // Best-effort. A failed sync means the local cache is stale, not that the
    // vault is unusable — an item added on the phone five minutes ago may be
    // missing, which the caller will see as "no credential for this site". A
    // hard failure here would break logins for credentials that are present.
    try {
      await runBw(this.binary, ['sync'], this.childEnv());
    } catch {
      // Deliberately swallowed; see above.
    }
    this.synced = true;
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
    const result = await runBw(
      this.binary,
      ['list', 'items', '--url', origin],
      this.childEnv(),
    );
    if (result.code !== 0) {
      throw new VaultError(classify(result), result.stderr.trim() || 'The Bitwarden CLI refused the lookup.');
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
    const result = await runBw(this.binary, ['get', 'item', itemId], this.childEnv());
    if (result.code !== 0) {
      throw new VaultError(classify(result), 'The Bitwarden CLI would not return that item.');
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
    const result = await runBw(this.binary, ['get', 'totp', itemId], this.childEnv());
    if (result.code !== 0) return null;
    const code = result.stdout.trim();
    return code === '' ? null : code;
  }
}
