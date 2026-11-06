import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
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
