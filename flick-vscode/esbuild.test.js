// Bundles the test files for `node --test`. The bare `vscode` import is aliased
// to tests/fakes/vscode.ts so the extension-host code runs unchanged outside an
// Extension Development Host. Each test file becomes a self-contained bundle
// under dist-test/, preserving its tests/ sub-path.
const esbuild = require('esbuild');
const path = require('node:path');

esbuild
  .build({
    entryPoints: [
      'tests/unit/parse-steps.test.ts',
      'tests/unit/cdp-discovery.test.ts',
      'tests/unit/browser-launcher.test.ts',
      'tests/integration/controller.test.ts',
    ],
    outdir: 'dist-test',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: true,
    alias: { vscode: path.resolve(__dirname, 'tests/fakes/vscode.ts') },
    logLevel: 'info',
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
