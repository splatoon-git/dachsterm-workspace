import { expect, test, type Page } from '@playwright/test';
import type { ExternalEdit } from '../../src/lib/externalEdit';
import type {} from './fixtures/edit-save';

const base: ExternalEdit = {
  id: 'e1',
  connectionId: 'c1',
  profileId: 'p1',
  uploadMode: 'ask',
  remote: '/srv/한글 app.conf',
  local: 'C:/edits/working.conf',
  status: 'pending',
  message: '',
  connectionLive: true,
};

async function open(page: Page, edit: Partial<ExternalEdit> = {}) {
  await page.addInitScript(
    (value) => {
      window.__edit = value;
    },
    { ...base, ...edit },
  );
  await page.goto('/tests/ui/fixtures/edit-save.html');
  return page.getByRole('alertdialog', { name: '외부 편집 저장 확인', exact: true });
}
const answer = (page: Page) => page.evaluate(() => window.__editAnswer);

test('names the file and takes no focus, so terminal keys cannot answer it', async ({ page }) => {
  const card = await open(page);
  await expect(card).toContainText('서버 파일에 업로드할까요?');
  await expect(card).toContainText('한글 app.conf');
  await expect(card).toContainText('/srv/한글 app.conf');
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
});

for (const [name, action] of [
  ['업로드', 'upload'],
  ['취소 · 수정본 보존', 'cancel'],
  ['이 연결 동안 자동 업로드', 'connectionAuto'],
] as const)
  test(`"${name}" answers ${action}`, async ({ page }) => {
    const card = await open(page);
    await card.getByRole('button', { name, exact: true }).click();
    expect(await answer(page)).toEqual({ action });
  });

test('a conflict offers its own choices and no automatic upload', async ({ page }) => {
  const card = await open(page, { status: 'conflict' });
  await expect(card).toContainText('서버 파일도 변경되었습니다');
  await expect(card.getByRole('button', { name: '이 연결 동안 자동 업로드' })).toHaveCount(0);
  await card.getByRole('button', { name: '다시 받기', exact: true }).click();
  expect(await answer(page)).toEqual({ action: 'reload' });
});

test('overwriting asks once more and starts on cancel', async ({ page }) => {
  const card = await open(page, { status: 'conflict' });
  await card.getByRole('button', { name: '덮어쓰기…', exact: true }).click();
  await expect(card.getByRole('button', { name: '취소', exact: true })).toBeFocused();
  expect(await answer(page)).toBeNull();
  await card.getByRole('button', { name: '취소', exact: true }).click();
  await expect(card.getByRole('button', { name: '다시 받기', exact: true })).toBeVisible();
  expect(await answer(page)).toBeNull();
  await card.getByRole('button', { name: '덮어쓰기…', exact: true }).click();
  await card.getByRole('button', { name: '덮어쓰기', exact: true }).click();
  expect(await answer(page)).toEqual({ action: 'overwrite' });
});

test('saving under another name proposes a path and needs one', async ({ page }) => {
  const card = await open(page, { status: 'conflict' });
  await card.getByRole('button', { name: '다른 이름…', exact: true }).click();
  const field = card.getByLabel('새 서버 경로', { exact: true });
  await expect(field).toHaveValue('/srv/한글 app.conf.copy');
  await field.fill('');
  await expect(card.getByRole('button', { name: '업로드', exact: true })).toBeDisabled();
  await field.fill('/srv/copy.conf');
  await field.press('Enter');
  expect(await answer(page)).toEqual({ action: 'saveAs', path: '/srv/copy.conf' });
});

test('its answers stay on screen in a short pane', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 320 });
  const card = await open(page, { status: 'conflict' });
  await expect(card.getByRole('button', { name: '덮어쓰기…', exact: true })).toBeInViewport();
});
