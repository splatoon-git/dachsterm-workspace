import { test, expect } from '@playwright/test';
test('narrow snippet editor and explicit program metadata expand/clear without losing pin', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/tests/ui/fixtures/assistant.html');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('이름', { exact: true }).fill('좁은 화면 확인');
  await dialog.getByLabel('명령 본문', { exact: true }).fill('echo {{값}}');
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await dialog.getByLabel('명령 본문', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'target/verification/snippet-360.png' });
  await page.keyboard.press('Escape');
  const guide = page.getByRole('complementary');
  await guide.getByRole('button', { name: '조작표 열기', exact: true }).click();
  await guide.getByLabel('실행 알림 사용').check();
  await guide.getByRole('button', { name: '조작표 접기', exact: true }).click();
  await page.evaluate(() => window.__guide('cat'));
  await expect(guide.getByRole('button', { name: '조작표 · cat 접기', exact: true })).toBeVisible();
  await page.evaluate(() => window.__guide(null));
  await expect(guide.getByRole('button', { name: '조작표 열기', exact: true })).toBeVisible();
  await guide.getByRole('button', { name: '조작표 열기', exact: true }).click();
  await guide.getByLabel('조작표 선택·고정').selectOption('vim');
  await page.evaluate(() => {
    window.__guide('cat');
    window.__guide(null);
  });
  await expect(guide.getByRole('button', { name: '조작표 · vim 접기', exact: true })).toBeVisible();
});
test('explicit multi-target review cancels without sending and sends once after confirmation', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/assistant.html');
  const dialog = page.getByRole('dialog', { name: '스니펫', exact: true });
  await dialog.getByLabel('명령 본문', { exact: true }).fill('echo 한글');
  await dialog.getByRole('checkbox', { name: /테스트 로컬/ }).check();
  await dialog.getByRole('button', { name: 'Enter 포함 실행 · 미리보기' }).click();
  await expect(dialog.locator('li')).toHaveCount(2);
  await dialog.getByRole('button', { name: '돌아가기' }).click();
  expect(await page.evaluate(() => window.__sent)).toEqual([]);
  await dialog.getByRole('button', { name: 'Enter 포함 실행 · 미리보기' }).click();
  await dialog.getByRole('button', { name: '확인 · 실행' }).focus();
  await page.keyboard.press('Enter');
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
test('snippet CRUD, restore, literal preview, target isolation and reconnect rejection', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/assistant.html');
  const dialog = page.getByRole('dialog', { name: '스니펫', exact: true });
  await dialog.getByLabel('이름', { exact: true }).fill('로그 확인');
  await dialog.getByLabel('그룹', { exact: true }).fill('운영');
  await dialog.getByLabel('태그', { exact: true }).fill('linux');
  await dialog.getByLabel('명령 본문', { exact: true }).fill("printf '{{경로}}'\necho done");
  await dialog.getByLabel('저장 내용에 인증정보가 없습니다.').check();
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('저장했습니다');
  await page.reload();
  await dialog.getByRole('button', { name: '로그 확인' }).click();
  await dialog.getByLabel('스니펫 검색').fill('운영 linux');
  await expect(dialog.getByRole('button', { name: '로그 확인' })).toBeVisible();
  await dialog.getByLabel('경로', { exact: true }).fill('한글 $HOME');
  await expect(dialog.getByText('PodTree', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '입력만 넣기 · 미리보기' }).click();
  await expect(dialog.locator('pre')).toHaveText("printf '한글 $HOME'\necho done");
  await expect(dialog.getByRole('button', { name: '확인 · 입력' })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '확인 · 입력' }).click();
  expect(await page.evaluate(() => window.__sent)).toEqual([
    {
      targets: [{ id: 'id-one', bracketed: true }],
      body: "printf '한글 $HOME'\necho done",
      execute: false,
    },
  ]);
  await dialog.getByLabel('경로', { exact: true }).fill('path');
  await dialog.getByRole('button', { name: 'Enter 포함 실행 · 미리보기' }).click();
  await page.evaluate(() => window.__invalidate());
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '확인 · 실행' }).click();
  await expect(dialog.getByRole('status')).toContainText('바뀌었습니다');
  expect(await page.evaluate(() => window.__sent.length)).toBe(1);
  await dialog.getByRole('button', { name: '복제', exact: true }).click();
  await expect(dialog.getByLabel('이름', { exact: true })).toHaveValue('로그 확인 복사');
  await dialog.getByLabel('저장 내용에 인증정보가 없습니다.').check();
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('저장했습니다');
  await dialog.getByRole('button', { name: '삭제', exact: true }).click();
  await dialog.getByRole('button', { name: '삭제 확인', exact: true }).click();
  await expect(
    dialog
      .getByRole('region', { name: '저장된 스니펫' })
      .getByRole('button', { name: '로그 확인 복사' }),
  ).toHaveCount(0);
});
for (const width of [360, 800])
  test(`catalog copy and keyboard guide at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/tests/ui/fixtures/assistant.html');
    await page.getByRole('button', { name: '대화상자 닫기' }).click();
    await page.getByRole('button', { name: '명령 열기', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('기본 명령 검색').fill('둘 중 하나');
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
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /조작표 .*열기/ }).click();
    await page.getByLabel('조작표 선택·고정').selectOption('vim');
    await expect(page.getByRole('complementary')).toContainText(':q! + Enter');
    await page.getByRole('button', { name: '끄기', exact: true }).click();
    await expect(page.getByLabel('조작표 선택·고정')).toHaveCount(0);
  });
