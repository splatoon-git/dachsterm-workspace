import { expect, test } from '@playwright/test';
import { chatLaunchKey, type ChatLaunch } from '../../src/features/chat/chatPlaces';

test('the title bar opens chats with Ctrl/Cmd+Shift+A, following the tab or a fixed place', async ({
  page,
}) => {
  const saved: ChatLaunch = {
    mode: 'follow',
    fixed: null,
    recent: [{ kind: 'local', folder: '/Users/me/work' }],
  };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: chatLaunchKey,
    value: JSON.stringify(saved),
  });
  await page.goto('/');
  const icon = page.getByRole('button', { name: '에이전트 채팅', exact: true });
  await expect(icon).toBeVisible();

  await page.keyboard.press('ControlOrMeta+Shift+KeyA');
  const popover = page.getByRole('region', { name: '에이전트 채팅', exact: true });
  await expect(popover).toBeVisible();
  // No terminal tab to follow yet: it says so instead of guessing a place.
  const fresh = popover.getByRole('button', { name: /새 채팅/ });
  await expect(fresh).toBeDisabled();
  await expect(fresh).toContainText('따라갈 터미널 탭이 없습니다');
  await expect(popover.getByRole('list', { name: '최근 작업 영역' })).toContainText('이 PC');
  await expect(popover).toContainText('열린 채팅이 없습니다.');
  await page.screenshot({ path: 'test-results/chat-launcher.png' });

  // Fixing the place makes "new chat" open there, and the choice is kept.
  await popover.getByRole('radio', { name: '고정' }).check();
  await expect(fresh).toBeEnabled();
  await expect(fresh).toContainText('이 PC · /Users/me/work');
  const kept = await page.evaluate((key) => localStorage.getItem(key), chatLaunchKey);
  expect(JSON.parse(kept ?? '{}')).toMatchObject({ mode: 'fixed', fixed: saved.recent[0] });

  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(icon).toBeFocused();

  await icon.click();
  await fresh.click();
  await expect(popover).toBeHidden();
  // The browser run has no backend, so the chat says it could not start; the tab is there.
  const tab = page.getByRole('tab', { name: /채팅 · 이 PC/ });
  await expect(tab).toBeVisible();
  await expect(page.locator('.chat-pane').getByRole('alert')).toBeVisible();
  await icon.click();
  await expect(popover.getByRole('list', { name: '열린 채팅' })).toContainText('/Users/me/work');
});

test('the sidebar lists recent chat workspaces to reopen or forget', async ({ page }) => {
  const saved: ChatLaunch = {
    mode: 'follow',
    fixed: null,
    recent: [
      { kind: 'local', folder: '/Users/me/work' },
      { kind: 'local', folder: '/Users/me/notes' },
    ],
  };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: chatLaunchKey,
    value: JSON.stringify(saved),
  });
  await page.goto('/');
  const section = page.getByRole('region', { name: '최근 채팅' });
  const list = section.getByRole('list', { name: '최근 채팅' });
  await expect(list.getByRole('listitem')).toHaveCount(2);

  // One click opens a chat there; a second click goes back to it instead of opening another.
  await list
    .getByRole('button', { name: /\/Users\/me\/work/ })
    .first()
    .click();
  const tabs = page.getByRole('tab', { name: /채팅 · 이 PC/ });
  await expect(tabs).toHaveCount(1);
  await expect(list.getByRole('listitem').first()).toContainText('열림');
  await list
    .getByRole('button', { name: /\/Users\/me\/work/ })
    .first()
    .click();
  await expect(tabs).toHaveCount(1);
  // The menu still opens another one in the same place.
  await list
    .getByRole('button', { name: /\/Users\/me\/work/ })
    .first()
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '새 채팅 열기' }).click();
  await expect(tabs).toHaveCount(2);
  await page.screenshot({ path: 'test-results/chat-recent-sidebar.png' });

  // The ✕ takes a row off the list and the choice is kept.
  await list.getByRole('button', { name: '이 PC /Users/me/notes 최근 채팅에서 제거' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  const kept = await page.evaluate((key) => localStorage.getItem(key), chatLaunchKey);
  expect(JSON.parse(kept ?? '{}').recent).toEqual([saved.recent[0]]);

  // The section folds like the others.
  await section
    .getByRole('button', { name: /최근 채팅/ })
    .first()
    .click();
  await expect(list).toBeHidden();
});
