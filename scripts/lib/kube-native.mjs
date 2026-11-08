// Shared by the Kubernetes checks against the real app, a real OpenSSH server and a kind cluster.
// Never print the fixture's passwords.
import { expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { showSidebarView } from '../native-workspace.mjs';

export function kubeFixture(cluster, action) {
  const result = spawnSync(
    'wsl',
    ['-d', 'Ubuntu-24.04', '--', 'bash', 'scripts/kube-fixture.sh', cluster, action],
    { encoding: 'utf8', timeout: 600_000 },
  );
  if (result.status !== 0)
    throw new Error(`kube-fixture ${action} failed: ${result.stderr.slice(-400)}`);
  return Object.fromEntries(
    result.stdout
      .split('\n')
      .map((line) => line.trim().split('='))
      .filter((pair) => pair.length === 2),
  );
}

export function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed`);
  return result.stdout.trim();
}

/** Selectors and session steps for the focused pane. Trust is remembered across connections. */
export function kubeScreen(page, sshPort) {
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  const pane = () => page.locator('.pane-cell.focused');
  const terminal = () => pane().locator('.terminal-pane');
  const header = () => pane().getByRole('tablist', { name: '쿠버네티스 화면' });
  const savedProfile = async (name) =>
    (await invoke('sessions')).profiles.find((profile) => profile.name === name);
  const connectionId = () => terminal().getAttribute('data-connection-id');
  const terminalText = () => terminal().locator('.xterm-accessibility-tree').innerText();

  /** The form's own field is covered by the Playwright spec; this keeps the password out of it. */
  async function addSession(name, username, workspace) {
    await invoke('save_session', {
      profile: {
        id: '',
        name,
        host: '127.0.0.1',
        port: sshPort,
        username,
        auth: 'password',
        protocol: 'ssh',
        tlsCaPath: '',
        encoding: 'utf-8',
        keyPath: '',
        groupId: null,
        favorite: false,
        timeout: 15,
        keepalive: 15,
        workspace,
        lastConnected: null,
        hasSecret: false,
      },
      secretAction: 'keep',
      secret: null,
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  }

  let trusted = false;
  async function answerLogin(password) {
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('비밀번호', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: '연결', exact: true }).click();
    if (!trusted) {
      await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
      trusted = true;
    }
    await expect
      .poll(() => terminal().locator('.connection-message').innerText(), { timeout: 20_000 })
      .toContain('연결됨');
  }
  async function connect(name, password) {
    await showSidebarView(page, '연결');
    await page
      .locator('.profile-card')
      .filter({ hasText: name })
      .locator('.profile-target')
      .dblclick();
    await answerLogin(password);
  }

  return {
    invoke,
    pane,
    terminal,
    header,
    savedProfile,
    connectionId,
    terminalText,
    addSession,
    answerLogin,
    connect,
  };
}
