require('./node-check.cjs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const server = path.join(__dirname, 'server');
let entry = path.join(server, 'dist', 'index.js');
let nodeArgs = ['--enable-source-maps'];
if (args[0] === 'browsers') {
  if (!['install', 'install-deps', '--help'].includes(args[1])) {
    console.error('Usage: steptix browsers install [chromium|firefox|webkit]');
    process.exit(1);
  }
  args.shift();
  entry = path.join(server, 'node_modules', 'playwright', 'cli.js');
} else if (args[0] === 'ui') {
  console.error('This server-only runtime does not include the Electron UI. Use the Steptix VS Code extension.');
  process.exit(1);
} else if (args[0] === 'serve') {
  nodeArgs.push('--inspect=127.0.0.1:0');
}
if (args[0] !== 'install' && args[0] !== 'install-deps' && entry.endsWith('dist' + path.sep + 'index.js')) {
  nodeArgs.push('--import', require('node:url').pathToFileURL(path.join(__dirname, 'runtime-bootstrap.mjs')).href);
}
// Preserve the caller's cwd: tests, configuration and custom tool dependencies belong to the project.
const child = spawn(process.execPath, [...nodeArgs, entry, ...args], {
  cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true,
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
