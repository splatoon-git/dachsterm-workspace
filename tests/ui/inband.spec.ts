import { expect, test } from '@playwright/test';
import type { InbandNotice } from '../../src/features/terminal/inbandTransfer';
import type {} from './fixtures/terminal-pane';

const notice = (patch: Partial<InbandNotice>): InbandNotice => ({
  type: 'inband',
  request: 'r1',
  stage: 'ask',
  direction: 'download',
  protocol: 'trzsz',
  name: null,
  done: 0,
  total: 0,
  files: 0,
  message: null,
  ...patch,
});

test('a transfer asks in the pane, shows its progress, and leaves a line at the end', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/terminal-pane.html');
  await expect(page.locator('.xterm-rows')).toBeVisible();
  const send = (n: InbandNotice) =>
    page.evaluate((value) => window.__terminalPane.session.inband.update(value), n);
  // The fixture's tab never connects, so the pane shows its ended card; the transfer card
  // belongs to a live tab. Mark it connected as the app's event would.
  await page.evaluate(() => {
    const session = window.__terminalPane.session as unknown as {
      update: (s: object) => void;
      snapshot: () => object;
    };
    session.update({ ...session.snapshot(), status: 'connected', message: '연결됨' });
  });
  await send(notice({}));
  const card = page.getByRole('alertdialog', { name: '터미널 파일 전송' });
  await expect(card).toContainText('tsz가 파일을 보내려');
  await expect(card.getByRole('button', { name: '저장할 폴더 고르기…' })).toBeVisible();
  // Keys typed into the terminal cannot answer it.
  await expect(card.getByRole('button', { name: '거절' })).not.toBeFocused();

  await send(notice({ stage: 'progress', name: 'a.bin', done: 32768, total: 65536 }));
  const bar = page.getByRole('status', { name: '터미널 파일 전송 진행' });
  await expect(bar).toContainText('받는 중 · a.bin · 32.0 / 64.0 KiB (50%)');
  await expect(bar.getByRole('button', { name: '취소' })).toBeVisible();

  await send(notice({ stage: 'done', message: '파일 1개를 저장했습니다: a.bin' }));
  await expect(bar).toHaveCount(0);
  await expect(page.locator('.xterm-rows')).toContainText('[파일 전송 · trzsz] 파일 1개를');
});
