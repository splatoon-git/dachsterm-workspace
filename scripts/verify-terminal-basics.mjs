import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  chooseProfileMenu,
  closeTerminalSettings,
  openNewConnectionForm,
  openTerminalSearch,
  openTerminalSettings,
  showSidebarView,
} from './native-workspace.mjs';

export async function verifyTerminalBasics({
  page,
  pane,
  command,
  output,
  directory,
  probe,
  setStage,
}) {
  setStage('S1 terminal follow');
  await expect(page.getByLabel('터미널 경로 따라가기', { exact: true })).toBeChecked();
  // The view right after connecting is checked in test-native.mjs; the agent stages ran since
  // and left the sidebar on connections and the shell elsewhere.
  await showSidebarView(page, '파일');
  await command('cd /home/probe');
  await expect(page.getByLabel('원격 경로', { exact: true })).toHaveValue('/home/probe', {
    timeout: 20000,
  });
  await expect(pane().locator('.xterm-accessibility-tree')).toContainText('probe@');
  expect(await pane().locator('.xterm-accessibility-tree').innerText()).not.toContain(
    '__dachsterm_cwd',
  );
  await command(`printf 'HISTORY:%s\\n' "$(history | grep -c '__dachsterm[_]cwd')"`);
  await output('HISTORY:0');
  await command('cd /tmp');
  await expect(page.getByLabel('원격 경로', { exact: true })).toHaveValue('/tmp');
  await page.getByLabel('터미널 경로 따라가기', { exact: true }).uncheck();
  await command('cd /home/probe');
  await output('probe@');
  await expect(page.getByLabel('원격 경로', { exact: true })).toHaveValue('/tmp');
  await showSidebarView(page, '연결');
  await showSidebarView(page, '파일');
  await expect(page.getByLabel('터미널 경로 따라가기', { exact: true })).not.toBeChecked();
  await page.getByLabel('터미널 경로 따라가기', { exact: true }).check();
  await expect(page.getByLabel('원격 경로', { exact: true })).toHaveValue('/home/probe');
  // Disable for the existing file tests, which intentionally navigate independently.
  await page.getByLabel('터미널 경로 따라가기', { exact: true }).uncheck();
  await showSidebarView(page, '연결');
  console.log('PASS SFTP follows actual Bash cwd; off/on and sidebar remount preserve choice');

  const cdp = await page.context().newCDPSession(page);
  setStage('S1 terminal mouse');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const previous = await page.evaluate(() => navigator.clipboard.readText());
  try {
    await command("printf 'DRAG_COPY_OK\\n'");
    await output('DRAG_COPY_OK');
    const line = pane()
      .locator('.xterm-accessibility-tree div')
      .filter({ hasText: /^DRAG_COPY_OK$/ })
      .last();
    // xterm is canvas-rendered: drag across the corresponding visible canvas row.
    const row = await line.boundingBox();
    assert(row);
    await page.mouse.move(row.x + 1, row.y + row.height / 2);
    await page.mouse.down();
    await page.mouse.move(row.x + 12 * 9, row.y + row.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(async () => (await navigator.clipboard.readText()).includes('DRAG_COPY_OK')),
      )
      .toBe(true);

    await command('stty echo');
    await page.evaluate(() => navigator.clipboard.writeText("printf 'RIGHT_CLICK_OK\\n'"));
    await pane().locator('.live-terminal').click({ button: 'right' });
    await output("printf 'RIGHT_CLICK_OK");
    await page.keyboard.press('Enter');
    await output('RIGHT_CLICK_OK');
    await page.evaluate(() => navigator.clipboard.writeText("printf 'SHORTCUT_PASTE_OK\\n'"));
    await pane().locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Control+Shift+V');
    await output("printf 'SHORTCUT_PASTE_OK");
    await page.keyboard.press('Enter');
    await output('SHORTCUT_PASTE_OK');
    await page.evaluate(() =>
      navigator.clipboard.writeText("printf 'MULTILINE_ONE\\n'\nprintf 'MULTILINE_TWO\\n'\n"),
    );
    await pane().locator('.live-terminal').click({ button: 'right' });
    await expect(
      pane().getByText('여러 줄 또는 제어문자가 포함되어 있습니다.', { exact: false }),
    ).toBeVisible();
    await expect(pane().getByLabel('붙여넣을 내용', { exact: true })).toContainText(
      "printf 'MULTILINE_TWO",
    );
    await pane().getByRole('button', { name: '취소', exact: true }).click();
    await command("printf 'PASTE_CANCELLED_OK\\n'");
    await output('PASTE_CANCELLED_OK');
    await expect(pane().locator('.xterm-accessibility-tree')).not.toContainText('MULTILINE_TWO');
    // A program copying through OSC 52, in the form a real program sent when measured.
    await page.evaluate(() => navigator.clipboard.writeText('BEFORE_OSC52'));
    await command(`printf '\\033]52;c;%s\\007' "$(printf 'OSC52_OK' | base64)"`);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('OSC52_OK');
    await command(`printf '\\033]52;c;?\\007'`);
    await command("printf 'OSC52_READ_REFUSED\\n'");
    await output('OSC52_READ_REFUSED');
    await command('stty -echo');
    console.log('PASS native drag-copy, right-click paste, shortcut paste, multiline cancellation');
  } finally {
    await page.evaluate((text) => navigator.clipboard.writeText(text), previous);
    await cdp.detach();
  }

  await pane().locator('.xterm-helper-textarea').focus();
  await page.keyboard.type("printf 'KEY_EDIT_OK\\n'X");
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await output('KEY_EDIT_OK');
  await command('stty -a');
  await output('erase = ^?');
  await command('stty erase ^H');
  const preferences = await openTerminalSettings(page);
  await preferences.getByLabel('Backspace 전송', { exact: true }).selectOption('bs');
  await preferences.getByLabel('마우스 선택 시 자동 복사', { exact: true }).uncheck();
  await preferences.getByLabel('마우스 우클릭 붙여넣기', { exact: true }).uncheck();
  await preferences.getByLabel('새 파일 패널에서 터미널 경로 따라가기', { exact: true }).uncheck();
  await closeTerminalSettings(page);
  await pane().locator('.xterm-helper-textarea').focus();
  await page.keyboard.type("printf 'LEGACY_BS_OK\\n'X");
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await output('LEGACY_BS_OK');
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('dachsterm.terminalPreferences')),
  );
  assert.deepEqual(saved, {
    copyOnSelect: false,
    rightClickPaste: false,
    followDirectory: false,
    backspace: 'bs',
    macOptionAsMeta: false,
    programStatus: true,
    clipboardWrite: true,
    osNotifications: true,
    bellNotifications: true,
    programGuide: true,
    gitStatus: true,
    longCommandNotify: 30,
  });
  await openTerminalSettings(page);
  await preferences.getByLabel('Backspace 전송', { exact: true }).selectOption('del');
  for (const label of [
    '마우스 선택 시 자동 복사',
    '마우스 우클릭 붙여넣기',
    '새 파일 패널에서 터미널 경로 따라가기',
  ])
    await preferences.getByLabel(label, { exact: true }).check();
  await closeTerminalSettings(page);
  await command('stty erase ^?');
  console.log(
    'PASS native arrows/Home/End/Backspace and Ctrl+H compatibility; settings persistence',
  );

  setStage('terminal agent signals');
  const activeTab = page.locator('.tab-strip').getByRole('tab', { selected: true });
  await command(`printf '\\033]7501;state=blocked:kind=permission:app=check\\033\\\\'; sleep 3`);
  await expect(activeTab).toContainText('입력 대기');
  await expect(activeTab).toHaveAttribute('aria-label', /승인 필요/);
  // The shell prompt that follows means the program has ended.
  await expect(activeTab).toContainText('연결됨', { timeout: 8000 });
  // Read one key press while the program has opted in, and again after it has opted out.
  const readKey = (label) =>
    `IFS= read -r -s -t 3 -n 7 k; printf '\\033[<u'; printf '${label}<%q>\\n' "$k"`;
  await command(`printf '\\033[>5u'; ${readKey('KITTY')}`);
  await page.waitForTimeout(500);
  await page.keyboard.press('Shift+Enter');
  await output("KITTY<$'\\E[13;2u'>");
  await command(`read -r -s -t 3 -n 1 k; printf 'PLAIN<%q>\\n' "$k"`);
  await page.waitForTimeout(500);
  await page.keyboard.press('Shift+Enter');
  await output("PLAIN<''>");
  // tmux asks with modifyOtherKeys instead of the kitty protocol.
  await command(
    `printf '\\033[>4;1m'; IFS= read -r -s -t 3 -n 10 k; printf '\\033[>4m'; printf 'OTHER<%q>\\n' "$k"`,
  );
  await page.waitForTimeout(500);
  await page.keyboard.press('Shift+Enter');
  await output("OTHER<$'\\E[27;2;13~'>");
  console.log('PASS native program status on the tab; Shift+Enter differs only when requested');

  setStage('terminal notifications');
  // Which reports notify is covered by terminalNotify.test.ts. The IPC cannot be intercepted here,
  // so this shows one real OS notification and checks that the app reports no failure.
  const status = "printf '\\033]7501;state=blocked:app=check\\033\\\\'";
  await command(`sleep 2; ${status}; sleep 1`);
  // Focus outside the terminal, so the app counts as looking elsewhere.
  const search = await openTerminalSearch(page, pane());
  await search.focus();
  await page.waitForTimeout(2600);
  await expect(pane().locator('.connection-message')).not.toContainText('OS 알림');
  await pane().locator('.xterm-helper-textarea').focus();
  await page.waitForTimeout(1500);
  console.log('PASS native OS notification away from the pane reports no failure');

  setStage('S1 authentication');
  const keyPath = path.join(directory, 'rsa-ui-key');
  await writeFile(keyPath, probe('RSA_ENCRYPTED_KEY'), { mode: 0o600 });
  for (const [name, auth, port] of [
    ['S1 agent', 'agent', probe('PORT')],
    ['S1 interactive', 'interactive', probe('PORT')],
    ['S1 MFA', 'key', probe('MFA_PORT')],
  ]) {
    setStage(`S1 authentication ${auth}`);
    await openNewConnectionForm(page);
    const form = page.getByRole('dialog', { name: '새 연결', exact: true });
    await form.getByLabel('이름', { exact: true }).fill(name);
    await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('포트', { exact: true }).fill(port);
    await form.getByLabel('사용자', { exact: true }).fill('probe');
    await form.getByLabel('인증 방식', { exact: true }).selectOption(auth);
    if (auth === 'key') {
      await form.getByLabel('개인키 파일 경로', { exact: true }).fill(keyPath);
      await form
        .getByLabel('Passphrase (암호화되지 않은 키는 비워 두세요)', { exact: true })
        .fill(probe('PASSPHRASE'));
    }
    await form.getByRole('button', { name: '저장 후 연결', exact: true }).click();
    if (auth === 'key') {
      await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
    }
    if (auth === 'key' || auth === 'interactive') {
      const challenge = pane().getByRole('form', { name: '서버 추가 인증', exact: true });
      await expect(challenge).toBeVisible();
      await challenge.locator('input').fill(probe('PASSWORD'));
      await challenge.getByRole('button', { name: '인증 응답', exact: true }).click();
    }
    try {
      await expect(pane().locator('.connection-message')).toContainText('연결됨', {
        timeout: 20000,
      });
    } catch (error) {
      const message = await pane().locator('.connection-message').textContent();
      for (const code of [
        '에이전트',
        '시간',
        '인증이 거부',
        'Passphrase',
        '연결 중',
        '추가 인증',
        'allow-auth-reply',
      ])
        if (message?.includes(code)) console.log(`S1 failure category: ${code}`);
      throw error;
    }
    const stored = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('sessions'));
    assert.equal(stored.profiles.find((profile) => profile.name === name).hasSecret, false);
    console.log(`PASS native authentication mode ${auth}; no stored secret reference`);
    await expect(pane().getByRole('form', { name: '서버 추가 인증', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `${name} 탭 닫기`, exact: true }).click();
    await showSidebarView(page, '연결');
    const profile = page.locator('.profile-card').filter({ hasText: name });
    await chooseProfileMenu(page, profile, '삭제');
    await page.getByRole('button', { name: '세션 삭제', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '세션 삭제', exact: true })).toBeHidden();
    await expect(profile).toHaveCount(0);
  }
  console.log('PASS native SSH agent and encrypted RSA + server MFA form; secrets not retained');
}
