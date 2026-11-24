import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  commandParts,
  hasSubstitution,
  programName,
  uncheckableReason,
  isGlobalInstall,
  matchesPattern,
  matchingPattern,
  normaliseCommand,
  patternFor,
  runCommand,
  scrubbedEnv,
  secretEnvName,
} from '../src/agent/commands.js';
import { RunApprovals } from '../src/agent/approvals.js';
import { createWorkspace, displayPath, resolveAgentPath, whereOf } from '../src/agent/workspace.js';
import { decodeText } from '../src/agent/runner.js';
import { discoverSkills, findSkill, loadSkillBody } from '../src/agent/skills.js';

/**
 * Commands, the workspace and agent skills (docs/specs/SPEC-use-agent.md
 * §6, §7). Constructed cases throughout: they show what Steptix does with a
 * command, not what a model sends.
 */

describe('the allow list (§6.3)', () => {
  it('matches on the program name, so a venv path is the same program', () => {
    expect(normaliseCommand('.venv/Scripts/pip.exe install openpyxl')).toBe('pip install openpyxl');
    expect(matchesPattern('.venv/Scripts/pip install openpyxl', 'pip install *')).toBe(true);
    expect(matchesPattern('.venv/bin/python convert.py', 'python *')).toBe(true);
  });

  it('`node *` matches a bare `node` and not `nodemon`', () => {
    expect(matchesPattern('node', 'node *')).toBe(true);
    expect(matchesPattern('nodemon app.js', 'node *')).toBe(false);
  });

  it('the first matching pattern is named', () => {
    expect(matchingPattern('npm install left-pad', ['node *', 'npm install *'])).toBe('npm install *');
    expect(matchingPattern('curl https://x', ['node *'])).toBeUndefined();
  });

  it('a "for this run" pattern is the program plus a plain subcommand', () => {
    expect(patternFor('pip install openpyxl')).toBe('pip install *');
    expect(patternFor('npm install --save x')).toBe('npm install *');
    expect(patternFor('python convert.py a.csv')).toBe('python *');
    expect(patternFor('node --version')).toBe('node *');
    expect(patternFor('.venv/Scripts/python -m venv .venv')).toBe('python *');
  });

  it('each part of a joined command is checked on its own', () => {
    expect(commandParts('python a.py && del /q x; echo hi | more')).toEqual(['python a.py', 'del /q x', 'echo hi', 'more']);
    expect(commandParts('git status || echo no')).toEqual(['git status', 'echo no']);
    expect(hasSubstitution('python $(whoami).py')).toBe(true);
    expect(hasSubstitution('python `whoami`.py')).toBe(true);
    expect(hasSubstitution('python a.py')).toBe(false);
  });

  it('a separator inside quotes does not split the command', () => {
    expect(commandParts('python -c "import sys; print(1)"')).toEqual(['python -c "import sys; print(1)"']);
    expect(uncheckableReason("node -e 'a(); b()'")).toBeUndefined();
  });

  it('what cannot be checked part by part is refused', () => {
    // A bare carriage return is a new statement in PowerShell.
    expect(uncheckableReason('git status\rRemove-Item -Recurse x')).toMatch(/carriage return/);
    // A subexpression, script block or subshell runs a command inside the part.
    expect(uncheckableReason('git status (Remove-Item x)')).toMatch(/"\(" outside quotes/);
    expect(uncheckableReason('git status @(Remove-Item x)')).toMatch(/"\(" outside quotes/);
    expect(uncheckableReason('git status { rm x }')).toMatch(/"\{" outside quotes/);
    // sh's background separator and PowerShell's call operator.
    expect(uncheckableReason('git status & rm -rf x')).toMatch(/single "&"/);
    // …but redirections are fine.
    expect(uncheckableReason('python a.py > out.txt 2>&1')).toBeUndefined();
    // $(…) runs inside double quotes too.
    expect(uncheckableReason('echo "$(whoami)"')).toMatch(/\$\(…\)/);
    expect(uncheckableReason('echo "unclosed')).toMatch(/unclosed quote/);
    // PowerShell reads typographic quotes as quotes; the scanner does not.
    expect(uncheckableReason("git status '\u2019 ; Remove-Item x ; \u2018'")).toMatch(/typographic quote/);
  });

  it('on Linux and macOS a backslash or $\'…\' is refused; on Windows a backslash is a path', () => {
    // sh: \' is not a quote, so this would run rm.
    expect(uncheckableReason("python a.py \\' && rm -rf x #'", 'linux')).toMatch(/backslash/);
    expect(uncheckableReason("echo $'a\\'b'", 'darwin')).toBeDefined();
    expect(uncheckableReason('.venv\\Scripts\\pip install openpyxl', 'win32')).toBeUndefined();
  });

  it('a program in a path is the program only in an installer\'s bin folder', () => {
    expect(programName('.venv/Scripts/pip.exe')).toBe('pip');
    expect(programName('venv/bin/python')).toBe('python');
    expect(programName('node_modules/.bin/tsc')).toBe('tsc');
    // A file the agent wrote and named after an allowed program is not it.
    expect(programName('./git.cmd')).toBe('./git.cmd');
    expect(programName('tools/git')).toBe('tools/git');
    expect(matchesPattern('./git.cmd status', 'git status *')).toBe(false);
    expect(matchesPattern('tools/git status', 'git status *')).toBe(false);
  });

  it('a global install is refused, a workspace install is not', () => {
    expect(isGlobalInstall('npm install -g typescript')).toBe(true);
    expect(isGlobalInstall('npm i --global x')).toBe(true);
    expect(isGlobalInstall('npm install --location=global x')).toBe(true);
    expect(isGlobalInstall('yarn global add x')).toBe(true);
    expect(isGlobalInstall('npm install xlsx')).toBe(false);
    expect(isGlobalInstall('pip install openpyxl')).toBe(false);
  });
});

describe('remembered answers (§6.3)', () => {
  it('an answer for the rest of the run covers its pattern, and a deny wins', () => {
    const approvals = new RunApprovals();
    approvals.remember('allow-run', 'curl *', 2);
    expect(approvals.remembered('curl https://example.test')).toEqual({ allow: true, pattern: 'curl *' });
    approvals.remember('deny-run', 'curl *', 3);
    expect(approvals.remembered('curl https://example.test')?.allow).toBe(false);
    expect(approvals.records.map((r) => r.answer)).toEqual(['allow-run', 'deny-run']);
  });

  it('an unanswered question is recorded and stops later questions', () => {
    const approvals = new RunApprovals();
    approvals.markUnanswered('curl *', 1);
    expect(approvals.unanswered).toBe(true);
    expect(approvals.records[0]).toMatchObject({ pattern: 'curl *', answer: 'unanswered', step: 1 });
  });
});

describe('what a command can see (§6.4)', () => {
  it('keeps what a program needs, withholds Steptix\'s keys, and adds the venv rule', () => {
    const env = scrubbedEnv({
      PATH: '/bin',
      HOME: '/home/a',
      STEPTIX_SERVER_API_KEY: 'scrub-test-key',
      AI_API_KEY: 'scrub-test-ai-key',
      SOME_OTHER: 'x',
    });
    expect(env['PATH']).toBe('/bin');
    expect(env['HOME']).toBe('/home/a');
    expect(env['STEPTIX_SERVER_API_KEY']).toBeUndefined();
    expect(env['AI_API_KEY']).toBeUndefined();
    expect(env['SOME_OTHER']).toBeUndefined();
    expect(env['PIP_REQUIRE_VIRTUALENV']).toBe('1');
  });

  it('hands a secret over by name', () => {
    expect(secretEnvName('api_token')).toBe('STEPTIX_SECRET_API_TOKEN');
    expect(secretEnvName('row.key')).toBe('STEPTIX_SECRET_ROW_KEY');
    const env = scrubbedEnv({}, { api_token: 'scrub-test-token' });
    expect(env['STEPTIX_SECRET_API_TOKEN']).toBe('scrub-test-token');
  });
});

describe('running a command (§6.3, §6.5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-commands-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('runs in the given folder and reports the exit code and output', async () => {
    fs.writeFileSync(path.join(dir, 'hello.cjs'), 'console.log("cwd=" + process.cwd()); process.exit(3);');
    const run = await runCommand({ command: 'node hello.cjs', cwd: dir, env: scrubbedEnv(process.env), timeoutMs: 60_000 });
    expect(run.exitCode).toBe(3);
    const cwd = /cwd=(.*)/.exec(run.output)?.[1]?.trim();
    // `.native` expands a Windows 8.3 short name (a TEMP of C:UsersABCDEF~1…)
    // and resolves the macOS /var → /private/var link, so the two compare.
    expect(cwd && fs.realpathSync.native(cwd)).toBe(fs.realpathSync.native(dir));
  });

  it('stopping kills the whole tree, including a child that outlives its parent', async () => {
    // The parent starts a grandchild that records its pid and lives forever.
    // Killing only the shell would leave the grandchild running.
    const pidFile = path.join(dir, 'grandchild.pid');
    fs.writeFileSync(
      path.join(dir, 'grandchild.cjs'),
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    fs.writeFileSync(
      path.join(dir, 'parent.cjs'),
      "require('child_process').spawn(process.execPath, ['grandchild.cjs'], { stdio: 'ignore' }); setInterval(() => {}, 1000);",
    );
    const controller = new AbortController();
    const pending = runCommand({
      command: 'node parent.cjs',
      cwd: dir,
      env: scrubbedEnv(process.env),
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Wait on the condition — the grandchild has started — with a ceiling.
    const startBy = Date.now() + 30_000;
    while (!fs.existsSync(pidFile) && Date.now() < startBy) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    controller.abort();
    expect((await pending).stopped).toBe('aborted');
    // …and on the next condition: the grandchild has gone.
    const goneBy = Date.now() + 30_000;
    while (alive(pid) && Date.now() < goneBy) await new Promise((r) => setTimeout(r, 50));
    const stillAlive = alive(pid);
    if (stillAlive) process.kill(pid);
    expect(stillAlive).toBe(false);
  }, 70_000);

  // Windows only: a DETACHED child escapes a POSIX process group (setsid), and
  // nothing in Steptix can reach it there — §16.1 records that. On Windows it
  // stays in the shell's Job Object. The POSIX counterpart is the next case.
  it.runIf(process.platform === 'win32')('a detached child that outlives the shell and holds its output does not hang the command', async () => {
    // The shell's own program exits at once, leaving a detached child holding
    // the output pipe open for ever. The command must still settle, and the
    // child must not survive it.
    const pidFile = path.join(dir, 'orphan.pid');
    fs.writeFileSync(
      path.join(dir, 'orphan.cjs'),
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    fs.writeFileSync(
      path.join(dir, 'launch.cjs'),
      "require('child_process').spawn(process.execPath, ['orphan.cjs'], { stdio: 'inherit', detached: true }).unref();" +
        " const t = Date.now(); while (!require('fs').existsSync('orphan.pid') && Date.now() - t < 20000) {}",
    );
    const run = await runCommand({ command: 'node launch.cjs', cwd: dir, env: scrubbedEnv(process.env), timeoutMs: 60_000 });
    expect(run.stopped).toBeUndefined();
    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = (p: number): boolean => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    const goneBy = Date.now() + 30_000;
    while (alive(pid) && Date.now() < goneBy) await new Promise((r) => setTimeout(r, 50));
    const stillAlive = alive(pid);
    if (stillAlive) process.kill(pid);
    expect(stillAlive).toBe(false);
  }, 90_000);

  it.runIf(process.platform !== 'win32')('a child left running when the shell exits is killed with its group', async () => {
    const pidFile = path.join(dir, 'left.pid');
    fs.writeFileSync(
      path.join(dir, 'left.cjs'),
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    // The child inherits the output pipe and is not detached, so it stays in
    // the shell's group after its parent exits.
    fs.writeFileSync(
      path.join(dir, 'launch.cjs'),
      "require('child_process').spawn(process.execPath, ['left.cjs'], { stdio: 'inherit' }).unref();" +
        " const t = Date.now(); while (!require('fs').existsSync('left.pid') && Date.now() - t < 20000) {}",
    );
    const run = await runCommand({ command: 'node launch.cjs', cwd: dir, env: scrubbedEnv(process.env), timeoutMs: 60_000 });
    expect(run.stopped).toBeUndefined();
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = (p: number): boolean => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    const goneBy = Date.now() + 30_000;
    while (alive(pid) && Date.now() < goneBy) await new Promise((r) => setTimeout(r, 50));
    const stillAlive = alive(pid);
    if (stillAlive) process.kill(pid);
    expect(stillAlive).toBe(false);
  }, 90_000);

  it('an abort stops the command', async () => {
    fs.writeFileSync(path.join(dir, 'forever.cjs'), 'setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const pending = runCommand({ command: 'node forever.cjs', cwd: dir, env: scrubbedEnv(process.env), timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    const run = await pending;
    expect(run.stopped).toBe('aborted');
  }, 20_000);
});

describe('the workspace (§6.2)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('reaches the workspace and agent.folders, and nothing else', () => {
    const ws = createWorkspace({ projectRoot: root, runId: 'run-1', folders: ['exports'], skillsDir: '.agents/skills' });
    expect(resolveAgentPath(ws, 'convert.py', 'write')).toMatchObject({ ok: true, where: 'workspace' });
    expect(resolveAgentPath(ws, path.join(root, 'exports', 'orders.xlsx'), 'write')).toMatchObject({ ok: true, where: 'exports' });
    const outside = resolveAgentPath(ws, path.join(root, 'secrets.txt'), 'read');
    expect(outside.ok).toBe(false);
    expect(outside.ok === false && outside.reason).toMatch(/agent\.folders/);
    expect(resolveAgentPath(ws, '../../escape.txt', 'read').ok).toBe(false);
  });

  it('a folder outside the project is shown by its own name, never a ".." path', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outside-'));
    try {
      const ws = createWorkspace({ projectRoot: root, runId: 'run-3', folders: [outside] });
      const file = path.join(outside, 'sub', 'a.csv');
      expect(displayPath(ws, file)).toBe(`${path.basename(outside)}/sub/a.csv`);
      expect(whereOf(ws, file)).toBe(path.basename(outside));
      expect(displayPath(ws, file).startsWith('..')).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('a symlink inside the workspace cannot point outside it', () => {
    const ws = createWorkspace({ projectRoot: root, runId: 'run-4', folders: [] });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-link-target-'));
    try {
      try {
        fs.symlinkSync(target, path.join(ws.dir, 'link'), 'junction');
      } catch {
        return; // no permission to make a link on this machine; nothing to test
      }
      expect(resolveAgentPath(ws, 'link/secret.txt', 'read').ok).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('write_file cannot put a program in an installer\'s bin folder', () => {
    const ws = createWorkspace({ projectRoot: root, runId: 'run-5', folders: [] });
    expect(resolveAgentPath(ws, '.venv/Scripts/git.cmd', 'write').ok).toBe(false);
    expect(resolveAgentPath(ws, 'node_modules/.bin/git', 'write').ok).toBe(false);
    expect(resolveAgentPath(ws, '.venv/Scripts/git.cmd', 'read').ok).toBe(true);
    expect(resolveAgentPath(ws, 'scripts/convert.py', 'write').ok).toBe(true);
  });

  it('the skills folder is readable and not writable', () => {
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'x'), { recursive: true });
    const ws = createWorkspace({ projectRoot: root, runId: 'run-2', folders: [], skillsDir: '.agents/skills' });
    const file = path.join(root, '.agents', 'skills', 'x', 'SKILL.md');
    expect(resolveAgentPath(ws, file, 'read').ok).toBe(true);
    expect(resolveAgentPath(ws, file, 'write').ok).toBe(false);
  });
});

describe('text in other encodings (§8.5)', () => {
  it('UTF-16 with a byte order mark is text, so it can be read and masked', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('token=abc', 'utf16le')]);
    expect(decodeText(le)).toBe('token=abc');
    const be = Buffer.from(le.subarray(2));
    be.swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('token=abc');
    expect(decodeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBeUndefined();
    // A UTF-16 BE file of odd length: the stray byte is dropped, not thrown on.
    expect(decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00]))).toBe('A');
  });
});

describe('agent skills (§7)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('finds each SKILL.md with a description, skips one without, and loads a body', () => {
    fs.mkdirSync(path.join(dir, 'ledger-export'));
    fs.writeFileSync(
      path.join(dir, 'ledger-export', 'SKILL.md'),
      '---\nname: ledger-export\ndescription: How to export a ledger.\n---\nThe wizard has four pages.\n',
    );
    fs.mkdirSync(path.join(dir, 'no-desc'));
    fs.writeFileSync(path.join(dir, 'no-desc', 'SKILL.md'), '---\nname: no-desc\n---\nBody.\n');
    const found = discoverSkills(dir);
    expect(found.skills.map((s) => s.name)).toEqual(['ledger-export']);
    expect(found.warnings).toHaveLength(1);
    expect(found.warnings[0]).toMatch(/no description/);
    expect(loadSkillBody(findSkill(found.skills, 'LEDGER-EXPORT')!)).toBe('The wizard has four pages.');
  });

  it('a missing folder is no skills and no warning', () => {
    expect(discoverSkills(path.join(dir, 'absent'))).toEqual({ skills: [], warnings: [] });
  });
});
