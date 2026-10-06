import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bareServePort,
  readMachineKey,
  readMachineServerUrl,
  userRootDir,
  userRootEnvExposed,
  userRootEnvPath,
  MACHINE_KEY_VAR,
} from '../dist/user-root.js';

function tmpDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-rc-user-root-'));
  return {
    dir,
    deps: { env: { LOCALAPPDATA: dir, XDG_CONFIG_HOME: dir }, platform: process.platform },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Write the user root's `.env` for `deps`. */
function writeMachineEnv(deps, content) {
  const envPath = userRootEnvPath(deps);
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content);
  return envPath;
}

test('userRootEnvPath: win32 uses LOCALAPPDATA, POSIX uses XDG then ~', () => {
  assert.equal(
    userRootEnvPath({ env: { LOCALAPPDATA: 'C:\\U\\x\\AppData\\Local' }, platform: 'win32' }),
    path.join('C:\\U\\x\\AppData\\Local', 'steptix', '.env'),
  );
  assert.equal(
    userRootEnvPath({ env: { XDG_CONFIG_HOME: '/home/x/.config' }, platform: 'linux' }),
    path.join('/home/x/.config', 'steptix', '.env'),
  );
  assert.equal(
    userRootEnvPath({ env: {}, platform: 'linux', homedir: () => '/home/x' }),
    path.join('/home/x', '.steptix', '.env'),
  );
});

test('readMachineKey: null when absent, trimmed value when present', () => {
  const { deps, cleanup } = tmpDeps();
  try {
    assert.equal(readMachineKey(deps), null);

    const envPath = userRootEnvPath(deps);
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `# generated\n${MACHINE_KEY_VAR}=  abc123  \n`);
    assert.equal(readMachineKey(deps), 'abc123');
  } finally {
    cleanup();
  }
});

test('readMachineKey: a blanked-out line reads as absent, never the empty string', () => {
  const { deps, cleanup } = tmpDeps();
  try {
    const envPath = userRootEnvPath(deps);
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `${MACHINE_KEY_VAR}=\nAI_MODEL=m\n`);
    assert.equal(readMachineKey(deps), null);
  } finally {
    cleanup();
  }
});

test('userRootDir: the folder the .env sits in, which runtimes/ sits beside', () => {
  const localAppData = path.resolve(path.sep, 'lad');
  const deps = { env: { LOCALAPPDATA: localAppData }, platform: 'win32' };
  assert.equal(userRootDir(deps), path.join(localAppData, 'steptix'));
  assert.equal(userRootEnvPath(deps), path.join(userRootDir(deps), '.env'));
});

test('readMachineServerUrl: read from the same file as the key, trimmed, blank is absent', () => {
  const { deps, cleanup } = tmpDeps();
  try {
    assert.equal(readMachineServerUrl(deps), null, 'no file');

    const envPath = userRootEnvPath(deps);
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `${MACHINE_KEY_VAR}=k\n`);
    assert.equal(readMachineServerUrl(deps), null, 'a file with only the key');

    fs.writeFileSync(envPath, `${MACHINE_KEY_VAR}=k\nSTEPTIX_SERVER_URL=  http://127.0.0.1:3200  \n`);
    assert.equal(readMachineServerUrl(deps), 'http://127.0.0.1:3200');

    fs.writeFileSync(envPath, 'STEPTIX_SERVER_URL=\n');
    assert.equal(readMachineServerUrl(deps), null, 'a blanked-out line');
  } finally {
    cleanup();
  }
});

test('readMachineServerUrl: an unreadable file throws rather than reading as absent', () => {
  const { deps, cleanup } = tmpDeps();
  try {
    // A folder where the file should be is a portable EISDIR.
    fs.mkdirSync(userRootEnvPath(deps), { recursive: true });
    assert.throws(() => readMachineServerUrl(deps), { code: 'EISDIR' });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Where a bare `serve` listens (stories/machine-server-url.md)
// ---------------------------------------------------------------------------

test('bareServePort: 3100 with no machine STEPTIX_SERVER_URL, else the port and file of that URL', () => {
  const { deps, cleanup } = tmpDeps();
  try {
    assert.deepEqual(bareServePort(deps), { ok: true, port: 3100, source: 'the default' });
    const envPath = writeMachineEnv(deps, 'STEPTIX_SERVER_URL=http://localhost:3200\n');
    assert.deepEqual(bareServePort(deps), {
      ok: true,
      port: 3200,
      source: `STEPTIX_SERVER_URL in ${envPath}`,
    });
  } finally {
    cleanup();
  }
});

test('bareServePort: a machine STEPTIX_SERVER_URL with no port, or not a URL, is a refusal naming the file', () => {
  const { deps, cleanup } = tmpDeps();
  try {
    const envPath = writeMachineEnv(deps, 'STEPTIX_SERVER_URL=http://localhost\n');
    const noPort = bareServePort(deps);
    assert.equal(noPort.ok, false);
    assert.match(noPort.reason, /has no port/);
    assert.ok(noPort.reason.includes(envPath));

    writeMachineEnv(deps, 'STEPTIX_SERVER_URL=localhost 3100\n');
    const notUrl = bareServePort(deps);
    assert.equal(notUrl.ok, false);
    assert.match(notUrl.reason, /not a valid URL/);
  } finally {
    cleanup();
  }
});

// The machine .env holds the server key and usually AI_API_KEY, so Steptix
// says `chmod 600` when other local users can read it (Linux and macOS only).
test('userRootEnvExposed: true only for a .env other users can read, never on Windows', { skip: process.platform === 'win32' }, () => {
  const { deps, cleanup } = tmpDeps();
  try {
    assert.equal(userRootEnvExposed(deps), false, 'absent file');
    const envPath = writeMachineEnv(deps, 'AI_API_KEY=k\n');
    fs.chmodSync(envPath, 0o644);
    assert.equal(userRootEnvExposed(deps), true, '0644');
    fs.chmodSync(envPath, 0o600);
    assert.equal(userRootEnvExposed(deps), false, '0600');
    assert.equal(userRootEnvExposed({ ...deps, platform: 'win32' }), false, 'win32 is never exposed');
  } finally {
    cleanup();
  }
});

test('userRootEnvExposed: Windows reports nothing, whatever the file looks like', { skip: process.platform !== 'win32' }, () => {
  const { deps, cleanup } = tmpDeps();
  try {
    writeMachineEnv(deps, 'AI_API_KEY=k\n');
    assert.equal(userRootEnvExposed(deps), false);
  } finally {
    cleanup();
  }
});
