#!/usr/bin/env node
// Try a release by hand before it is published: serve dist-release/'s npm
// package from a private registry on this machine (tests/npm-test-registry.cjs),
// so the extension's Install Server downloads exactly that package, as it
// will from npmjs.org once it is published (docs/specs/SPEC-install.md §5.2).
//
//   node scripts/build-release.mjs
//   node scripts/try-release.mjs
//
// It prints the registry's address and keeps serving until Ctrl+C. Point
// only the VS Code you are trying at it: close every VS Code window, then
// start VS Code from a terminal with NPM_CONFIG_REGISTRY set to that address
// (the line it prints). Your own npm settings are not changed. Every other
// package passes through to npmjs.org.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startTestRegistry } = require('../tests/npm-test-registry.cjs');
const { removeTree } = require('../tests/release-files.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = path.join(root, 'dist-release');
const npmName = fs.existsSync(files) ? fs.readdirSync(files).find((n) => /^steptix-\d+\.\d+\.\d+\.tgz$/.test(n)) : undefined;
if (!npmName) throw new Error(`no steptix-<version>.tgz in ${files}: run node scripts/build-release.mjs first`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-try-release-'));
const registry = await startTestRegistry(dir);
registry.publish(path.join(files, npmName));
const code = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
console.log(`Serving ${npmName} at ${registry.url}`);
console.log('');
console.log('Close every VS Code window, then start one that uses it:');
console.log(
  process.platform === 'win32'
    ? `  $env:NPM_CONFIG_REGISTRY = '${registry.url}'; & "${code}"`
    : `  NPM_CONFIG_REGISTRY=${registry.url} code`,
);
console.log('');
console.log('Ctrl+C stops the registry.');

const stop = () => {
  registry.stop();
  removeTree(dir);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
