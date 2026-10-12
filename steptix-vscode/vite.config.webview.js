import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/** runner-core's compiled CommonJS, however the path to it is spelled. */
export const RUNNER_CORE_DIST = /[\\/]runner-core[\\/]dist[\\/]/;

// Webview is bundled to dist/webview/. Asset paths are relative so the host
// can rewrite them to webview URIs at load time.
export default defineConfig({
  root: path.resolve(__dirname, 'src/webview'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    sourcemap: true,
    // No modulepreload polyfill: VS Code's Chromium supports modulepreload,
    // the page is one chunk, and the polyfill is Vite's own code injected from
    // a virtual module — so no source map names it and it would ship without
    // its notice (scripts/third-party-notices.mjs reads the maps).
    modulePreload: { polyfill: false },
    // runner-core is a `file:` dependency, so npm links it and Vite follows the
    // link to `../runner-core/dist` — outside node_modules, where the CommonJS
    // transform does not look by default. Untransformed, its `exports.x = …`
    // modules have no ES exports and the build fails on the first named
    // import. That, not `__exportStar`, is why the webview once kept its own
    // copies of runner-core's grammar (steptix/steptix#49).
    // tests/webview-runner-core.test.js builds with this same setting.
    commonjsOptions: { include: [/node_modules/, RUNNER_CORE_DIST] },
    rollupOptions: {
      input: path.resolve(__dirname, 'src/webview/index.html'),
    },
  },
  plugins: [react()],
});
