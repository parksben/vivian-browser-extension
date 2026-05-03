import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import manifest from './src/manifest';

// `pnpm dev` runs Vite's dev server. @crxjs writes a loadable `dist/` that
// imports the dev server's HMR client, so the sidepanel hot-reloads on
// edit. Background + content scripts are rebuilt and the extension is
// auto-reloaded by Chrome.
//
// `pnpm build` and `pnpm build:watch` produce a self-contained `dist/`
// (no dev-server dependency) — used for distribution and the CRX pack.
//
// HMR pin notes (don't change without testing the full loop):
//  - port:5173 strictPort:true → Chrome rejects floating ports for the
//    websocket connection that wires up sidepanel HMR. A stable port lets
//    us pin allowedOrigins / CSP if anything ever needs it.
//  - hmr.host / hmr.protocol left default — @crxjs handles the `ws://` URL
//    rewriting needed inside the sidepanel iframe.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: 'inline',
  },
});
