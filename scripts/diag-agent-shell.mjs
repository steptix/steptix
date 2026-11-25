// TEMPORARY diagnostic for PR #127's Windows CI timeouts. Not for main.
// Round 2: where the Add-Type preamble's time goes, whether the environment or
// the moment decides it, and what a precompiled DLL costs instead.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubbedEnv, shellFor } from '../dist/agent/commands.js';

const label = process.argv[2] ?? 'run';
const scrubbed = scrubbedEnv(process.env);
const MARK = '__STEPTIX_DIAG_CMD__';
const full = shellFor('win32').args(MARK).at(-1);
const preamble = full.slice(0, full.indexOf(MARK));
const source = preamble.slice(preamble.indexOf("@'\n") + 3, preamble.indexOf("\n'@"));

// Names only, never values: which variables the scrub drops.
const dropped = Object.keys(process.env).filter((k) => !(k in scrubbed)).sort();
console.log(`${label} | dropped by scrub: ${dropped.join(' ')}`);

function time(args, env) {
  return new Promise((resolve) => {
    const t = Date.now();
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ ms: Date.now() - t, code, out: out.trim().replace(/\s+/g, ' ').slice(0, 300) }));
  });
}
// Milliseconds since this PowerShell process started, at three points.
const since = (tag) => `Write-Output ("${tag}=" + [int]((Get-Date) - (Get-Process -Id $PID).StartTime).TotalMilliseconds)`;
const inline = `${since('start')}\n${preamble}\n${since('after_addtype')}\nnode -e 0\n${since('end')}`;

const dll = path.join(os.tmpdir(), `steptix-diag-job-${process.pid}.dll`);
const compile = `${since('start')}\nAdd-Type -TypeDefinition @'\n${source}\n'@ -OutputAssembly '${dll}' -OutputType Library\n${since('compiled')}`;
const precompiled = `${since('start')}\ntry { Add-Type -Path '${dll}'; [SteptixAgentJob]::Enter() } catch { Write-Output "ERR $_" }\n${since('after_load')}\nnode -e 0\n${since('end')}`;

const rows = [];
const run = async (name, script, env) => {
  const r = await time(script, env);
  rows.push(r);
  console.log(`${label} | ${name} | wall ${r.ms} ms | code ${r.code} | ${r.out}`);
};

// Alternate the two environments, so the moment and the environment come apart.
for (let i = 0; i < 4; i++) {
  await run('inline Add-Type, scrubbed env', inline, scrubbed);
  await run('inline Add-Type, full env', inline, process.env);
}
await run('compile once to a DLL, scrubbed env', compile, scrubbed);
console.log(`${label} | dll exists: ${fs.existsSync(dll)}`);
for (let i = 0; i < 4; i++) {
  await run('load precompiled DLL, scrubbed env', precompiled, scrubbed);
  await run('load precompiled DLL, full env', precompiled, process.env);
}
for (let i = 0; i < 2; i++) await run('inline Add-Type, scrubbed env (again)', inline, scrubbed);
