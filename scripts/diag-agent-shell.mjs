// TEMPORARY diagnostic for PR #127's Windows CI timeouts. Not for main.
// Round 3: is the 12-22 s first-cmdlet cost the scrub dropping PSModulePath?
import { spawn } from 'node:child_process';
import os from 'node:os';
import { scrubbedEnv, shellFor } from '../dist/agent/commands.js';

const label = process.argv[2] ?? 'run';
const scrubbed = scrubbedEnv(process.env);
const MARK = '__STEPTIX_DIAG_CMD__';
const full = shellFor('win32').args(MARK).at(-1);
const preamble = full.slice(0, full.indexOf(MARK));

// Names only, never values, except PSModulePath, which is folder paths.
const dropped = Object.keys(process.env).filter((k) => !(k in scrubbed)).sort();
console.log(`${label} | dropped by scrub (${dropped.length}): ${dropped.join(' ')}`);
const psKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PSMODULEPATH');
console.log(`${label} | PSModulePath key: ${psKey} = ${psKey ? process.env[psKey] : '(none)'}`);

const withKeys = (keys) => {
  const env = { ...scrubbed };
  for (const k of Object.keys(process.env)) if (keys.includes(k.toUpperCase())) env[k] = process.env[k];
  return env;
};
const envs = {
  scrubbed,
  'scrubbed + PSModulePath': withKeys(['PSMODULEPATH']),
  'scrubbed + every PS*': withKeys(Object.keys(process.env).map((k) => k.toUpperCase()).filter((k) => k.startsWith('PS'))),
  'scrubbed + every dropped var except PSModulePath': withKeys(dropped.map((k) => k.toUpperCase()).filter((k) => k !== 'PSMODULEPATH')),
  full: process.env,
};

function time(script, env) {
  return new Promise((resolve) => {
    const t = Date.now();
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ ms: Date.now() - t, code, out: out.trim().replace(/\s+/g, ' ').slice(0, 200) }));
  });
}
const scripts = {
  'one cmdlet (Get-Date)': 'Get-Date | Out-Null',
  'the real preamble + node': `${preamble}\nnode -e 0`,
  'no cmdlet ([DateTime]::Now)': '[DateTime]::Now | Out-Null',
};
for (const [sname, script] of Object.entries(scripts)) {
  for (const [ename, env] of Object.entries(envs)) {
    const ms = [];
    for (let i = 0; i < 3; i++) ms.push((await time(script, env)).ms);
    console.log(`${label} | ${sname} | ${ename} | ms: ${ms.join(', ')}`);
  }
}
// Where the module search goes without PSModulePath.
const r = await time('$env:PSModulePath; (Get-Module -ListAvailable).Count', scrubbed);
console.log(`${label} | scrubbed: effective PSModulePath and module count: ${r.out}`);
const r2 = await time('(Get-Module -ListAvailable).Count', process.env);
console.log(`${label} | full: module count: ${r2.out}`);
