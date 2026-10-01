import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MACHINE_KEY_VAR,
  ensureMachineKey,
  readMachineKey,
  readUserRootEnv,
  userRootDir,
  userRootEnvPath,
  type UserRootDeps,
} from '../src/env/user-root.js';
import { logger } from '../src/utils/logger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-user-root-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Deps that put the user root inside this test's tmp dir on every platform. */
function deps(): UserRootDeps {
  return { env: { LOCALAPPDATA: tmpDir, XDG_CONFIG_HOME: tmpDir }, platform: process.platform };
}

describe('userRootDir', () => {
  it('win32: LOCALAPPDATA\\steptix', () => {
    const dir = userRootDir({ env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, platform: 'win32' });
    expect(dir).toBe(path.join('C:\\Users\\x\\AppData\\Local', 'steptix'));
  });

  it('win32 without LOCALAPPDATA falls back to the home directory shape', () => {
    const dir = userRootDir({ env: {}, platform: 'win32', homedir: () => 'C:\\Users\\x' });
    expect(dir).toBe(path.join('C:\\Users\\x', 'AppData', 'Local', 'steptix'));
  });

  it('POSIX: $XDG_CONFIG_HOME/steptix when set', () => {
    const dir = userRootDir({ env: { XDG_CONFIG_HOME: '/home/x/.config' }, platform: 'linux' });
    expect(dir).toBe(path.join('/home/x/.config', 'steptix'));
  });

  it('POSIX: ~/.steptix when XDG_CONFIG_HOME is unset or blank', () => {
    for (const env of [{}, { XDG_CONFIG_HOME: '  ' }]) {
      const dir = userRootDir({ env, platform: 'linux', homedir: () => '/home/x' });
      expect(dir).toBe(path.join('/home/x', '.steptix'));
    }
  });
});

describe('readUserRootEnv', () => {
  it('absent file reads as {}', () => {
    expect(readUserRootEnv(deps())).toEqual({});
  });

  it('parses an existing file', () => {
    fs.mkdirSync(path.join(tmpDir, 'steptix'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'steptix', '.env'), 'AI_MODEL=m1\n');
    expect(readUserRootEnv(deps())).toEqual({ AI_MODEL: 'm1' });
  });
});

describe('ensureMachineKey', () => {
  it('creates directory, file and key when nothing exists', () => {
    const result = ensureMachineKey(deps());

    expect(result.created).toBe(true);
    expect(result.key).toMatch(/^steptix_[0-9a-f]{64}$/);
    expect(result.path).toBe(userRootEnvPath(deps()));
    expect(fs.readFileSync(result.path, 'utf-8')).toContain(`${MACHINE_KEY_VAR}=${result.key}`);
  });

  it('a second call reuses the key rather than regenerating', () => {
    const first = ensureMachineKey(deps());
    const second = ensureMachineKey(deps());

    expect(second.created).toBe(false);
    expect(second.key).toBe(first.key);
  });

  it('appends to an existing file without touching the user\'s own lines', () => {
    const envPath = userRootEnvPath(deps());
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    // Deliberately no trailing newline: the append must supply the joiner.
    fs.writeFileSync(envPath, 'AI_API_KEY=sk-real\nAI_MODEL=m1');

    const result = ensureMachineKey(deps());
    const content = fs.readFileSync(envPath, 'utf-8');

    expect(result.created).toBe(true);
    expect(content).toContain('AI_API_KEY=sk-real\nAI_MODEL=m1');
    const parsed = readUserRootEnv(deps());
    expect(parsed['AI_API_KEY']).toBe('sk-real');
    expect(parsed['AI_MODEL']).toBe('m1');
    expect(parsed[MACHINE_KEY_VAR]).toBe(result.key);
  });

  it('never rewrites an existing key', () => {
    const envPath = userRootEnvPath(deps());
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `${MACHINE_KEY_VAR}=typed-by-hand\n`);
    const before = fs.readFileSync(envPath, 'utf-8');

    const result = ensureMachineKey(deps());

    expect(result).toEqual({ key: 'typed-by-hand', created: false, path: envPath });
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(before);
  });

  it('treats a blanked-out key line as absent, and the appended key wins the parse', () => {
    const envPath = userRootEnvPath(deps());
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `${MACHINE_KEY_VAR}=\n`);

    const result = ensureMachineKey(deps());

    expect(result.created).toBe(true);
    // parseEnvFile is last-write-wins, so the appended line is the value read back.
    expect(readMachineKey(deps())).toBe(result.key);
  });
});

describe('readMachineKey', () => {
  it('null when the file is absent, trimmed when present', () => {
    expect(readMachineKey(deps())).toBe(null);

    const envPath = userRootEnvPath(deps());
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `${MACHINE_KEY_VAR}=  spaced-key  \n`);
    expect(readMachineKey(deps())).toBe('spaced-key');
  });
});

/**
 * The user root holds the server key, usually AI_API_KEY and signed-in browser
 * profiles, so it is private to its owner (stories/machine-server-url.md).
 * Windows gets that from %LOCALAPPDATA%; elsewhere the framework sets modes.
 */
describe('user root permissions', () => {
  const posix = process.platform !== 'win32';
  const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

  /** A hand-made .env, the way an editor or a shell redirect leaves it. */
  function writeLooseEnv(content: string): string {
    const envPath = userRootEnvPath(deps());
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, content);
    fs.chmodSync(envPath, 0o644);
    return envPath;
  }

  /** `logger.warn` lines naming `envPath`, collected while `fn` runs. */
  function warningsAbout(envPath: string, fn: () => void): string[] {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      fn();
      return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(envPath));
    } finally {
      warn.mockRestore();
    }
  }

  it.runIf(posix)('ensureMachineKey creates the root 0700 and the .env 0600', () => {
    const { path: envPath } = ensureMachineKey(deps());
    expect(modeOf(path.dirname(envPath))).toBe(0o700);
    expect(modeOf(envPath)).toBe(0o600);
  });

  it.runIf(posix)('ensureMachineKey tightens a hand-made .env before adding the key to it', () => {
    const envPath = writeLooseEnv('AI_MODEL=m\n');
    warningsAbout(envPath, () => ensureMachineKey(deps()));
    expect(modeOf(envPath)).toBe(0o600);
    expect(fs.readFileSync(envPath, 'utf-8')).toContain('AI_MODEL=m');
  });

  it.runIf(posix)('reading a .env other users can read warns once, naming the chmod', () => {
    const envPath = writeLooseEnv('AI_API_KEY=k\n');
    const said = warningsAbout(envPath, () => {
      readUserRootEnv(deps());
      readUserRootEnv(deps());
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`chmod 600 "${envPath}"`);
  });

  it.runIf(posix)('a private .env reads without a warning', () => {
    const envPath = writeLooseEnv('AI_API_KEY=k\n');
    fs.chmodSync(envPath, 0o600);
    expect(warningsAbout(envPath, () => readUserRootEnv(deps()))).toHaveLength(0);
  });

  it.runIf(!posix)('Windows: %LOCALAPPDATA% is already private, so reading never warns', () => {
    const envPath = writeLooseEnv('AI_API_KEY=k\n');
    expect(warningsAbout(envPath, () => readUserRootEnv(deps()))).toHaveLength(0);
  });
});
