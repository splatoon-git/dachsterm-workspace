import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  await page.getByRole('tab', { name: '원격 파일', exact: true }).click();
  await expect(page.getByLabel('터미널 경로 따라가기', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: '셸 경로 알림 연결', exact: true }).click();
  await expect(page.getByLabel('원격 경로', { exact: true })).toHaveValue('/home/probe');
  await command('cd /tmp');
  await expect(page.getByLabel('원격 경로', { exact: true })).toHaveValue('/tmp');
  await page.getByLabel('터미널 경로 따라가기', { exact: true }).uncheck();
  await command('cd /home/probe');
  await output('probe@');
  await expect(page.getByLabel('원격 경로', { exact: true })).toHaveValue('/tmp');
  await page.getByRole('tab', { name: '연결', exact: true }).click();
  await page.getByRole('tab', { name: '원격 파일', exact: true }).click();
  await expect(page.getByLabel('터미널 경로 따라가기', { exact: true })).not.toBeChecked();
  await page.getByLabel('터미널 경로 따라가기', { exact: true }).check();
  await expect(page.getByLabel('원격 경로', { exact: true })).toHaveValue('/home/probe');
  // Disable for the existing file tests, which intentionally navigate independently.
  await page.getByLabel('터미널 경로 따라가기', { exact: true }).uncheck();
  await page.getByRole('tab', { name: '연결', exact: true }).click();
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
    await pane().getByRole('button', { name: '취소', exact: true }).click();
    await command("printf 'PASTE_CANCELLED_OK\\n'");
    await output('PASTE_CANCELLED_OK');
    await expect(pane().locator('.xterm-accessibility-tree')).not.toContainText('MULTILINE_TWO');
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
  await pane().getByRole('button', { name: '터미널 설정', exact: true }).click();
  const preferences = page.getByRole('dialog', { name: '터미널 설정', exact: true });
  await preferences.getByLabel('Backspace 전송', { exact: true }).selectOption('bs');
  await preferences.getByLabel('마우스 선택 시 자동 복사', { exact: true }).uncheck();
  await preferences.getByLabel('마우스 우클릭 붙여넣기', { exact: true }).uncheck();
  await preferences.getByLabel('새 SFTP 탐색기의 터미널 경로 따라가기', { exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await pane().locator('.xterm-helper-textarea').focus();
  await page.keyboard.type("printf 'LEGACY_BS_OK\\n'X");
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await output('LEGACY_BS_OK');
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('daxterm.terminalPreferences')),
  );
  assert.deepEqual(saved, {
    copyOnSelect: false,
    rightClickPaste: false,
    followDirectory: false,
    backspace: 'bs',
  });
  await pane().getByRole('button', { name: '터미널 설정', exact: true }).click();
  await preferences.getByLabel('Backspace 전송', { exact: true }).selectOption('del');
  for (const label of [
    '마우스 선택 시 자동 복사',
    '마우스 우클릭 붙여넣기',
    '새 SFTP 탐색기의 터미널 경로 따라가기',
  ])
    await preferences.getByLabel(label, { exact: true }).check();
  await page.keyboard.press('Escape');
  await command('stty erase ^?');
  console.log(
    'PASS native arrows/Home/End/Backspace and Ctrl+H compatibility; settings persistence',
  );

  setStage('S1 authentication');
  const keyPath = path.join(directory, 'rsa-ui-key');
  await writeFile(keyPath, probe('RSA_ENCRYPTED_KEY'), { mode: 0o600 });
  for (const [name, auth, port] of [
    ['S1 agent', 'agent', probe('PORT')],
    ['S1 interactive', 'interactive', probe('PORT')],
    ['S1 MFA', 'key', probe('MFA_PORT')],
  ]) {
    setStage(`S1 authentication ${auth}`);
    await page.locator('header').getByRole('button', { name: '＋ 새 연결', exact: true }).click();
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
    const profile = page.locator('.profile-card').filter({ hasText: name });
    await profile.locator('summary').click();
    await profile.getByRole('button', { name: '삭제', exact: true }).click();
    await page.getByRole('button', { name: '세션 삭제', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '세션 삭제', exact: true })).toBeHidden();
    await expect(profile).toHaveCount(0);
  }
  console.log('PASS native SSH agent and encrypted RSA + server MFA form; secrets not retained');
}
