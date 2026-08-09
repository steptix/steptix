import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readMachineKey, userRootEnvPath, MACHINE_KEY_VAR } from '../dist/user-root.js';

function tmpDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-rc-user-root-'));
  return {
    dir,
    deps: { env: { LOCALAPPDATA: dir, XDG_CONFIG_HOME: dir }, platform: process.platform },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('userRootEnvPath: win32 uses LOCALAPPDATA, POSIX uses XDG then ~', () => {
  assert.equal(
    userRootEnvPath({ env: { LOCALAPPDATA: 'C:\\U\\x\\AppData\\Local' }, platform: 'win32' }),
    path.join('C:\\U\\x\\AppData\\Local', 'aiui', '.env'),
  );
  assert.equal(
    userRootEnvPath({ env: { XDG_CONFIG_HOME: '/home/x/.config' }, platform: 'linux' }),
    path.join('/home/x/.config', 'aiui', '.env'),
  );
  assert.equal(
    userRootEnvPath({ env: {}, platform: 'linux', homedir: () => '/home/x' }),
    path.join('/home/x', '.aiui', '.env'),
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
