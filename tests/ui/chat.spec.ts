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

test('the composer offers commands, models, context use and subagents', async ({ page }) => {
  await open(page);
  await emit(page, [
    {
      kind: 'capabilities',
      models: [
        {
          value: 'default',
          label: 'Default (recommended)',
          detail: 'Opus 5.5',
          hint: 'claude-opus-5-5',
        },
        { value: 'opus', label: 'Opus', detail: 'Opus 5.5', hint: 'claude-opus-5-5' },
        { value: 'sonnet', label: 'Sonnet', detail: 'Sonnet 5.5', hint: 'claude-sonnet-5-5' },
      ],
      commands: [
        { value: 'review', label: 'review', detail: 'Review a pull request', hint: '[pr]' },
        { value: 'compact', label: 'compact', detail: 'Compact the conversation', hint: '' },
      ],
      agents: [],
      permissionMode: 'default',
    },
    {
      kind: 'context',
      model: 'claude-opus-5-5',
      percentage: 13,
      used: 25200,
      max: 200000,
      parts: [
        { name: 'System prompt', tokens: 3593, free: false },
        { name: 'Free space', tokens: 170000, free: true },
      ],
    },
    { kind: 'agentStarted', id: 'a1', role: 'Explore', task: '결제 모듈 탐색' },
  ]);

  // The model chip names the model by its label, and picking another asks the agent.
  await expect(page.getByRole('button', { name: '모델 Opus' })).toBeVisible();
  await page.getByRole('button', { name: '모델 Opus' }).click();
  await page
    .getByRole('dialog', { name: '모델' })
    .getByRole('button', { name: /Sonnet/ })
    .click();
  expect(await page.evaluate(() => window.__chat.calls.at(-1))).toEqual({
    command: 'chat_set_model',
    args: { id: expect.any(String), model: 'sonnet' },
  });
  await expect(page.getByRole('button', { name: '모델 Sonnet' })).toBeVisible();

  // A slash at the start lists the commands; Enter takes the highlighted one.
  const prompt = page.getByRole('textbox', { name: '프롬프트' });
  await prompt.fill('/re');
  await expect(page.getByRole('listbox', { name: '명령' }).getByRole('option')).toHaveCount(1);
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('/review ');
  await expect(page.getByRole('listbox', { name: '명령' })).toHaveCount(0);

  await page.getByRole('button', { name: '컨텍스트 13% 사용' }).click();
  await expect(page.getByRole('dialog', { name: '컨텍스트' })).toContainText('25k / 200k');
  await page.screenshot({ path: 'test-results/chat-composer.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '에이전트 1개 실행 중' }).click();
  await expect(page.getByRole('dialog', { name: '서브에이전트' })).toContainText('결제 모듈 탐색');
});
