import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const installer = path.resolve(process.argv[2]);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-runtime-verify-'));
const install = path.join(temp, 'installed runtime');
const project = path.join(temp, 'test project');
const profile = path.join(temp, 'profile');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(profile, { recursive: true });
const env = { ...process.env, STEPTIX_NODE: process.execPath, LOCALAPPDATA: profile, STEPTIX_STATS: 'off', CI: '1' };
for (const key of Object.keys(env)) if (/^(AI_|STEPTIX_SERVER_API_KEY|SERVER_URL|AUTOMATION_ENV)/.test(key)) delete env[key];
function run(file, args, cwd = project, timeout = 90_000, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${path.basename(file)}`)); }, timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`${path.basename(file)} exit ${code}: ${output.slice(-5000)}`)); });
  });
}
const checks = [];
let server;
let base;
let key;
try {
  // NSIS requires /D to be the last argument and unquoted, even for paths with spaces.
  await run(installer, ['/S', '/TESTMODE', `/D=${install}`], project, 180_000, { windowsVerbatimArguments: true });
  const manifest = JSON.parse(await fs.readFile(path.join(install, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.0-beta.1');
  assert.equal(manifest.node.bundled, false);
  checks.push('Silent per-user installer extraction into a fresh path with spaces');
  const cli = (...args) => run(process.execPath, [path.join(install, 'runtime-launcher.cjs'), ...args]);
  assert.match(await cli('--version'), /1\.0\.0-beta\.1/);
  const help = await cli('--help');
  for (const command of ['run', 'compile', 'serve', 'status', 'stop', 'mcp']) assert.ok(help.includes(command));
  assert.ok(!help.includes('ui [directory]'));
  checks.push('Versioned CLI and server-only command help');
  assert.match(await cli('browsers', '--help'), /install/);
  // Validate the actual .cmd entry point, including a Node path containing spaces.
  const cmdResult = await run('cmd.exe', ['/d', '/c', 'call', path.join(install, 'steptix.cmd'), '--version']);
  assert.match(cmdResult, /1\.0\.0-beta\.1/);
  checks.push('Windows launcher and Playwright browser installer entry point');
  await cli('init');
  await fs.access(path.join(project, 'steptix.config.json'));
  await fs.access(path.join(project, 'tests/example.md'));
  checks.push('Project scaffolding from packaged templates');
  const config = {
    ai: { allowInRuns: false }, browser: { headed: false, browser: 'chromium', stealth: false },
    tests: { dir: './tests', toolsDir: './tools', contextDir: './context', skillsDir: './skills' },
    reports: { outputDir: './reports', openInBrowserAfterRun: false },
    execution: { timeout: 30_000, retries: 0 },
  };
  await fs.writeFile(path.join(project, 'steptix.config.json'), JSON.stringify(config));
  await fs.mkdir(path.join(project, 'tools'), { recursive: true });
  const testFile = path.join(project, 'tests/smoke.md');
  await fs.writeFile(testFile, '# Runtime smoke\n\n## Steps\n1. Open fixture\n2. [tool: echo]\n');
  await fs.writeFile(path.join(project, 'tests/smoke.steps.ts'), `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([{source: 'Open fixture', async run({page, step}) {
  await page.goto('data:text/html,<title>Runtime smoke</title><h1>Ready</h1>');
  step.setVar('fixture', await page.title());
}}]);\n`);
  await fs.writeFile(path.join(project, 'tools/echo.ts'), `import { defineTool } from 'steptix/tools';
export default defineTool({name:'echo',parameters:{},outputs:{marker:{type:'string'}},
async run(_args, {step}) { const value: string = 'tool-ok'; step.setVar('marker', value); }});\n`);
  // The project is outside the checkout and has no node_modules: no accidental checkout dependencies.
  await assert.rejects(fs.access(path.join(project, 'node_modules')));
  assert.match(await cli('run', testFile, '--headless'), /passed/i);
  checks.push('Headless Chrome test with compiled TypeScript and custom tool, no AI or project dependencies');
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(install, 'runtime-launcher.cjs'), 'serve', '--port', String(port), '--idle-timeout', '1'], {
    cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  let health;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(`${base}/health`); if (response.ok) { health = await response.json(); break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(health, `Server failed to start: ${serverLog.slice(-4000)}`);
  assert.equal(health.version, manifest.version);
  assert.equal(health.service, 'steptix');
  assert.match(health.inspector, /^ws:\/\/127\.0\.0\.1:/);
  const inspector = new URL(health.inspector);
  const inspectorTargets = await (await fetch(`http://${inspector.host}/json/list`)).json();
  assert.ok(inspectorTargets.some((target) => target.webSocketDebuggerUrl === health.inspector));
  checks.push('Server health/version and live localhost Node debugger endpoint');
  const keyFile = path.join(profile, 'steptix/.env');
  const keyContents = await fs.readFile(keyFile, 'utf8');
  key = keyContents.match(/^STEPTIX_SERVER_API_KEY=(.+)$/m)?.[1].trim();
  assert.ok(key);
  assert.equal((await fetch(`${base}/sessions`)).status, 401);
  const response = await fetch(`${base}/sessions/installer-smoke/steps`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ steps: ['Open fixture', '[tool: echo]'], testFilePath: testFile, toolsDir: path.join(project, 'tools'), runSettings: { ai: 'off' } }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.outputs.marker, 'tool-ok');
  assert.equal(result.outputs.fixture, 'Runtime smoke');
  checks.push('Authenticated Sessions API execution and automatic key generation');
  const reload = await import(pathToFileURL(path.join(install, 'server/dist/tools/reload.js')).href);
  const bundle = await reload.bundleToolModule(path.join(project, 'tools/echo.ts'), path.join(project, 'tools/.steptix-tool-cache'));
  assert.match(new TextDecoder().decode(bundle.contents), /sourceMappingURL=data:application\/json;base64,/);
  checks.push('Custom TypeScript tool compilation retains inline debugger source maps');
  await cli('stop', '--url', base);
  checks.push('CLI server shutdown');
  await run(path.join(install, 'Uninstall.exe'), ['/S', `_?=${install}`], project, 90_000, { windowsVerbatimArguments: true });
  await assert.rejects(fs.access(path.join(install, 'server/dist/index.js')));
  await fs.access(testFile);
  assert.equal(await fs.readFile(keyFile, 'utf8'), keyContents);
  checks.push('Uninstaller removes runtime while preserving project and shared server key');
  const report = { installer, installedTestPath: install, checks, passed: checks.length, verifiedAt: new Date().toISOString() };
  await fs.writeFile(`${installer}.verification.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (server && key) await fetch(`${base}/admin/shutdown`, { method: 'POST', headers: { 'x-api-key': key } }).catch(() => {});
  if (server && server.exitCode === null) {
    // The launcher owns a Node child; terminate only this test's process tree.
    spawnSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
  // The temporary directory is retained for diagnostics; it contains no real credentials.
}
