import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './ui',
  testMatch: 'transfer-queue.spec.ts',
  outputDir: '../target/verification/queue-ui-results',
  use: { baseURL: 'http://127.0.0.1:1425', browserName: 'chromium' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1425 --strictPort',
    url: 'http://127.0.0.1:1425',
    reuseExistingServer: true,
  },
});
