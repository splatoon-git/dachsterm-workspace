import { test, expect, type Locator, type Page } from '@playwright/test';
import { openNewConnection } from './helpers';

async function openForm(page: Page) {
  await page.goto('/');
  await openNewConnection(page);
  return page.getByRole('dialog', { name: '새 연결' });
}

/** 한 칸짜리 항목이 혼자 남으면 행의 오른쪽이 비어 보인다. */
async function expectFullRows(grid: Locator) {
  const rows = await grid.evaluate((element) => {
    const widths = new Map<number, number>();
    for (const child of element.children) {
      const box = child.getBoundingClientRect();
      if (box.width === 0) continue;
      const top = Math.round(box.top);
      widths.set(top, (widths.get(top) ?? 0) + box.width);
    }
    const gap = parseFloat(getComputedStyle(element).columnGap);
    const total = element.getBoundingClientRect().width;
    return [...widths.values()].map((used) => total - used <= gap + 1);
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(rows).not.toContain(false);
}

test('new connection shows the essentials and folds the rest', async ({ page }) => {
  const dialog = await openForm(page);
  for (const label of ['이름', '호스트', '포트', '사용자', '인증 방식', '비밀번호'])
    await expect(dialog.getByLabel(label, { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('프로토콜')).toBeVisible();
  await expect(dialog.getByLabel('인증정보 보관', { exact: true })).toBeVisible();
  for (const label of ['그룹', '정렬 순서', '즐겨찾기', '접속 타임아웃 (초)', 'KeepAlive (초)'])
    await expect(dialog.getByLabel(label, { exact: true })).toBeHidden();
  await expect(dialog.getByLabel('터미널 인코딩')).toBeHidden();
  // 템플릿이 하나도 없으면 빈 선택 칸을 보여 주지 않는다.
  await expect(dialog.getByLabel('공통 설정 템플릿')).toHaveCount(0);

  await dialog.locator('summary', { hasText: '고급 옵션' }).click();
  await expect(dialog.getByLabel('KeepAlive (초)', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('경유 프로필 추가')).toBeVisible();
});

test('session form leaves no half-empty rows in any mode', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  const dialog = await openForm(page);
  await dialog.locator('summary', { hasText: '고급 옵션' }).click();
  const basic = dialog.locator('form > .form-grid');
  const advanced = dialog.locator('.session-advanced > .form-grid');
  const auth = dialog.getByLabel('인증 방식', { exact: true });
  for (const mode of ['password', 'key', 'agent', 'interactive']) {
    await auth.selectOption(mode);
    await expectFullRows(basic);
    await expectFullRows(advanced);
  }
  await auth.selectOption('password');
  for (const protocol of ['ftps', 'ftp', 'ssh']) {
    await dialog.getByLabel('프로토콜').selectOption(protocol);
    await expectFullRows(basic);
    await expectFullRows(advanced);
  }
});

test('secret retention is not offered when nothing is typed into the form', async ({ page }) => {
  const dialog = await openForm(page);
  await dialog.getByLabel('인증 방식', { exact: true }).selectOption('agent');
  await expect(dialog.getByLabel('인증정보 보관', { exact: true })).toHaveCount(0);
});

test('an invalid value inside the folded section opens it instead of blocking silently', async ({
  page,
}) => {
  const dialog = await openForm(page);
  const summary = dialog.locator('summary', { hasText: '고급 옵션' });
  await summary.click();
  const keepalive = dialog.getByLabel('KeepAlive (초)', { exact: true });
  await keepalive.fill('1');
  await summary.click();
  await expect(keepalive).toBeHidden();
  await dialog.getByLabel('이름', { exact: true }).fill('테스트');
  await dialog.getByLabel('호스트', { exact: true }).fill('localhost');
  await dialog.getByLabel('사용자', { exact: true }).fill('test');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(keepalive).toBeVisible();
  await expect(keepalive).toBeFocused();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('key forwarding starts off, folded, and only for SSH', async ({ page }) => {
  const dialog = await openForm(page);
  const forward = dialog.getByLabel('SSH 키 전달 (agent forwarding)', { exact: true });
  await expect(forward).toBeHidden();
  await dialog.locator('summary', { hasText: '고급 옵션' }).click();
  await expect(forward).not.toBeChecked();
  await forward.check();
  await dialog.getByLabel('프로토콜').selectOption('ftps');
  await expect(forward).toHaveCount(0);
  await dialog.getByLabel('프로토콜').selectOption('ssh');
  await expect(forward).not.toBeChecked();
});

test('forwarded keys sit under key forwarding and leave no half-empty rows', async ({ page }) => {
  const dialog = await openForm(page);
  await dialog.locator('summary', { hasText: '고급 옵션' }).click();
  const keys = dialog.getByRole('group', { name: '전달할 키', exact: true });
  await expect(keys).toHaveCount(0);
  await dialog.getByLabel('SSH 키 전달 (agent forwarding)', { exact: true }).check();
  await expect(keys).toBeVisible();
  const login = keys.getByLabel('로그인 키 (위의 개인키 파일)', { exact: true });
  await expect(login).toHaveCount(0);
  await dialog.getByLabel('인증 방식').selectOption('key');
  await expect(login).toBeChecked();
  await expect(keys.getByLabel('이 PC의 SSH agent 키도 사용', { exact: true })).toBeChecked();
  const add = keys.getByRole('button', { name: '추가', exact: true });
  await expect(add).toBeDisabled();
  const path = keys.getByLabel('추가할 키 파일 경로', { exact: true });
  await path.fill('C:\\keys\\id_git');
  // Enter adds here and never submits the session form. Without the desktop app it cannot read.
  await path.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(keys.getByRole('alert')).toContainText('데스크톱 앱');
  await expect(keys.getByRole('list', { name: '추가 키' }).getByRole('listitem')).toHaveCount(0);
  await expectFullRows(dialog.locator('.session-advanced .form-grid').first());
});
