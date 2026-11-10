import { expect, test } from '@playwright/test';
import type { ChatEvent } from '../../src/features/chat/chatState';
import type {} from './fixtures/chat';

// The app's macOS view is WebKit, where a button centres its content unless told otherwise.
// playwright.config.ts runs this file in WebKit, on macOS only.

test('menu items over the composer start at the left edge in WebKit', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/chat.html');
  await expect(page.getByRole('textbox', { name: '프롬프트' })).toBeEnabled();
  const events: ChatEvent[] = [
    { kind: 'started', session: 's', model: 'claude-opus-5-5' },
    {
      kind: 'capabilities',
      models: [
        {
          value: 'opus',
          label: 'Opus',
          detail: 'For complex work',
          hint: 'claude-opus-5-5',
          levels: [],
        },
        {
          value: 'haiku',
          label: 'Haiku 4.5',
          detail: 'Fastest',
          hint: 'claude-haiku-4-5',
          levels: [],
        },
      ],
      commands: [],
      agents: [],
      permissionMode: 'default',
      account: { plan: '', email: '' },
    },
  ];
  await page.evaluate((list) => window.__chatEmit(list), events);
  await page.getByRole('button', { name: '모델 Opus' }).click();
  const item = page
    .getByRole('dialog', { name: '모델' })
    .getByRole('button', { name: /Haiku 4.5/ });
  const box = (await item.boundingBox())!;
  const label = (await item.locator('b').boundingBox())!;
  expect(label.x - box.x).toBeLessThan(24);
});
