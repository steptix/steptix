// TEMPORARY diagnostic for PR #127's Windows CI timeouts. Not for main.
// Times what an agent command costs on this machine, split into its parts.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { runCommand, scrubbedEnv, shellFor } from '../dist/agent/commands.js';

const label = process.argv[2] ?? 'run';
const N = 5;
const scrubbed = scrubbedEnv(process.env);
// The Add-Type preamble exactly as runCommand sends it: everything before the command.
const MARK = '__STEPTIX_DIAG_CMD__';
const full = shellFor('win32').args(MARK).at(-1);
const preamble = full.slice(0, full.indexOf(MARK));

function time(file, args, env) {
  return new Promise((resolve) => {
    const t = Date.now();
    const c = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ ms: Date.now() - t, code, out: out.trim().slice(0, 300) }));
    c.on('error', (e) => resolve({ ms: Date.now() - t, code: 'ERR', out: String(e) }));
  });
}

const ps = (cmd) => ['-NoProfile', '-NonInteractive', '-Command', cmd];
const cases = [
  ['node direct', () => time(process.execPath, ['-e', '0'], scrubbed)],
  ['powershell exit 0 (full env)', () => time('powershell.exe', ps('exit 0'), process.env)],
  ['powershell exit 0 (scrubbed env)', () => time('powershell.exe', ps('exit 0'), scrubbed)],
  ['powershell node -e (scrubbed)', () => time('powershell.exe', ps('node -e 0'), scrubbed)],
  [
    'powershell Add-Type only, timed inside (scrubbed)',
    () => time('powershell.exe', ps(`$t = Measure-Command { ${preamble} }; Write-Output ("addtype_ms=" + [int]$t.TotalMilliseconds)`), scrubbed),
  ],
  [
    'powershell Add-Type only, timed inside (full env)',
    () => time('powershell.exe', ps(`$t = Measure-Command { ${preamble} }; Write-Output ("addtype_ms=" + [int]$t.TotalMilliseconds)`), process.env),
  ],
  [
    'runCommand node -e (the real path)',
    async () => {
      const r = await runCommand({ command: 'node -e "process.exit(3)"', cwd: os.tmpdir(), env: scrubbed, timeoutMs: 300_000 });
      return { ms: r.durationMs, code: r.exitCode, out: r.output.slice(0, 300) };
    },
  ],
];

console.log(`=== ${label}: ${os.cpus().length} CPUs, load ${os.loadavg().join(',')}, free ${Math.round(os.freemem() / 1e6)} MB`);
for (const [name, fn] of cases) {
  const results = [];
  for (let i = 0; i < N; i++) results.push(await fn());
  console.log(`${label} | ${name} | ms: ${results.map((r) => r.ms).join(', ')} | codes: ${results.map((r) => r.code).join(',')}`);
  const outs = results.map((r) => r.out.replace(/\s+/g, ' ')).filter(Boolean);
  if (outs.length) console.log(`${label} |   output: ${outs.join(' ; ')}`);
}
