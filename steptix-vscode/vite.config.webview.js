import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

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
    rollupOptions: {
      input: path.resolve(__dirname, 'src/webview/index.html'),
    },
  },
  plugins: [react()],
});
