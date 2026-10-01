import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readMachineKey,
  readMachineServerUrl,
  userRootDir,
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

    fs.writeFileSync(envPath, `${MACHINE_KEY_VAR}=k\nSERVER_URL=  http://127.0.0.1:3200  \n`);
    assert.equal(readMachineServerUrl(deps), 'http://127.0.0.1:3200');

    fs.writeFileSync(envPath, 'SERVER_URL=\n');
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
