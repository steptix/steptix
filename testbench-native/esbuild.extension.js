// Bundle the extension host code + runner-core dependency into a single
// CommonJS file under dist/extension/extension.js. This avoids needing
// node_modules at runtime inside the .vsix.
const esbuild = require('esbuild');
const path = require('node:path');

const watch = process.argv.includes('--watch');

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
