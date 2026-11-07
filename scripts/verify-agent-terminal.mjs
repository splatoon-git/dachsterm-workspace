// Attachments, server ports and tmux in the real app against the real OpenSSH fixture.
// Opening a server port is the one action here with a visible side effect: the default browser
// opens one tab on 127.0.0.1, because a webview has no way to observe url_open otherwise.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const promptFolder = '/home/probe/.cache/dachsterm/prompt';
const tmuxName = 'dachs-native';
const serverPort = 38765;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function verifyAgentTerminal({
  page,
  pane,
  invoke,
  docker,
  probe,
  command,
  output,
  connected,
  typeInput,
  showConnections,
  directory,
  screenshots,
  setStage,
}) {
  const container = probe('CONTAINER');
  const asProbe = (...args) => docker(['exec', '-u', 'probe', container, ...args]);
  const shell = (script) => asProbe('sh', '-c', script).trim();
  const tmux = (...args) => asProbe('tmux', ...args).trim();

  /** The native drop event, delivered where the window's own listener receives it. */
  async function drop(paths, target = pane()) {
    const box = await target.boundingBox();
    const scale = await page.evaluate(() => window.devicePixelRatio);
    await invoke('plugin:event|emit', {
      event: 'tauri://drag-drop',
      payload: {
        paths,
        position: { x: (box.x + box.width / 2) * scale, y: (box.y + box.height / 2) * scale },
      },
    });
  }
  const attachCard = () => pane().getByRole('alert', { name: '서버로 파일 보내기 확인' });
  /** Reads what the app typed. The shell receives it only after this test presses Enter. */
  async function readTyped(marker) {
    await command(`IFS= read -r typed; printf '${marker}<%s>\\n' "$typed"`);
    await sleep(200);
  }
  async function finishTyped(marker) {
    assert(
      !(await pane().locator('.xterm-accessibility-tree').innerText()).includes(`${marker}<`),
      'the app must not press Enter',
    );
    await pane().locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Enter');
    await output(`${marker}<`);
  }
  const stored = () =>
    shell(`ls -1 ${promptFolder} 2>/dev/null || true`).split('\n').filter(Boolean);

  setStage('AT.5 file drop');
  const attached = path.join(directory, '한글 attach 1.txt');
  await writeFile(attached, 'attach-body');
  await drop([attached]);
  await expect(attachCard()).toContainText('한글 attach 1.txt');
  await expect(attachCard()).toContainText('~/.cache/dachsterm/prompt/');
  await expect(attachCard().getByRole('checkbox')).toHaveCount(0);
  await attachCard().getByRole('button', { name: '취소', exact: true }).click();
  await expect(attachCard()).toHaveCount(0);
  assert.deepEqual(stored(), [], 'a cancelled drop must not upload');

  await shell(`mkdir -p ${promptFolder} && chmod 755 ${promptFolder}`);
  const oldStored = '20200101-000000-0a1b2c3d-old.png';
  await shell(
    `cd ${promptFolder} && touch -d 2020-01-01 ${oldStored} notes.txt && ` +
      `mkdir 20200101-000000-0a1b2c3e-dir && touch -d 2020-01-01 20200101-000000-0a1b2c3e-dir`,
  );
  await readTyped('DROP');
  await drop([attached]);
  await attachCard().getByRole('button', { name: '서버로 보내기', exact: true }).click();
  await expect(attachCard()).toHaveCount(0);
  await expect(pane().locator('.connection-message')).toContainText('경로를 입력');
  await finishTyped('DROP');
  const files = stored();
  const sent = files.find((name) => name.endsWith('attach_1.txt'));
  assert.match(sent ?? '', /^\d{8}-\d{6}-[0-9a-f]{8}-___attach_1\.txt$/);
  await output(`DROP<${promptFolder}/${sent} >`);
  assert.equal(shell(`cat ${promptFolder}/${sent}`), 'attach-body');
  assert.equal(shell(`stat -c %a ${promptFolder}/${sent}`), '600');
  assert.equal(shell(`stat -c %a ${promptFolder}`), '700');
  assert(!files.includes(oldStored), 'an expired stored file must be removed');
  assert(files.includes('notes.txt'), 'a file this app did not make must stay');
  assert(files.includes('20200101-000000-0a1b2c3e-dir'), 'a directory must stay');
  console.log('PASS native file drop: confirm, cancel, 0600/0700, no Enter, cleanup rule');

  setStage('AT.5 refusals');
  await drop([directory]);
  await expect(pane().locator('.connection-message')).toContainText('폴더와 심볼릭');
  await expect(attachCard()).toHaveCount(0);
  const before = stored().length;
  await shell(`mv ${promptFolder} ${promptFolder}.real && ln -s /tmp ${promptFolder}`);
  await drop([attached]);
  await attachCard().getByRole('button', { name: '서버로 보내기', exact: true }).click();
  await expect(pane().locator('.connection-message')).toContainText('일반 폴더가 아니어서');
  assert.equal(shell('ls /tmp | grep -c attach_1 || true'), '0');
  await shell(`rm ${promptFolder} && mv ${promptFolder}.real ${promptFolder}`);
  assert.equal(stored().length, before);
  console.log('PASS native upload refuses a folder and a symbolic link in place of the folder');

  setStage('AT.5 clipboard image');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const previous = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  const writeImage = () =>
    page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 3;
      canvas.getContext('2d').fillRect(0, 0, 4, 3);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    });
  const pasteButton = () => pane().getByRole('button', { name: '붙여넣기', exact: true });
  try {
    await writeImage();
    await readTyped('IMAGE');
    await pasteButton().click();
    await expect(attachCard()).toContainText('clipboard.png');
    await attachCard().getByRole('checkbox').check();
    await attachCard().getByRole('button', { name: '서버로 보내기', exact: true }).click();
    await expect(pane().locator('.connection-message')).toContainText('경로를 입력');
    await finishTyped('IMAGE');
    const image = stored().find((name) => name.endsWith('-clipboard.png'));
    assert(image, 'the clipboard image must reach the server');
    assert.equal(
      shell(`python3 -c "print(open('${promptFolder}/${image}','rb').read(8).hex())"`),
      '89504e470d0a1a0a',
    );
    // "Do not ask again" lasts for this connection, and a changed image goes straight through.
    await readTyped('AGAIN');
    await pasteButton().click();
    await expect.poll(() => stored().filter((n) => n.endsWith('-clipboard.png')).length).toBe(2);
    await expect(attachCard()).toHaveCount(0);
    await finishTyped('AGAIN');
  } finally {
    await page.evaluate((text) => navigator.clipboard.writeText(text), previous);
    await cdp.detach();
  }
  console.log('PASS native clipboard image: PNG upload, approval for one connection');

  setStage('AT.5 local tab');
  await showConnections();
  await page.locator('.local-targets').getByTitle('명령 프롬프트 새 터미널 열기').click();
  const local = page.getByRole('region', { name: '명령 프롬프트 터미널', exact: true });
  await expect(local.locator('.connection-message')).toContainText('로컬 ·');
  await expect(local.locator('.xterm-accessibility-tree')).toContainText('>');
  await drop([attached], local);
  await expect(local.locator('.xterm-accessibility-tree')).toContainText('attach 1.txt"');
  await drop(['\\\\server\\share\\a.txt'], local);
  await expect(local.locator('.connection-message')).toContainText('쓸 수 없는 경로');
  await page.getByRole('button', { name: '명령 프롬프트 탭 닫기' }).click();
  console.log('PASS native local tab types a quoted path, refuses a share and uploads nothing');

  setStage('AT.6 server ports');
  docker([
    'exec',
    '-d',
    '-u',
    'probe',
    container,
    'python3',
    '-m',
    'http.server',
    String(serverPort),
    '--bind',
    '127.0.0.1',
    '-d',
    '/tmp',
  ]);
  const connectionId = await pane().getAttribute('data-connection-id');
  await expect
    .poll(async () => (await invoke('remote_ports', { id: connectionId })).map((p) => p.port))
    .toContain(serverPort);
  await page.locator('.toolbar-menu > summary').filter({ hasText: '도구' }).click();
  await page.getByRole('button', { name: '터널', exact: true }).click();
  const tunnels = page.getByRole('dialog', { name: 'SSH 터널', exact: true });
  await tunnels.getByRole('button', { name: '서버 포트 보기', exact: true }).click();
  const ports = page.getByRole('dialog', { name: '서버 포트 열기', exact: true });
  await expect(ports).toContainText(`127.0.0.1:${serverPort}`);
  const systemPort = ports.getByRole('button', { name: '포트 22 열기', exact: true });
  await expect(systemPort).toHaveCount(0);
  await ports.getByLabel('1024 미만도 표시').check();
  await expect(systemPort).toBeVisible();
  await ports.getByRole('button', { name: `포트 ${serverPort} 열기`, exact: true }).click();
  const runningRow = ports.getByRole('region', { name: '실행 중인 임시 터널' });
  await expect(runningRow).toContainText(`127.0.0.1:${serverPort}`);
  const status = (await invoke('tunnel_list')).find((s) => s.targetPort === serverPort);
  assert.equal(status.status, 'running');
  assert((await fetch(`http://127.0.0.1:${status.port}/`)).ok, 'the tunnel must reach the server');
  assert(
    !(await invoke('tunnel_configs')).some((c) => c.targetPort === serverPort),
    'a temporary tunnel must not be saved',
  );
  await page.screenshot({ path: path.join(screenshots, 'server-ports.png') });
  await runningRow.getByRole('button', { name: '중지', exact: true }).click();
  await expect(runningRow).toHaveCount(0);
  await expect
    .poll(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${status.port}/`)).ok;
      } catch {
        return false;
      }
    })
    .toBe(false);
  await ports.getByRole('button', { name: '대화상자 닫기' }).click();
  await tunnels.getByRole('button', { name: '대화상자 닫기' }).click();
  console.log('PASS native server ports: list, system ports hidden, real tunnel, stop, not saved');

  setStage('AT.6 server link');
  // Not `clear`: this tab's scrollback belongs to later checks.
  const serverLink = `http://localhost:${serverPort}/app?x=1`;
  await command(`printf '${serverLink}\\n'`);
  await output(serverLink);
  const rows = pane().locator('.xterm-rows > div');
  const linkRow = await rows.evaluateAll(
    (all, text) => all.findIndex((row) => row.textContent.includes(text)),
    serverLink,
  );
  assert(linkRow >= 0, 'the printed link must be on screen');
  const screen = await pane().locator('.xterm-screen').boundingBox();
  const rowHeight = (await rows.first().boundingBox()).height;
  const linkY = screen.y + rowHeight * (linkRow + 0.5);
  await page.mouse.move(screen.x + 40, linkY);
  await sleep(150);
  await page.keyboard.down('Control');
  await page.mouse.click(screen.x + 40, linkY);
  await page.keyboard.up('Control');
  await expect(ports).toContainText(serverLink);
  await expect(
    ports.getByRole('button', { name: '터널 열고 브라우저로 열기', exact: true }),
  ).toBeVisible();
  assert(
    !(await invoke('tunnel_list')).some(
      (s) => s.targetPort === serverPort && s.status === 'running',
    ),
    'a link must not open a tunnel before the user chooses',
  );
  await ports.getByRole('button', { name: '대화상자 닫기' }).click();
  console.log('PASS native Ctrl+click on a server address asks before opening a tunnel');

  setStage('DX.3 tmux session');
  await page.locator('header').getByRole('button', { name: '＋ 새 연결', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('이름', { exact: true }).fill('tmux 테스트');
  await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await form.getByLabel('포트', { exact: true }).fill(probe('PORT'));
  await form.getByLabel('사용자', { exact: true }).fill('probe');
  await form.getByLabel('비밀번호', { exact: true }).fill(probe('PASSWORD'));
  await form.getByLabel('인증정보 보관', { exact: true }).selectOption('replace');
  await form.locator('summary', { hasText: '고급 옵션' }).click();
  await form.getByLabel('tmux 세션 이름').fill(tmuxName);
  await form.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  await connected();
  await expect(pane().locator('.connection-message')).toContainText(`tmux ${tmuxName}`);
  assert(tmux('list-sessions', '-F', '#{session_name}').split('\n').includes(tmuxName));
  await command(`export DX_MARK=keepme; printf 'TMUX_SHELL<%s>\\n' "$TMUX"`);
  await output('TMUX_SHELL</tmp/tmux-');
  await typeInput("printf 'TMUX_한글_OK\\n'");
  await page.keyboard.press('Enter');
  await output('TMUX_한글_OK');
  await command('cd /tmp');
  const tmuxId = await pane().getAttribute('data-connection-id');
  await expect.poll(() => invoke('tmux_current_path', { id: tmuxId })).toBe('/tmp');
  assert(!tmux('capture-pane', '-p', '-t', `=${tmuxName}:`).includes('DachsTermHook'));
  await command(
    "nohup sh -c 'while :; do date +%s >> /tmp/dx-alive; sleep 1; done' >/dev/null 2>&1 &",
  );
  console.log(
    'PASS native tmux session starts by exec, keeps Korean, reports its folder, no typing',
  );

  setStage('DX.3 reconnect');
  const widthBefore = tmux('display-message', '-p', '-t', `=${tmuxName}:`, '#{window_width}');
  await pane().getByRole('button', { name: '연결 종료', exact: true }).click();
  await expect(pane().getByRole('button', { name: '재접속', exact: true })).toBeVisible();
  assert(tmux('list-sessions', '-F', '#{session_name}').includes(tmuxName), 'session must survive');
  const alive = Number(shell('wc -l < /tmp/dx-alive'));
  await sleep(2500);
  assert(Number(shell('wc -l < /tmp/dx-alive')) > alive, 'work must continue while disconnected');
  await pane().getByRole('button', { name: '재접속', exact: true }).click();
  await connected();
  await command(`printf 'MARK<%s>\\n' "$DX_MARK"`);
  await output('MARK<keepme>');
  assert.equal(tmux('list-sessions', '-F', '#{session_name}').split('\n').length, 1);
  assert.equal(
    tmux('display-message', '-p', '-t', `=${tmuxName}:`, '#{window_width}'),
    widthBefore,
    'tmux must follow the terminal size after reattaching',
  );
  await page.screenshot({ path: path.join(screenshots, 'tmux-reconnect.png') });
  console.log('PASS native reconnect returns to the same tmux shell and running work continues');

  setStage('DX.4 hook status');
  tmux('set-option', '-g', 'allow-passthrough', 'on');
  const hook = (state) =>
    `printf '\\033Ptmux;\\033\\033]777;DachsTerm;status;${state}\\007\\033\\\\'`;
  const badge = page.locator('.session-tab.selected .program-status');
  await command(hook('working'));
  await expect(badge).toHaveClass(/working/);
  await command(hook('blocked'));
  await expect(badge).toHaveClass(/blocked/);
  // Not a report to act on: only the four words count, and the tab keeps its last state.
  await command(hook('pwned'));
  await sleep(300);
  await expect(badge).toHaveClass(/blocked/);
  const hiddenWindow = hook('error');
  tmux('new-window', '-d', '-t', `=${tmuxName}:`, `sleep 1; ${hiddenWindow}; sleep 3`);
  await sleep(2500);
  await expect(badge).toHaveClass(/blocked/);
  // On the open tab a result stays until the user acts, because they may be in another window.
  await command(hook('done'));
  await expect(badge).toHaveClass(/done/);
  await sleep(500);
  await expect(badge).toHaveClass(/done/);
  await page.keyboard.press('Backspace');
  await expect(badge).toHaveCount(0);
  // A finished state shows on a tab the user is not looking at, and clears on coming back.
  await command(`sleep 2; ${hook('done')}`);
  await page.getByRole('tab', { name: /^OpenSSH 테스트/ }).click();
  const tmuxTab = page.locator('.session-tab').filter({ hasText: 'tmux 테스트' });
  await expect(tmuxTab.locator('.program-status')).toHaveClass(/done/, { timeout: 8000 });
  await tmuxTab.getByRole('tab').click();
  await expect(tmuxTab.locator('.program-status')).toHaveCount(0);
  console.log('PASS native hook status reaches the tab, hidden tmux windows do not (documented)');

  setStage('DX.3 close and missing tmux');
  await page.getByRole('button', { name: 'tmux 테스트 탭 닫기', exact: true }).click();
  const closeNote = page.locator('[role=alert]').filter({ hasText: '계속 실행됩니다' });
  await expect(closeNote).toBeVisible();
  await closeNote.getByRole('button', { name: '오류 닫기' }).click();
  assert(tmux('list-sessions', '-F', '#{session_name}').includes(tmuxName));
  tmux('kill-server');
  docker(['exec', container, 'mv', '/usr/bin/tmux', '/usr/bin/tmux.hidden']);
  try {
    await showConnections();
    await page
      .locator('.profile-card')
      .filter({ hasText: 'tmux 테스트' })
      .getByRole('button', { name: '연결', exact: true })
      .click();
    await expect(pane().locator('.connection-message')).toContainText('tmux가 없어', {
      timeout: 15000,
    });
    await command("printf 'PLAIN_SHELL_OK\\n'");
    await output('PLAIN_SHELL_OK');
    assert(!(await pane().locator('.xterm-accessibility-tree').innerText()).includes('DachsTerm'));
  } finally {
    docker(['exec', container, 'mv', '/usr/bin/tmux.hidden', '/usr/bin/tmux']);
  }
  await page.getByRole('button', { name: 'tmux 테스트 탭 닫기', exact: true }).click();
  await expect(closeNote).toHaveCount(0);
  const profile = (await invoke('sessions')).profiles.find((p) => p.name === 'tmux 테스트');
  assert.equal(profile.tmuxSession, tmuxName);
  await invoke('delete_session', { id: profile.id });
  await page.locator('.tab-strip').getByRole('tab').first().click();
  console.log('PASS native first close note, and a server without tmux gets a plain shell');
}
