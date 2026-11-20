import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { packageFolders } from './scripts/vite-package-folders.mjs';

const pdfjs = 'node_modules/pdfjs-dist';
export default defineConfig({
  plugins: [
    react(),
    packageFolders({
      '/pdfjs/cmaps/': { from: `${pdfjs}/cmaps` },
      '/pdfjs/standard_fonts/': { from: `${pdfjs}/standard_fonts` },
      '/pdfjs/iccs/': { from: `${pdfjs}/iccs` },
      // The script sandbox is for forms that run code, which the preview never does.
      '/pdfjs/wasm/': { from: `${pdfjs}/wasm`, skip: /quickjs/i },
    }),
  ],
  resolve: {
    alias: [
      // Monaco 0.57 ships its own copy of DOMPurify 3.4.15, inside the advisories fixed in 3.4.17.
      // package.json overrides the npm package; this makes the bundle use it. Drop both once a
      // Monaco release carries a fixed copy.
      { find: /^\.\/dompurify\/dompurify\.js$/, replacement: 'dompurify' },
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/target/**', '**/src-tauri/**', '**/crates/**', '**/test-results/**'] },
  },
  clearScreen: false,
  test: {
    // A path filter alone also matches source copies elsewhere, such as under target/.
    include: ['src/**/*.test.{ts,tsx,mjs}'],
  },
});
