import { defineConfig } from '@playwright/test';

// `*.webkit.spec.ts` checks the engine of the macOS app's view, so it runs on macOS only, where
// macos.yml installs WebKit. Everything else runs in Chromium, the Windows view's engine.
const webkit = /\.webkit\.spec\.ts$/;
export default defineConfig({
  testDir: './tests/ui',
  use: { baseURL: 'http://127.0.0.1:1420' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: webkit },
    ...(process.platform === 'darwin'
      ? [{ name: 'webkit', use: { browserName: 'webkit' as const }, testMatch: webkit }]
      : []),
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  },
});
