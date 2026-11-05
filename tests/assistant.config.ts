import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: './ui',
  testMatch: 'assistant.spec.ts',
  outputDir: '../target/verification/assistant-ui-results',
  use: { baseURL: 'http://127.0.0.1:1426', browserName: 'chromium' },
  webServer: {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1426 --strictPort',
    url: 'http://127.0.0.1:1426',
    reuseExistingServer: true,
  },
});
