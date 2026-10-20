// Bundle the extension host code + runner-core dependency into a single
// CommonJS file under dist/extension/extension.js. This avoids needing
// node_modules at runtime inside the .vsix.
const esbuild = require('esbuild');
const path = require('node:path');

const watch = process.argv.includes('--watch');

/**
 * The commit this bundle is built from, and whether the checkout held changes
 * that commit does not, the way the framework's scripts/build-info.mjs stamps
 * the server. Builds between releases share a version number, so this is what
 * tells them apart in the status bar and the Output panel
 * (docs/specs/SPEC-install.md §3.1). Unknown (null) without git or outside
 * this repository's checkout.
 */
function buildInfo() {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const repoRoot = path.resolve(__dirname, '..');
  const git = (...args) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (fs.realpathSync.native(git('rev-parse', '--show-toplevel')) !== fs.realpathSync.native(repoRoot)) {
      return { commit: null, modified: null };
    }
    return { commit: git('rev-parse', 'HEAD').slice(0, 7), modified: git('status', '--porcelain') !== '' };
  } catch {
    return { commit: null, modified: null };
  }
}

const opts = {
  entryPoints: [path.resolve(__dirname, 'src/extension/extension.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.resolve(__dirname, 'dist/extension/extension.js'),
  // VS Code provides `vscode` at runtime; never bundle it.
  external: ['vscode'],
  // Prefer a dependency's ESM build over its CommonJS one. For `platform:
  // 'node'` esbuild defaults to ['main', 'module'], which picks jsonc-parser's
  // UMD bundle — and a UMD wrapper's `require('./impl/parser')` calls are not
  // statically analysable, so they survive into the output and then throw
  // "Cannot find module './impl/format'" at activation, since the .vsix ships
  // no node_modules. The ESM build inlines cleanly. Only two non-builtin
  // packages reach this bundle (runner-core and jsonc-parser), so the wider
  // effect of the flip is small.
  mainFields: ['module', 'main'],
  define: { __STEPTIX_EXTENSION_BUILD__: JSON.stringify(buildInfo()) },
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
  } else {
    await esbuild.build(opts);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
