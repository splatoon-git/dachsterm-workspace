// Starts the built app with its WebView2 reachable over CDP. New native scripts use this instead
// of copying `launch()`; moving the existing ones here is review item T2.
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** `directory` isolates the app's data and WebView profile from the user's. `visible` is for a person. */
export async function launchNativeApp({ executable, directory, visible = false }) {
  if (process.platform !== 'win32') throw new Error('Windows WebView2 is required.');
  if (!existsSync(executable)) throw new Error(`The app is not built: ${executable}`);
  const port = await freePort();
  const app = spawn(path.resolve(executable), [], {
    stdio: 'ignore',
    windowsHide: !visible,
    env: {
      ...process.env,
      DACHSTERM_TEST_DATA_DIR: directory,
      DACHSTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
    },
  });
  const shutdown = async (browser) => {
    if (app.pid && app.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(app.pid)], { stdio: 'ignore', windowsHide: true });
      for (let i = 0; i < 40 && app.exitCode === null; i++) await sleep(100);
      if (app.exitCode === null) app.kill();
    }
    await browser?.close().catch(() => {});
  };
  let endpoint;
  for (let i = 0; i < 120 && !endpoint; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(250);
    }
  }
  if (!endpoint) {
    await shutdown();
    throw new Error('The app did not open its debugging endpoint.');
  }
  const browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  for (let i = 0; i < 80; i++) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes('tauri.localhost'));
    if (page)
      return { app, browser, page, version: endpoint.Browser, stop: () => shutdown(browser) };
    await sleep(250);
  }
  await shutdown(browser);
  throw new Error('The app page did not appear.');
}
