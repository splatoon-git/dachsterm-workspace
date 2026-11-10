import { expect, test, type Page } from '@playwright/test';
import type { ChatEvent } from '../../src/features/chat/chatState';
import type {} from './fixtures/chat';

const emit = (page: Page, events: ChatEvent[]) =>
  page.evaluate((list) => window.__chatEmit(list), events);

async function open(page: Page) {
  await page.goto('/tests/ui/fixtures/chat.html');
  await expect(page.getByRole('textbox', { name: '프롬프트' })).toBeEnabled();
  await emit(page, [{ kind: 'started', session: 's', model: 'claude-opus-5-5' }]);
}

test('a turn streams Markdown, shows its tools and can be stopped', async ({ page }) => {
  await open(page);
  const prompt = page.getByRole('textbox', { name: '프롬프트' });
  await prompt.fill('a.txt를 고쳐 줘');
  await prompt.press('Enter');
  await expect(page.getByRole('list', { name: '대화' })).toContainText('a.txt를 고쳐 줘');
  await expect(page.getByText('작업 중…')).toBeVisible();

  await emit(page, [
    { kind: 'thinking', done: false },
    { kind: 'thinking', done: true },
    {
      kind: 'toolStarted',
      id: 't1',
      name: 'Edit',
      summary: '/Users/me/work/app/a.txt',
      edit: { path: '/Users/me/work/app/a.txt', before: 'hello', after: 'bye' },
    },
    { kind: 'toolFinished', id: 't1', ok: true, output: 'The file was updated' },
    { kind: 'textDelta', text: '`a.txt`의 ' },
    { kind: 'textDelta', text: '내용을 바꿨습니다.' },
  ]);
  await expect(page.getByText('초 생각함')).toBeVisible();
  const tool = page.getByRole('button', { name: /Edit/ });
  await tool.click();
  await expect(page.getByLabel('/Users/me/work/app/a.txt 변경')).toContainText('- hello');
  await expect(page.locator('.chat-markdown code')).toHaveText('a.txt');

  // Stop is offered while the turn runs and the draft is empty.
  await page.getByRole('button', { name: '작업 중지' }).click();
  expect(await page.evaluate(() => window.__chat.calls.map((c) => c.command))).toContain(
    'chat_interrupt',
  );
  await emit(page, [{ kind: 'turnFinished', ok: false, detail: 'error_during_execution' }]);
  await expect(page.getByText('중지했습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible();
  await page.screenshot({ path: 'test-results/chat-turn.png' });
});

test('a finished block replaces what was streamed for it', async ({ page }) => {
  await open(page);
  const prompt = page.getByRole('textbox', { name: '프롬프트' });
  await prompt.fill('x');
  await prompt.press('Enter');
  await emit(page, [
    { kind: 'textDelta', text: '안' },
    { kind: 'text', text: '안녕하세요' },
    { kind: 'turnFinished', ok: true, detail: null },
  ]);
  await expect(page.locator('.chat-markdown')).toHaveCount(1);
  await expect(page.locator('.chat-markdown')).toHaveText('안녕하세요');
});
