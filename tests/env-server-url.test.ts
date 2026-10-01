import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SERVER_URL,
  ServePortError,
  readMachineServerUrl,
  resolveServePort,
} from '../src/env/server-url.js';
import { userRootEnvPath, type UserRootDeps } from '../src/env/user-root.js';
import { resolveServerUrl } from '../src/cli/server-target.js';

/**
 * stories/machine-server-url.md — `serve` listens on -p, else the machine
 * SERVER_URL's port, else 3100; `status` / `stop` look in the same order.
 */

const REPO_ROOT = path.resolve(__dirname, '..');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-server-url-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Deps that put the user root inside this test's tmp dir on every platform. */
function deps(): UserRootDeps {
  return { env: { LOCALAPPDATA: tmpDir, XDG_CONFIG_HOME: tmpDir }, platform: process.platform };
}

function writeMachineEnv(content: string): string {
  const envPath = userRootEnvPath(deps());
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content);
  return envPath;
}

describe('resolveServePort', () => {
  it('uses 3100 when nothing says otherwise', () => {
    expect(resolveServePort(undefined, deps())).toEqual({ port: 3100, source: 'the default' });
    expect(DEFAULT_SERVER_URL).toBe('http://127.0.0.1:3100');
  });

  it("takes the machine SERVER_URL's port, and names the file", () => {
    const envPath = writeMachineEnv('SERVER_URL=http://localhost:3200\n');
    expect(resolveServePort(undefined, deps())).toEqual({
      port: 3200,
      source: `SERVER_URL in ${envPath}`,
    });
  });

  it('lets -p win over the machine SERVER_URL', () => {
    writeMachineEnv('SERVER_URL=http://localhost:3200\n');
    expect(resolveServePort(3104, deps())).toEqual({ port: 3104, source: '-p' });
  });

  it('takes only the port: a remote host in SERVER_URL still binds locally on that port', () => {
    writeMachineEnv('SERVER_URL=http://build-box:3300\n');
    expect(resolveServePort(undefined, deps()).port).toBe(3300);
  });

  it('refuses a machine SERVER_URL with no port rather than guessing one', () => {
    const envPath = writeMachineEnv('SERVER_URL=http://localhost\n');
    expect(() => resolveServePort(undefined, deps())).toThrow(ServePortError);
    expect(() => resolveServePort(undefined, deps())).toThrow(envPath);
    expect(() => resolveServePort(undefined, deps())).toThrow(/has no port/);
    // -p needs nothing from the file, so it still works.
    expect(resolveServePort(3104, deps()).port).toBe(3104);
  });

  it('refuses a machine SERVER_URL that is not a URL', () => {
    writeMachineEnv('SERVER_URL=not a url\n');
    expect(() => resolveServePort(undefined, deps())).toThrow(/not a valid URL/);
  });

  it('reads a blank SERVER_URL line as absent', () => {
    writeMachineEnv('SERVER_URL=   \n');
    expect(readMachineServerUrl(deps())).toBeNull();
    expect(resolveServePort(undefined, deps()).port).toBe(3100);
  });
});

describe('resolveServerUrl (status / stop)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['LOCALAPPDATA', 'XDG_CONFIG_HOME']) {
      saved[key] = process.env[key];
      process.env[key] = tmpDir;
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('--url wins', async () => {
    writeMachineEnv('SERVER_URL=http://127.0.0.1:3200\n');
    expect(await resolveServerUrl({ url: 'http://127.0.0.1:4000/' })).toBe('http://127.0.0.1:4000');
  });

  it('then the machine SERVER_URL', async () => {
    writeMachineEnv('SERVER_URL=http://127.0.0.1:3200/\n');
    expect(await resolveServerUrl({})).toBe('http://127.0.0.1:3200');
  });

  it("then 3100 on the config's server.host", async () => {
    const config = path.join(tmpDir, 'steptix.config.json');
    fs.writeFileSync(config, JSON.stringify({ server: { host: '::1' } }));
    expect(await resolveServerUrl({ config })).toBe('http://::1:3100');
  });
});

/**
 * The CLI end to end, because the order is only worth something if `serve`
 * actually binds what it says and dies naming where the port came from.
 * Runs `dist/` — `npm test` builds it first.
 */
describe('steptix serve — port errors', () => {
  function runServe(args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(REPO_ROOT, 'dist', 'index.js'), 'serve', ...args], {
        cwd: tmpDir,
        // The user root in the tmp dir, so a generated key or a pruned stats
        // file never touches the real one.
        env: { ...process.env, LOCALAPPDATA: tmpDir, XDG_CONFIG_HOME: tmpDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (d) => (output += String(d)));
      child.stderr.on('data', (d) => (output += String(d)));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`serve did not exit:\n${output}`));
      }, 30_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }

  it('exits 1 naming the machine .env when the port it names is taken', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const address = blocker.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const envPath = writeMachineEnv(`SERVER_URL=http://127.0.0.1:${port}\n`);
      const { code, output } = await runServe([]);
      expect(code).toBe(1);
      expect(output).toContain(`Port ${port} (from SERVER_URL in ${envPath}) is already in use`);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  }, 40_000);

  it('exits 1 before binding anything when the machine SERVER_URL has no port', async () => {
    const envPath = writeMachineEnv('SERVER_URL=http://127.0.0.1\n');
    const { code, output } = await runServe([]);
    expect(code).toBe(1);
    expect(output).toContain(envPath);
    expect(output).toContain('has no port');
  }, 40_000);
});
