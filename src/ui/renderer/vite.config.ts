import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: './',
  build: {
    outDir: path.resolve(__dirname, '../../../dist-ui/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '~ipc': path.resolve(__dirname, '../ipc-types'),
    },
  },
});
