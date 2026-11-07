import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/agent-launch';

async function open(page: Page, tmux: string, folder?: string) {
  await page.addInitScript(
    ({ tmux, folder }) => {
      window.__tmux = tmux;
      window.__folder = folder ?? undefined;
    },
    { tmux, folder: folder ?? null },
  );
  await page.goto('/tests/ui/fixtures/agent-launch.html');
  return page.getByRole('dialog', { name: '에이전트 시작', exact: true });
}

test('a tmux start shows the folder and the exact command, and needs a valid name', async ({
  page,
}) => {
  const dialog = await open(page, 'work', '/srv/my app');
  await expect(dialog).toContainText('/srv/my app');
  await expect(dialog.getByRole('textbox', { name: '폴더' })).toHaveCount(0);
  const command = dialog.getByLabel('실행할 명령');
  await expect(command).toHaveText('claude');
  await expect(dialog).toContainText('tmux 세션(work)을 새로 만들 때만 이 폴더에서 실행합니다.');
  await expect(dialog).toContainText('재접속하면 다시 실행하지 않습니다.');
  await dialog.getByLabel('프리셋').selectOption({ label: '새 worktree' });
  const start = dialog.getByRole('button', { name: '시작', exact: true });
  await expect(start).toBeDisabled();
  const name = dialog.getByRole('textbox', { name: '이름' });
  await expect(name).toBeFocused();
  await name.fill('-rf');
  await expect(start).toBeDisabled();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog).toContainText('영문·숫자로 시작');
  await name.fill('fix-login');
  await expect(command).toHaveText('claude --worktree fix-login');
  await start.click();
  expect(await page.evaluate(() => window.__launch)).toEqual({
    folder: '/srv/my app',
    command: 'claude --worktree fix-login',
  });
});

test('a plain shell shows the typed line with a quoted folder the user may type', async ({
  page,
}) => {
  const dialog = await open(page, '');
  const folder = dialog.getByRole('textbox', { name: '폴더' });
  const line = dialog.getByLabel('입력할 줄');
  await expect(line).toHaveText('claude');
  await folder.fill('srv');
  await expect(dialog).toContainText('/로 시작하는 경로');
  await expect(dialog.getByRole('button', { name: '시작', exact: true })).toBeDisabled();
  await folder.fill("/srv/it's");
  await expect(line).toHaveText("cd '/srv/it'\\''s' && claude");
  await expect(dialog).toContainText('10초 안에 프롬프트를 찾지 못하면 입력하지 않고');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect(await page.evaluate(() => [window.__closed, window.__launch])).toEqual([true, null]);
});

test('saved presets are offered, and a damaged list falls back to the defaults', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'dachsterm.agentPresets',
      JSON.stringify([
        { name: '검토', command: 'cli --review' },
        { name: 'bad', command: 'a\nb' },
      ]),
    ),
  );
  const dialog = await open(page, 'work');
  await expect(dialog.getByLabel('프리셋').locator('option')).toHaveText(['검토']);
  await expect(dialog.getByLabel('실행할 명령')).toHaveText('cli --review');
});

test('a narrow window keeps the dialog and a long command inside the screen', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 640 });
  const dialog = await open(page, '', `/srv/${'very-long-folder-name/'.repeat(8)}`);
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(380);
  const overflow = await dialog
    .locator('.dialog-body')
    .evaluate((body) => body.scrollWidth - body.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(dialog.getByRole('button', { name: '시작', exact: true })).toBeInViewport();
});

test('presets are edited in settings, saved only when valid, and kept after reload', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await settings.getByRole('tab', { name: '에이전트', exact: true }).click();
  const command = settings.getByRole('textbox', { name: '프리셋 1 명령' });
  await expect(command).toHaveValue('claude');
  await command.fill('cli --model fast');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('dachsterm.agentPresets')))
    .toContain('cli --model fast');
  await settings.getByRole('textbox', { name: '프리셋 2 이름' }).fill('');
  await expect(settings.getByRole('alert')).toContainText('고칠 때까지 저장하지 않습니다');
  expect(await page.evaluate(() => localStorage.getItem('dachsterm.agentPresets'))).toContain(
    '"이어서"',
  );
  await settings.getByRole('button', { name: '프리셋 2 삭제', exact: true }).click();
  await expect(settings.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  // The settings window opens on the category used last.
  const names = page.getByRole('dialog', { name: '설정' }).getByRole('textbox', { name: /이름$/ });
  await expect(names).toHaveCount(3);
  await expect(page.getByRole('textbox', { name: '프리셋 1 명령' })).toHaveValue(
    'cli --model fast',
  );
  await page.getByRole('button', { name: '기본값으로 되돌리기', exact: true }).click();
  await expect(names).toHaveCount(4);
});
