import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bareServePort,
  chooseServerUrl,
  readMachineKey,
  readMachineServerUrl,
  userRootEnvPath,
  DEFAULT_SERVER_URL,
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

// ---------------------------------------------------------------------------
// The machine's server (stories/machine-server-url.md)
// ---------------------------------------------------------------------------

test('readMachineServerUrl: null when absent or blank, trimmed value when set', () => {
  const { deps, cleanup } = tmpDeps();
  try {
    assert.equal(readMachineServerUrl(deps), null);
    writeMachineEnv(deps, 'SERVER_URL=\n');
    assert.equal(readMachineServerUrl(deps), null);
    writeMachineEnv(deps, 'SERVER_URL=  http://127.0.0.1:3200  \n');
    assert.equal(readMachineServerUrl(deps), 'http://127.0.0.1:3200');
  } finally {
    cleanup();
  }
});

test('the default is 3100 on the address a default serve binds', () => {
  assert.equal(DEFAULT_SERVER_URL, 'http://127.0.0.1:3100');
});

test('bareServePort: 3100 with no machine SERVER_URL, else the port and file of that URL', () => {
  const { deps, cleanup } = tmpDeps();
  try {
    assert.deepEqual(bareServePort(deps), { ok: true, port: 3100, source: 'the default' });
    const envPath = writeMachineEnv(deps, 'SERVER_URL=http://localhost:3200\n');
    assert.deepEqual(bareServePort(deps), {
      ok: true,
      port: 3200,
      source: `SERVER_URL in ${envPath}`,
    });
  } finally {
    cleanup();
  }
});

test('bareServePort: a machine SERVER_URL with no port, or not a URL, is a refusal naming the file', () => {
  const { deps, cleanup } = tmpDeps();
  try {
    const envPath = writeMachineEnv(deps, 'SERVER_URL=http://localhost\n');
    const noPort = bareServePort(deps);
    assert.equal(noPort.ok, false);
    assert.match(noPort.reason, /has no port/);
    assert.ok(noPort.reason.includes(envPath));

    writeMachineEnv(deps, 'SERVER_URL=localhost 3100\n');
    const notUrl = bareServePort(deps);
    assert.equal(notUrl.ok, false);
    assert.match(notUrl.reason, /not a valid URL/);
  } finally {
    cleanup();
  }
});

test('chooseServerUrl: the project wins, then the machine .env, then the default', () => {
  const { deps, cleanup } = tmpDeps();
  try {
    const projectEnv = path.join(path.resolve(path.sep, 'proj'), '.env');

    assert.deepEqual(chooseServerUrl({}, null, deps), {
      serverUrl: 'http://127.0.0.1:3100',
      source: 'the default',
      path: null,
    });

    const machineEnv = writeMachineEnv(deps, 'SERVER_URL=http://127.0.0.1:3200\n');
    assert.deepEqual(chooseServerUrl({}, null, deps), {
      serverUrl: 'http://127.0.0.1:3200',
      source: `SERVER_URL in ${machineEnv}`,
      path: machineEnv,
    });

    // A project .env without SERVER_URL still falls through to the machine one.
    assert.equal(chooseServerUrl({ AI_MODEL: 'm' }, projectEnv, deps).serverUrl, 'http://127.0.0.1:3200');

    assert.deepEqual(chooseServerUrl({ SERVER_URL: ' http://localhost:3104 ' }, projectEnv, deps), {
      serverUrl: 'http://localhost:3104',
      source: `SERVER_URL in ${projectEnv}`,
      path: projectEnv,
    });
  } finally {
    cleanup();
  }
});
