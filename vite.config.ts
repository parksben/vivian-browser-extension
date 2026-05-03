import { readFileSync, existsSync } from 'node:fs';
import { defineConfig, type PluginOption } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

// Phase 1 pass-through: sidebar/sidebar.html currently references
// `lib/marked.min.js`, `../shared/icons.js`, and `sidebar.js` as plain
// (non-module) <script> tags. Vite refuses to bundle those — it only
// touches ES modules. Without help, dist/sidebar/sidebar.html ends up
// pointing at files that never got copied.
//
// This plugin copies them verbatim into `dist/` at the exact paths the
// HTML expects. Phase 5+ deletes all three as the React sidebar takes
// over.
function passThroughLegacyFiles(): PluginOption {
  const files = [
    'sidebar/sidebar.js',
    'sidebar/lib/marked.min.js',
    'shared/icons.js',
  ];
  return {
    name: 'clawtab-passthrough-legacy',
    apply: 'build',
    generateBundle() {
      for (const file of files) {
        if (!existsSync(file)) {
          this.warn(`[clawtab] Legacy file missing, skipping: ${file}`);
          continue;
        }
        this.emitFile({
          type: 'asset',
          fileName: file,
          source: readFileSync(file),
        });
      }
    },
  };
}

// Phase 1: @crxjs consumes the existing root-level JS / HTML verbatim and
// emits an MV3-valid `dist/` that Chrome can "Load unpacked". No business
// code is moved yet — that starts in Phase 2. See docs/TECH_DESIGN.md.
export default defineConfig({
  plugins: [crx({ manifest }), passThroughLegacyFiles()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep output verbose enough to spot accidental minification of SW code
    // while we're still touching the original files.
    minify: false,
    sourcemap: 'inline',
  },
});

