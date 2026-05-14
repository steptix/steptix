// Builds two bundles:
//   dist/extension/extension.js — the VS Code extension host (CommonJS, Node)
//   dist/webview/main.js        — the chat UI that runs inside the webview (IIFE, browser)
// The webview CSS and HTML scaffold are produced separately (CSS copied, HTML generated
// at runtime by src/extension/html.ts).
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview/main.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2021',
  sourcemap: true,
  logLevel: 'info',
};

function copyStatic() {
  fs.mkdirSync('dist/webview', { recursive: true });
  fs.copyFileSync('src/webview/styles.css', 'dist/webview/styles.css');
}

async function run() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig);
    const ctxView = await esbuild.context(webviewConfig);
    copyStatic();
    fs.watch('src/webview/styles.css', () => copyStatic());
    await Promise.all([ctxExt.watch(), ctxView.watch()]);
    console.log('[flick-vscode] watching...');
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
    copyStatic();
    console.log('[flick-vscode] build complete');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
