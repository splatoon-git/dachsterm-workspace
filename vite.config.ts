import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
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
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
