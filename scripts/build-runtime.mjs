import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// The runtime is the framework at this checkout's version unless told otherwise.
const version = process.argv[2] ?? sourcePackage.version;
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid runtime version');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this package on Windows x64');
// Checked before anything is staged, so a missing compiler costs nothing.
const compiler = process.env.STEPTIX_MAKENSIS ?? path.join(root, 'build-tools/nsis/compiler/Bin/makensis.exe');
if (!fs.existsSync(compiler)) throw new Error('Set STEPTIX_MAKENSIS to a portable NSIS compiler');
const output = path.join(root, 'dist-runtime');
const payload = path.join(output, `steptix-runtime-${version}-win-x64`);
const installerName = `SteptixRuntimeSetup-${version}-win-x64.exe`;
const released = path.join(output, installerName);
// The compiler writes here; an installer moves to `released` only once the
// end-to-end test has passed on it.
const unverified = path.join(output, 'unverified');
const candidate = path.join(unverified, installerName);
// A rebuild replaces this version's outputs, the released installer first: a
// rebuild that fails must not leave the previous build standing in its place.
for (const file of [released, candidate]) {
  for (const suffix of ['', '.sha256', '.verification.json']) fs.rmSync(file + suffix, { force: true });
}
fs.rmSync(payload, { recursive: true, force: true });
// The installer carries what this checkout builds now, with a build stamp of
// this commit — not whatever dist/ happened to be built last.
execSync('npm run build', { cwd: root, stdio: 'inherit' });
const sourceModules = fs.realpathSync(path.join(root, 'node_modules'));
const server = path.join(payload, 'server');
fs.mkdirSync(server, { recursive: true });
// Deliberately server-only; the source checkout's production list also contains editor/build packages.
const excluded = /^(?:@codemirror\/|@lezer\/|@vitejs\/|electron$|react$|react-dom$|vite$)/;
const roots = Object.keys(sourcePackage.dependencies).filter((name) => !excluded.test(name));
roots.push('esbuild', 'ajv'); // Runtime tool compilation and MCP schema validation must not depend on hoisting.
const installed = new Map();
const visited = new Set();
function locate(name, from) {
  const require = createRequire(path.join(from, 'package.json'));
  // A dependency named "buffer" or "events" is a real npm package even though
  // Node also has a builtin by that name (whose resolve.paths would be null).
  for (const search of require.resolve.paths('__steptix_dependency_lookup__') ?? []) {
    const candidate = path.join(search, name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
  }
  return null;
}
function supported(pkg) {
  return [['os', 'win32'], ['cpu', 'x64']].every(([key, value]) => {
    const list = pkg[key];
    return !Array.isArray(list) || (!list.includes(`!${value}`) && (list.every((v) => v.startsWith('!')) || list.includes(value)));
  });
}
function copyDependency(name, from, optional = false) {
  const source = locate(name, from);
  if (!source) { if (optional) return; throw new Error(`Missing dependency ${name} from ${from}`); }
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (!supported(pkg)) { if (optional) return; throw new Error(`Incompatible dependency ${name}`); }
  if (visited.has(source)) return;
  visited.add(source);
  const relative = path.relative(sourceModules, source);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Dependency outside node_modules: ${source}`);
  const target = path.join(server, 'node_modules', relative);
  fs.cpSync(source, target, { recursive: true, dereference: true,
    filter: (entry) => entry === source || !path.relative(source, entry).split(path.sep).some((part) => ['node_modules', '.git'].includes(part)),
  });
  installed.set(relative.replaceAll('\\', '/'), { name: pkg.name, version: pkg.version, license: pkg.license ?? 'See package license' });
  const optionalDeps = pkg.optionalDependencies ?? {};
  for (const dependency of Object.keys(pkg.dependencies ?? {})) copyDependency(dependency, source, dependency in optionalDeps);
  for (const dependency of Object.keys(optionalDeps)) copyDependency(dependency, source, true);
  for (const dependency of Object.keys(pkg.peerDependencies ?? {})) {
    // Optional provider SDKs are not installed implicitly (Bedrock stays opt-in).
    if (!pkg.peerDependenciesMeta?.[dependency]?.optional) copyDependency(dependency, source);
  }
}
for (const name of roots) copyDependency(name, root);
const dependencies = Object.fromEntries(roots.map((name) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(locate(name, root), 'package.json'), 'utf8'));
  return [name, pkg.version];
}));
fs.writeFileSync(path.join(server, 'package.json'), JSON.stringify({
  name: 'steptix', version, description: sourcePackage.description, license: sourcePackage.license,
  type: 'module', main: sourcePackage.main, types: sourcePackage.types, exports: sourcePackage.exports,
  bin: sourcePackage.bin, engines: sourcePackage.engines, dependencies,
}, null, 2) + '\n');
fs.cpSync(path.join(root, 'dist'), path.join(server, 'dist'), { recursive: true,
  filter: (entry) => !path.relative(path.join(root, 'dist'), entry).split(path.sep).includes('ui'),
});
// The desktop CLI command is not part of this edition; leave the application checkout untouched.
const cliFile = path.join(server, 'dist', 'cli', 'index.js');
fs.writeFileSync(cliFile, fs.readFileSync(cliFile, 'utf8')
  .replace(/^import \{ registerUiCommand \} from .*;\r?\n/m, '')
  .replace(/^\s*registerUiCommand\(program\);\r?\n/m, ''));
fs.cpSync(path.join(root, 'schema'), path.join(server, 'schema'), { recursive: true });
// The template checkout is also used for live runs: it can contain signed-in
// browser profiles, reports and .env files. Never recursively package it.
const git = process.env.STEPTIX_GIT ?? 'git';
const templateFiles = execFileSync(git, ['ls-files', '-z', '--', 'templates/init'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const relative of templateFiles) {
  if (relative.split('/').some((part) => part.startsWith('.') || part === 'node_modules' || part === 'reports')) continue;
  const target = path.join(server, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, relative), target);
}
fs.cpSync(path.join(root, 'src/browser/scripts'), path.join(server, 'dist/browser/scripts'), { recursive: true });
for (const name of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(root, name), path.join(server, name));
for (const name of ['node-check.cjs', 'steptix.cmd', 'runtime-launcher.cjs', 'runtime-bootstrap.mjs', 'runtime-scan.ps1']) fs.copyFileSync(path.join(root, 'packaging/runtime', name), path.join(payload, name));
fs.writeFileSync(path.join(server, 'THIRD-PARTY-NOTICES.txt'), 'Dependencies included in this runtime. License files are retained in each package.\n\n' +
  [...installed.values()].map((pkg) => `${pkg.name}@${pkg.version}: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)}`).join('\n') + '\n');
const playwright = JSON.parse(fs.readFileSync(path.join(server, 'node_modules/playwright/package.json'), 'utf8'));
const browsers = JSON.parse(fs.readFileSync(path.join(server, 'node_modules/playwright-core/browsers.json'), 'utf8'));
const manifest = {
  schemaVersion: 1, product: 'steptix-runtime', version, platform: 'win32', architecture: 'x64',
  node: { bundled: false, required: sourcePackage.engines.node, executableOverride: 'STEPTIX_NODE' },
  entryPoint: 'server/dist/index.js', cli: 'steptix.cmd', playwrightVersion: playwright.version,
  browsers: { bundled: false, cache: '%LOCALAPPDATA%/ms-playwright', revisions: browsers.browsers },
  extensionAutoDiscovery: true,
};
fs.writeFileSync(path.join(payload, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const readme = `Steptix Runtime ${version} - Windows x64 beta\n\n` +
`PREREQUISITES\nNode.js x64 22.21 or later must be installed and available on PATH.\nYou can instead set STEPTIX_NODE to the absolute path of node.exe.\nNode.js, browsers and the VS Code extension are not included.\n\n` +
`CLI\nOpen a new terminal and run: steptix --help\nThe installer adds %LOCALAPPDATA%\\steptix\\bin to your user PATH unless you untick "Add steptix to PATH"\n(or install with /NOPATH).\nsteptix there runs the newest runtime installed under %LOCALAPPDATA%\\steptix\\runtimes.\nTerminals and VS Code windows that were open during the install need a restart to see it.\nTo run this version without PATH, in PowerShell: & "$env:LOCALAPPDATA\\steptix\\runtimes\\${version}\\steptix.cmd" --help\nRun the CLI from your test project's directory so configuration and tools are resolved there.\nThis installer does not modify VS Code settings.\n\n` +
`SERVER\nsteptix serve --idle-timeout 60\nThe launcher enables a localhost Node inspector on a free port for TypeScript debugging.\nThe server generates/reuses its local key at %LOCALAPPDATA%\\steptix\\.env.\nNo real credentials are included in this package.\n\n` +
`VS CODE\nNothing to configure. When you run a test and no server is listening, the Steptix extension\nstarts the newest runtime under %LOCALAPPDATA%\\steptix\\runtimes on the port SERVER_URL names.\n` +
`SERVER_URL comes from the project's .env, else the SERVER_URL environment variable,\nelse %LOCALAPPDATA%\\steptix\\.env, else it is http://127.0.0.1:3100. A project needs no .env of its own.\n` +
`Setting steptix.serverAutoStart.command in VS Code User settings starts something else instead.\nUse the extension's Server Status / Start Server / Stop Server commands.\n\n` +
`BROWSERS\nDefault Chromium-based runs use your installed Google Chrome; Edge is also supported.\nInstall the runtime's matching Playwright browser builds with:\nsteptix browsers install chromium\nsteptix browsers install firefox\nsteptix browsers install webkit\nPlaywright uses %LOCALAPPDATA%\\ms-playwright unless PLAYWRIGHT_BROWSERS_PATH is set.\nInstalling Chromium does not change Steptix's existing Chrome-channel default.\nBrowser installation downloads require network access.\n\n` +
`UNINSTALL / VERSIONS\nEach version has its own folder and Windows Installed Apps entry. Installing a version removes older ones;\ninstalling an older version again (a rollback) leaves newer ones, and the newest still runs.\nThe installer and uninstaller wait while Steptix runs from a version they would change. Stop it first:\nin VS Code run Steptix: Stop Server, or run steptix stop.\nUninstall.exe removes runtime files only; projects, shared keys and browsers are preserved.\nUninstalling the last runtime also removes %LOCALAPPDATA%\\steptix\\bin and its PATH entry.\n\n` +
`SILENT INSTALL\nSteptixRuntimeSetup-${version}-win-x64.exe /S installs with no window; add /NOPATH to leave PATH alone.\nUninstall.exe /S uninstalls with no window. Neither shows a dialog. A silent install exits with code 3\nwhile Steptix runs from a version it would change, and with code 2 when it cannot proceed for another reason.\nAn uninstall that cannot proceed removes nothing.\nIn PowerShell, Start-Process <installer> -ArgumentList '/S' -Wait waits for the install to finish.\n\n` +
`The beta installer is unsigned. Inspect the checksum supplied beside it.\n`;
fs.writeFileSync(path.join(payload, 'README.txt'), readme.replaceAll('\n', '\r\n'));
const inventory = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else inventory.push({ path: path.relative(payload, file).replaceAll('\\', '/'), size: fs.statSync(file).size });
  }
}
walk(payload);
fs.writeFileSync(path.join(output, `inventory-${version}.json`), JSON.stringify({ version, packages: installed.size, files: inventory }, null, 2));
fs.mkdirSync(unverified, { recursive: true });
const compile = (asVersion, into) => execFileSync(compiler, ['/V2', `/DVERSION=${asVersion}`, `/DPRODUCT_VERSION=${asVersion.split('-')[0]}.0`, `/DPAYLOAD=${payload}`, `/DOUTPUT=${into}`, path.join(root, 'packaging/runtime/runtime.nsi')], { stdio: 'inherit' });
compile(version, unverified);
// A newer version of the same runtime, for the test's two-version steps:
// installed beside the candidate, with the candidate then uninstalled while
// it stays. Its version is bumped where `--version` and the manifest report
// it, so the test can tell which runtime ran, and the payload is put back
// before anything else reads it. It stays in unverified/ and is never released.
const [, major, minor, patch] = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
const newerVersion = `${major}.${minor}.${Number(patch) + 1}-verify`;
const newerDir = path.join(unverified, 'newer');
fs.rmSync(newerDir, { recursive: true, force: true });
fs.mkdirSync(newerDir, { recursive: true });
const stamped = ['server/package.json', 'runtime-manifest.json'].map((file) => path.join(payload, file));
const originals = stamped.map((file) => fs.readFileSync(file, 'utf8'));
try {
  stamped.forEach((file, i) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(originals[i]), version: newerVersion }, null, 2) + '\n'));
  compile(newerVersion, newerDir);
} finally {
  stamped.forEach((file, i) => fs.writeFileSync(file, originals[i]));
}
const newer = path.join(newerDir, `SteptixRuntimeSetup-${newerVersion}-win-x64.exe`);
// Every installer is tested end to end before it is released: installed,
// started from VS Code through steptix.cmd to run a test, and uninstalled
// (scripts/verify-runtime.mjs). There is no flag to skip it.
const verify = spawnSync(process.execPath, [path.join(root, 'scripts/verify-runtime.mjs'), candidate, newer], { stdio: 'inherit' });
if (verify.status !== 0) {
  throw new Error(`The end-to-end test failed, so the installer was not released. It is left at ${candidate} for diagnosis.`);
}
const checksum = createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
const verification = JSON.parse(fs.readFileSync(`${candidate}.verification.json`, 'utf8'));
if (verification.sha256 !== checksum) throw new Error(`${candidate} changed after it was tested`);
fs.renameSync(candidate, released);
fs.rmSync(`${candidate}.verification.json`);
fs.writeFileSync(`${released}.verification.json`, JSON.stringify({ ...verification, installer: released }, null, 2) + '\n');
fs.writeFileSync(`${released}.sha256`, `${checksum}  ${installerName}\n`);
console.log(JSON.stringify({ installer: released, bytes: fs.statSync(released).size, packages: installed.size, files: inventory.length, sha256: checksum, verified: verification.checks.length }, null, 2));
