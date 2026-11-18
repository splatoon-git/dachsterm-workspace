import { expect, test } from '@playwright/test';
import type {} from './fixtures/transfer';

test('preview, missing user, selection, failure retry and cancellation do not lose state', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/transfer.html');
  await page.getByRole('button', { name: '파일 선택 · 미리보기' }).click();
  await expect(page.getByRole('button', { name: '2개 세션 추가' })).toBeDisabled();
  await page.getByRole('checkbox').nth(1).uncheck();
  await page.getByLabel('개발 서버 사용자명').fill('developer');
  await page.evaluate(() => {
    window.__transferTest.fail = true;
  });
  await page.getByRole('button', { name: '1개 세션 추가' }).click();
  await expect(page.getByRole('alert')).toContainText('가져오기 실패 테스트');
  await expect(page.getByLabel('개발 서버 사용자명')).toHaveValue('developer');
  await page.evaluate(() => {
    window.__transferTest.fail = false;
  });
  await page.getByRole('button', { name: '1개 세션 추가' }).click();
  await expect(page.getByRole('status')).toHaveText('1개 세션을 추가했습니다.');
  const applied = JSON.parse(await page.evaluate(() => window.__transferTest.applied[0]));
  expect(applied.profiles.map((p: { id: string }) => p.id)).toEqual(['one']);
  expect(applied.groups.map((g: { id: string }) => g.id)).toEqual(['g']);
  expect(applied.tunnels).toEqual([]);
  await page.evaluate(() => {
    window.__transferTest.cancel = true;
  });
  await page.getByRole('button', { name: '파일 선택 · 미리보기' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  expect(await page.evaluate(() => window.__transferTest.applied.length)).toBe(1);
});
for (const width of [1280, 560, 360]) {
  test(`transfer preview wraps and scrolls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/tests/ui/fixtures/transfer.html?found');
    await page.getByRole('button', { name: '파일 선택 · 미리보기' }).click();
    for (const selector of ['dialog', '.found-sources', '.transfer-options', '.transfer-rows']) {
      expect(await page.locator(selector).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
        true,
      );
    }
    await page.screenshot({ path: `target/verification/transfer-${width}.png` });
    await page.getByRole('button', { name: '가져오기 취소', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
  });
}

test('a session that runs a command stays out until its command is ticked', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/transfer.html');
  await page.evaluate(() => {
    window.__transferTest.command = true;
  });
  await page.getByRole('button', { name: '파일 선택 · 미리보기' }).click();
  const approve = page.getByLabel('명령 경유 명령 승인');
  await expect(approve).not.toBeChecked();
  await expect(page.locator('.proxy-command-approval code')).toHaveText('ssh -W %h:%p bastion');
  await page.getByLabel('개발 서버 사용자명').fill('developer');
  await page.getByRole('button', { name: '전체 선택' }).click();
  await expect(approve).not.toBeChecked();
  await page.getByRole('button', { name: '2개 세션 추가' }).click();
  await expect(page.getByRole('status')).toHaveText('2개 세션을 추가했습니다.');
  const first = JSON.parse(await page.evaluate(() => window.__transferTest.applied[0]));
  expect(first.profiles.map((p: { id: string }) => p.id)).toEqual(['one', 'two']);
  expect(await page.evaluate(() => window.__transferTest.approved[0])).toEqual({
    token: 'plan',
    ids: [],
  });
  await page.getByRole('button', { name: '파일 선택 · 미리보기' }).click();
  await page.getByLabel('개발 서버 사용자명').fill('developer');
  await page.getByLabel('명령 경유 명령 승인').check();
  await page.getByRole('button', { name: '3개 세션 추가' }).click();
  expect(await page.evaluate(() => window.__transferTest.approved[1])).toEqual({
    token: 'plan',
    ids: ['cmd'],
  });
});

test('Telnet and serial sessions without a user name can be added', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/transfer.html');
  await page.evaluate(() => {
    window.__transferTest.consoles = true;
  });
  await page.getByRole('button', { name: '파일 선택 · 미리보기' }).click();
  // The SSH session still needs its user; the two consoles log in inside the terminal.
  await expect(page.getByRole('button', { name: '4개 세션 추가' })).toBeDisabled();
  await page.getByLabel('개발 서버 사용자명').fill('developer');
  await page.getByRole('button', { name: '4개 세션 추가' }).click();
  await expect(page.getByRole('status')).toHaveText('4개 세션을 추가했습니다.');
  const applied = JSON.parse(await page.evaluate(() => window.__transferTest.applied[0]));
  expect(applied.profiles.map((p: { id: string }) => p.id)).toEqual(['one', 'two', 'tel', 'ser']);
});

test('sessions found on this PC open as a preview under the program group', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/transfer.html?found&from=putty');
  const found = page.getByRole('group', { name: '이 PC에서 찾은 설정' });
  await expect(found).toContainText('PuTTY 세션 2개');
  await expect(found).toContainText('세션 북마크 0개 · 제외 1개');
  await expect(found).toContainText('OpenSSH config (읽지 못함)');
  // Nothing to import, or not readable: listed, but there is no preview to open.
  await expect(found.getByRole('button', { name: '미리보기' }).nth(1)).toBeDisabled();
  await expect(found.getByRole('button', { name: '미리보기' }).nth(2)).toBeDisabled();
  // Opened on the source asked for; the one already saved starts unticked.
  await expect(page.getByText('이미 저장된 세션과 같은 대상')).toBeVisible();
  const group = page.getByLabel(/새 ‘PuTTY’ 그룹 아래에 넣기/);
  await expect(group).toBeChecked();
  await page.getByRole('button', { name: '1개 세션 추가' }).click();
  await expect(page.getByRole('status')).toHaveText('1개 세션을 추가했습니다.');
  const placed = JSON.parse(await page.evaluate(() => window.__transferTest.applied[0]));
  expect(placed.profiles.map((p: { id: string }) => p.id)).toEqual(['lab']);
  const root = placed.groups.find((g: { name: string }) => g.name === 'PuTTY');
  expect(root.parentId).toBeNull();
  expect(placed.profiles[0].groupId).toBe(root.id);

  await found.getByRole('button', { name: '미리보기' }).first().click();
  await page.getByRole('button', { name: '전체 선택' }).click();
  await page.getByLabel(/새 ‘PuTTY’ 그룹 아래에 넣기/).uncheck();
  await page.getByRole('button', { name: '2개 세션 추가' }).click();
  await expect(page.getByRole('status')).toHaveText('2개 세션을 추가했습니다.');
  const kept = JSON.parse(await page.evaluate(() => window.__transferTest.applied[1]));
  expect(kept.groups.map((g: { name: string; parentId: string | null }) => g.parentId)).toEqual([
    null,
    'dev',
  ]);
  expect(kept.profiles.map((p: { groupId: string | null }) => p.groupId)).toEqual([null, 'seoul']);
});

test('the empty connection list offers what was found until dismissed', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/transfer.html?found&offer');
  const offer = page.getByRole('group', { name: '이 PC에서 찾은 세션' });
  // A source with nothing to import, or that could not be read, is left to the settings list.
  await expect(offer.getByRole('button')).toHaveText([
    'PuTTY 세션 2개 가져오기…',
    '다시 보지 않기',
  ]);
  await offer.getByRole('button', { name: 'PuTTY 세션 2개 가져오기…' }).click();
  expect(await page.evaluate(() => window.__transferTest.requests)).toEqual([
    { section: 'transfer', importFrom: 'putty' },
  ]);
  await offer.getByRole('button', { name: '다시 보지 않기' }).click();
  await expect(offer).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.import-offer')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('dachsterm.importOffer.dismissed'))).toBe(
    '1',
  );
});
