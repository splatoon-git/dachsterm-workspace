import { test, expect } from '@playwright/test';
const secretCheck = '비밀번호·개인키·Passphrase·OTP 같은 인증정보가 들어 있지 않습니다.';
const stored = (body: string) =>
  JSON.stringify({
    revision: 0,
    items: [{ id: 's1', name: '인사', description: '', body, group: '', tags: '' }],
  });

test('narrow snippet editor and explicit program metadata expand/clear without losing pin', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/tests/ui/fixtures/assistant.html');
  const dialog = page.getByRole('dialog', { name: '명령', exact: true });
  await expect(dialog.getByText('저장된 스니펫이 없습니다')).toBeVisible();
  await dialog.getByRole('button', { name: '새 스니펫', exact: true }).first().click();
  await dialog.getByLabel('이름', { exact: true }).fill('좁은 화면 확인');
  await dialog.getByLabel('명령 본문', { exact: true }).fill('echo {{값}}');
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await dialog.getByLabel('명령 본문', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'target/verification/snippet-360.png' });
  await page.keyboard.press('Escape');
  const guide = page.getByRole('group', { name: '프로그램 조작표' });
  const full = page.getByRole('region', { name: '조작표 전체 보기' });
  // The guide is on by default, so a program notice shows without any opt-in.
  await page.evaluate(() => window.__guide('cat'));
  await expect(guide).toContainText('cat');
  await expect(guide.getByRole('button', { name: '전체 보기', exact: true })).toBeVisible();
  await page.evaluate(() => window.__guide(null));
  await expect(guide.getByRole('button', { name: '전체 보기', exact: true })).toHaveCount(0);
  // A full-screen program the hook cannot name gets the general notice, never a guessed name.
  await page.evaluate(() => window.__alternate(true));
  await expect(guide.locator('.guide-inline strong')).toHaveText('전체 화면 프로그램 실행 중');
  await expect(guide.getByRole('button', { name: '전체 보기', exact: true })).toBeVisible();
  await page.evaluate(() => window.__alternate(false));
  await expect(guide.locator('.guide-inline')).toHaveCount(0);
  await page.getByRole('button', { name: '조작표 전체 보기', exact: true }).click();
  await full.getByLabel('조작표 선택·고정').selectOption('vim');
  await page.evaluate(() => {
    window.__guide('cat');
    window.__guide(null);
  });
  await expect(guide.locator('.guide-inline strong')).toHaveText('vim');
  await expect(guide.getByRole('button', { name: '고정 해제', exact: true })).toBeVisible();
});
test('a snippet goes once to each chosen terminal and never to an excluded one', async ({
  page,
}) => {
  await page.addInitScript(
    (value) => localStorage.setItem('fixture.snippets', value),
    stored('echo 한글'),
  );
  await page.goto('/tests/ui/fixtures/assistant.html');
  const dialog = page.getByRole('dialog', { name: '명령', exact: true });
  const targets = dialog.getByRole('region', { name: '보낼 터미널' });
  // The active terminal starts chosen; PodTree is never offered.
  await expect(targets.getByRole('checkbox', { name: /테스트 SSH/ })).toBeChecked();
  await expect(targets.getByText('PodTree', { exact: true })).toHaveCount(0);
  await targets.getByRole('checkbox', { name: /테스트 SSH/ }).uncheck();
  await expect(dialog.getByRole('button', { name: '실행', exact: true })).toBeDisabled();
  await targets.getByRole('checkbox', { name: /테스트 SSH/ }).check();
  await targets.getByRole('checkbox', { name: /테스트 로컬/ }).check();
  await expect(dialog.getByTestId('snippet-preview')).toHaveText('echo 한글');
  await dialog.getByRole('button', { name: '실행', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('2개 터미널에 실행했습니다');
  expect(await page.evaluate(() => window.__sent)).toEqual([
    {
      targets: [
        { id: 'id-one', bracketed: true },
        { id: 'id-two', bracketed: true },
      ],
      body: 'echo 한글',
      execute: true,
    },
  ]);
});
test('snippet CRUD, restore, literal preview and the multi-line check', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/assistant.html');
  const dialog = page.getByRole('dialog', { name: '명령', exact: true });
  await dialog.getByRole('button', { name: '새 스니펫', exact: true }).first().click();
  await dialog.getByLabel('이름', { exact: true }).fill('로그 확인');
  await dialog.getByLabel('그룹', { exact: true }).fill('운영');
  await dialog.getByLabel('태그', { exact: true }).fill('linux');
  await dialog.getByLabel('명령 본문', { exact: true }).fill("printf '{{경로}}'\necho done");
  await expect(dialog.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await dialog.getByLabel(secretCheck).check();
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  const list = dialog.locator('#command-list');
  await expect(list.getByRole('button', { name: /로그 확인/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await page.reload();
  await dialog.getByLabel('명령 검색').fill('운영 linux');
  await expect(list.getByRole('button', { name: /로그 확인/ })).toBeVisible();
  await expect(dialog.getByTestId('snippet-preview')).toHaveText("printf '경로'\necho done");
  await dialog.getByLabel('경로', { exact: true }).fill('한글 $HOME');
  await expect(dialog.getByTestId('snippet-preview')).toHaveText("printf '한글 $HOME'\necho done");
  await dialog.getByRole('button', { name: '입력만 넣기', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('확인란');
  expect(await page.evaluate(() => window.__sent)).toEqual([]);
  await dialog.getByLabel(/넣기만 해도 실행될 수 있음/).check();
  await dialog.getByRole('button', { name: '입력만 넣기', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('1개 터미널에 넣었습니다');
  expect(await page.evaluate(() => window.__sent)).toEqual([
    {
      targets: [{ id: 'id-one', bracketed: true }],
      body: "printf '한글 $HOME'\necho done",
      execute: false,
    },
  ]);
  // The values are for one send only.
  await expect(dialog.getByLabel('경로', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: '스니펫 복제', exact: true }).click();
  await expect(dialog.getByLabel('이름', { exact: true })).toHaveValue('로그 확인 복사');
  await dialog.getByLabel(secretCheck).check();
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await dialog.getByLabel('명령 검색').fill('');
  const copy = list.getByRole('button', { name: /로그 확인 복사/ });
  await copy.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^삭제/ }).click();
  await dialog.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(copy).toHaveCount(0);
  await expect(list.getByRole('button', { name: /로그 확인/ })).toHaveCount(1);
});
for (const width of [360, 800])
  test(`basic commands copy, become a snippet, and keyboard guide at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/tests/ui/fixtures/assistant.html');
    const dialog = page.getByRole('dialog', { name: '명령', exact: true });
    await dialog.getByRole('tab', { name: '기본 명령' }).click();
    await dialog.getByLabel('명령 검색').fill('둘 중 하나');
    await dialog.getByRole('button', { name: '둘 중 하나 포함 · OR 복사' }).click();
    expect(await page.evaluate(() => window.__clipboard)).toBe(
      "grep -F -e '문구1' -e '문구2' -- '파일명'",
    );
    await page.evaluate(() => {
      window.__copyFail = true;
    });
    await dialog.getByRole('button', { name: '둘 중 하나 포함 · OR 복사' }).click();
    await expect(dialog.getByRole('status')).toContainText('복사하지 못했습니다');
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: `target/verification/assistant-${width}.png` });
    await dialog.getByRole('button', { name: '내 스니펫으로 저장', exact: true }).click();
    await expect(dialog.getByLabel('명령 본문', { exact: true })).toHaveValue(
      "grep -F -e '{{문구1}}' -e '{{문구2}}' -- '{{파일명}}'",
    );
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '조작표 전체 보기', exact: true }).click();
    await page.getByLabel('조작표 선택·고정').selectOption('vim');
    await expect(page.getByRole('region', { name: '조작표 전체 보기' })).toContainText(
      ':q! + Enter',
    );
    await page.getByRole('button', { name: '조작표 닫기', exact: true }).click();
    await expect(page.getByLabel('조작표 선택·고정')).toHaveCount(0);
  });
test('basic commands include the read-only Git group, found by search too', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/assistant.html');
  const dialog = page.getByRole('dialog', { name: '명령', exact: true });
  await dialog.getByRole('tab', { name: '기본 명령' }).click();
  const git = dialog.getByRole('group', { name: 'Git', exact: true });
  await expect(git).toBeVisible();
  await expect(git.getByRole('button', { name: '변경 상태 git status' })).toBeVisible();
  await dialog.getByLabel('명령 검색').fill('worktree');
  await expect(dialog.getByRole('group', { name: 'Git', exact: true })).toContainText(
    'git worktree list',
  );
  await dialog.getByRole('button', { name: '작업 폴더(worktree) 목록 복사' }).click();
  expect(await page.evaluate(() => window.__clipboard)).toBe('git worktree list');
});
test('the search box moves through the list with the arrow keys', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/assistant.html');
  const dialog = page.getByRole('dialog', { name: '명령', exact: true });
  await dialog.getByRole('tab', { name: '기본 명령' }).click();
  const search = dialog.getByLabel('명령 검색');
  await search.focus();
  const current = dialog.locator('.cmd-item[aria-current]');
  const first = (await current.textContent()) ?? '';
  await page.keyboard.press('ArrowDown');
  await expect(current).not.toHaveText(first);
  await page.keyboard.press('ArrowUp');
  await expect(current).toHaveText(first);
  await page.keyboard.press('Enter');
  await expect(dialog.locator('.cmd-actions button.primary')).toBeFocused();
});
test('turning the guide off in settings hides automatic guides but keeps a pin', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('dachsterm.terminalPreferences', JSON.stringify({ programGuide: false })),
  );
  await page.goto('/tests/ui/fixtures/assistant.html');
  await page.getByRole('button', { name: '대화상자 닫기' }).click();
  const guide = page.getByRole('group', { name: '프로그램 조작표' });
  await page.evaluate(() => {
    window.__guide('cat');
    window.__alternate(true);
  });
  await expect(guide.locator('.guide-inline')).toHaveCount(0);
  await page.getByRole('button', { name: '조작표 전체 보기', exact: true }).click();
  await page.getByLabel('조작표 선택·고정').selectOption('less');
  await expect(guide.locator('.guide-inline strong')).toHaveText('less');
});
