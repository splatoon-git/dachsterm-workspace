import { expect, test } from '@playwright/test';

for (const width of [360, 800]) {
  test(`transfer queue status, keyboard, batch controls and result paging ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/tests/ui/fixtures/queue.html');
    const queue = page.getByRole('region', { name: '전송 큐' });
    await expect(queue.getByText('탐색 중', { exact: true })).toBeVisible();
    await expect(queue.getByRole('alert')).toHaveText('권한 오류 · 부분 파일 보존');
    await queue.getByRole('button', { name: '모두 선택', exact: true }).focus();
    await page.keyboard.press('Enter');
    await queue.getByRole('button', { name: '선택 일시정지' }).click();
    expect(await page.evaluate(() => window.__queueCalls.at(-1)?.args)).toMatchObject({
      action: 'pause',
      ids: ['job-0', 'job-1', 'job-2'],
    });
    await queue.getByRole('button', { name: '선택 재개 확인' }).click();
    expect(await page.evaluate(() => window.__queueCalls.at(-1)?.args)).toMatchObject({
      action: 'resume',
      ids: ['job-3', 'job-4', 'job-6'],
      connectionId: 'new-authenticated-connection',
      profileId: 'server',
    });
    // Row actions other than pause or resume are in each row's menu.
    await queue
      .getByRole('button', { name: /전송 작업$/ })
      .nth(1)
      .click();
    await page.getByRole('menuitem', { name: '맨 앞으로' }).click();
    expect(await page.evaluate(() => window.__queueCalls.at(-1)?.args)).toMatchObject({
      action: 'first',
      ids: ['job-1'],
    });
    await queue
      .getByRole('button', { name: /전송 작업$/ })
      .first()
      .click();
    await page.getByRole('menuitem', { name: '파일별 결과' }).click();
    await expect(queue.getByText('/한글 폴더/중첩 폴더/동일한 파일.txt')).toBeVisible();
    await expect(queue.getByRole('button', { name: '다음 결과' })).toBeDisabled();
    await queue
      .getByRole('button', { name: /전송 작업$/ })
      .nth(5)
      .click();
    await page.getByRole('menuitem', { name: '기록 정리' }).click();
    expect(await page.evaluate(() => window.__queueCalls.at(-1))).toMatchObject({
      command: 'discard-confirm',
      args: { id: 'job-5' },
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    await page.screenshot({
      path: `target/verification/transfer-queue-${width}.png`,
      fullPage: true,
    });
  });
}
