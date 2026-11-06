import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './ui',
  testMatch: 'assistant.spec.ts',
  outputDir: '../target/verification/assistant-ui-results',
  use: { baseURL: 'http://127.0.0.1:1426', browserName: 'chromium' },
  webServer: {
    cwd: '..',
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1426 --strictPort',
    url: 'http://127.0.0.1:1426',
    reuseExistingServer: true,
  },
});
