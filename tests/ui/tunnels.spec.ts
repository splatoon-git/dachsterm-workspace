import { expect, test } from '@playwright/test';
import type {} from './fixtures/tunnels';

test('tunnel save/list/start/stop, errors, autostart and delete protect the saved configuration', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/tunnels.html');
  await page.getByRole('button', { name: '새 터널', exact: true }).click();
  await expect(page.getByRole('heading', { name: '새 터널 만들기' })).toBeFocused();
  await expect(page.getByLabel('서버 세션').locator('option')).toHaveCount(2);
  await page.getByLabel('이름', { exact: true }).fill('DB 접속');
  await page.getByLabel('리스닝 포트').fill('0');
  await page.evaluate(() => {
    window.__tunnelTest.failSave = true;
  });
  await page.getByRole('button', { name: '설정 저장' }).click();
  await expect(page.getByRole('alert')).toContainText('저장 실패 테스트');
  await expect(page.getByLabel('이름', { exact: true })).toHaveValue('DB 접속');
  await page.evaluate(() => {
    window.__tunnelTest.failSave = false;
  });
  await page.getByRole('button', { name: '설정 저장' }).click();
  const row = page.getByRole('article', { name: 'DB 접속' });
  await expect(row).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
  expect(await page.evaluate(() => window.__tunnelTest.calls.includes('tunnel_start'))).toBe(false);
  await row.getByLabel('연결 시 자동 시작').check();
  await expect.poll(() => page.evaluate(() => window.__tunnelTest.configs[0].autoStart)).toBe(true);
  await page.evaluate(() => {
    window.__tunnelTest.failStart = true;
  });
  await row.getByRole('button', { name: '시작', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('포트 충돌 테스트');
  await page.evaluate(() => {
    window.__tunnelTest.failStart = false;
  });
  await row.getByRole('button', { name: '시작', exact: true }).click();
  await expect(row).toContainText('실행 중');
  await expect(row).toContainText('127.0.0.1:45678');
  await expect(row.getByRole('button', { name: '수정' })).toBeDisabled();
  await expect(row.getByRole('button', { name: '삭제', exact: true })).toBeDisabled();
  await row.getByRole('button', { name: '중지', exact: true }).click();
  await expect(row).toContainText('중지됨');
  await row.getByRole('button', { name: '수정' }).click();
  await page.getByLabel('이름', { exact: true }).fill('취소할 이름');
  await page.getByRole('button', { name: '취소' }).click();
  await expect(row).toBeVisible();
  await page.evaluate(() => window.__tunnelTest.disconnect());
  await expect(row.getByRole('button', { name: '시작', exact: true })).toBeDisabled();
  await row.getByRole('button', { name: '삭제', exact: true }).click();
  await row.getByRole('button', { name: '삭제 확인' }).click();
  await expect(row).toHaveCount(0);
});

for (const [width, theme] of [
  [1280, 'pms-retro-light'],
  [800, 'github-dark'],
  [560, 'pms-retro-light'],
  [360, 'terminal-green'],
] as const) {
  test(`tunnel direction, keyboard and control alignment at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((id) => localStorage.setItem('daxterm.theme', id), theme);
    await page.goto('/tests/ui/fixtures/tunnels.html');
    await page.getByRole('button', { name: '새 터널', exact: true }).click();
    const local = page.getByRole('radio', { name: /로컬 포워딩/ });
    await local.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: /원격 포워딩/ })).toBeChecked();
    await expect(page.locator('.tunnel-hint')).toContainText('127.0.0.1은 내 PC');
    await page.screenshot({ path: `test-results/tunnel-remote-${width}.png`, fullPage: true });
    await page.keyboard.press('ArrowRight');
    await expect(page.getByLabel('목적지 호스트')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '터널 연결 흐름' })).toContainText(
      '앱의 프록시 설정',
    );
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.tunnel-hint')).toContainText('127.0.0.1은 SSH 서버');
    const controls = await page.locator('.form-actions button').evaluateAll((els) =>
      els.map((e) => ({
        height: e.getBoundingClientRect().height,
        top: e.getBoundingClientRect().top,
      })),
    );
    expect(controls[0].height).toBe(32);
    expect(controls[1]).toEqual(controls[0]);
    for (const selector of ['dialog', '.tunnel-kind-options', '.tunnel-flow']) {
      expect(await page.locator(selector).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
        true,
      );
    }
    await page.screenshot({ path: `test-results/tunnel-local-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: '설정 저장' }).click();
    await expect(page.getByRole('button', { name: '새 터널', exact: true })).toBeEnabled();
    await expect
      .poll(() =>
        page.getByRole('button', { name: '새 터널', exact: true }).evaluate((button) => {
          const probe = document.createElement('span');
          probe.style.backgroundColor = 'var(--color-action-primary)';
          document.body.append(probe);
          const match =
            getComputedStyle(button).backgroundColor === getComputedStyle(probe).backgroundColor;
          probe.remove();
          return match;
        }),
      )
      .toBe(true);
    await page.screenshot({ path: `test-results/tunnel-list-${width}.png`, fullPage: true });
  });
}

test('status failure and another connection running block unsafe edits', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/tunnels.html');
  await page.getByRole('button', { name: '새 터널', exact: true }).click();
  await page.getByRole('button', { name: '설정 저장' }).click();
  const row = page.getByRole('article');
  await row.getByRole('button', { name: '수정' }).click();
  await page.evaluate(() => {
    const c = window.__tunnelTest.configs[0];
    window.__tunnelTest.statuses = [
      { ...c, id: `other:${c.id}`, connectionId: 'other', status: 'running', message: '' },
    ];
  });
  await page.getByRole('button', { name: '설정 저장' }).click();
  await expect(page.getByRole('alert').first()).toContainText('실행 중인 터널');
  await page.getByRole('button', { name: '취소' }).click();
  await expect(row.getByRole('button', { name: '삭제', exact: true })).toBeDisabled();
  await row.getByRole('button', { name: '중지', exact: true }).click();
  await page.evaluate(() => {
    window.__tunnelTest.failList = true;
  });
  await expect(row).toContainText('확인 불가');
  await expect(row.getByRole('button', { name: '시작', exact: true })).toBeDisabled();
});
