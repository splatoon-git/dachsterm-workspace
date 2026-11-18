import { expect, test, type Page, type TestInfo } from '@playwright/test';

const screens = [
  'group',
  'key',
  'vault',
  'vault-reveal',
  'save-as',
  'unsaved',
  'unsaved-many',
  'confirm',
  'file-edit',
  'file-delete',
  'file-rename',
  'chat-open',
  'agent-launch',
  'agent-failed',
  'ports',
  'tunnels',
  'kube-action',
  'kube-mode',
  'terminal-settings',
  'session-log',
  'git-branch',
  'git-tag',
  'git-stash',
  'git-force',
  'git-checkout',
  'git-discard',
  'external-link',
];
const sections = [
  'appearance',
  'terminal',
  'git',
  'agents',
  'vault',
  'sessions',
  'transfer',
  'recovery',
  'update',
];

async function capture(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('dialog[open]').last()).toBeVisible();
  // Wait for React's async fixture reads and font loading before measuring.
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const metrics = await page
    .locator('dialog[open]')
    .last()
    .evaluate((dialog) => {
      const visible = (e: Element) =>
        e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const body = dialog.querySelector('.dialog-body')!;
      const panel = dialog.querySelector('.settings-panel');
      const r = dialog.getBoundingClientRect();
      const overflowing = [dialog, body, ...(panel ? [panel] : [])].filter(
        (e) => e.scrollWidth > e.clientWidth + 2,
      );
      const candidates = [...dialog.querySelectorAll('*')]
        .filter(
          (e) =>
            visible(e) &&
            e.clientWidth > 1 &&
            e.scrollWidth > e.clientWidth + 2 &&
            !['auto', 'scroll'].includes(getComputedStyle(e).overflowX),
        )
        .map((e) => ({
          tag: e.tagName,
          class: e.className,
          text: e.textContent?.slice(0, 80),
          client: e.clientWidth,
          scroll: e.scrollWidth,
        }));
      const controls = [...dialog.querySelectorAll('input,select,button,textarea')]
        .filter(visible)
        .map((e) => ({
          name: e.getAttribute('aria-label') || e.textContent || e.closest('label')?.textContent,
          type: e.getAttribute('type'),
          class: e.className,
          font: getComputedStyle(e).fontSize,
          height: e.getBoundingClientRect().height,
          width: e.getBoundingClientRect().width,
        }));
      const target = dialog.querySelector('.git-config-target');
      const targetSelect = target?.querySelector('select');
      return {
        targetInline:
          !target ||
          !targetSelect ||
          targetSelect.getBoundingClientRect().left > target.getBoundingClientRect().left + 20,
        titleFont: parseFloat(getComputedStyle(dialog.querySelector('.dialog-title h2')!).fontSize),
        bodyFont: parseFloat(getComputedStyle(body).fontSize),
        fieldFonts: [...dialog.querySelectorAll('input,select,textarea')]
          .filter(visible)
          .map((e) => getComputedStyle(e).fontSize),
        footerHeights: [...dialog.querySelectorAll('.form-actions > button')]
          .filter(visible)
          .map((e) => e.getBoundingClientRect().height),
        overflowing: overflowing.map((e) => e.className),
        candidates,
        controls,
        outsideViewport:
          r.left < 0 || r.right > innerWidth + 1 || r.top < 0 || r.bottom > innerHeight + 1,
      };
    });
  await info.attach(`${name}-metrics`, {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  // Bottom view exposes clipped fields and wrapped footers that the opening view hides.
  const scroller = page
    .locator('dialog[open]')
    .last()
    .locator('.settings-panel, .dialog-body')
    .last();
  const tall = await scroller.evaluate((e) => e.scrollHeight > e.clientHeight + 8);
  if (tall) {
    await scroller.evaluate((e) => {
      e.scrollTop = e.scrollHeight;
    });
    await page.screenshot({ path: info.outputPath(`${name}-bottom.png`) });
  }
  expect.soft(metrics.outsideViewport, `${name}: modal stays in viewport`).toBe(false);
  expect.soft(metrics.overflowing, `${name}: no horizontal dialog/panel scroll`).toEqual([]);
  expect.soft(metrics.targetInline, `${name}: Git target stays beside its label`).toBe(true);
  expect.soft(metrics.titleFont, `${name}: title is above body`).toBeGreaterThan(metrics.bodyFont);
  expect
    .soft(
      metrics.fieldFonts.filter((font) => font !== '12px'),
      `${name}: one input text scale`,
    )
    .toEqual([]);
  expect
    .soft(
      metrics.footerHeights.filter((height) => height < 32),
      `${name}: footer controls keep their height`,
    )
    .toEqual([]);
  return metrics;
}

for (const theme of ['pms-retro-light', 'github-dark', 'terminal-green']) {
  for (const width of [1280, 800, 560, 360]) {
    test(`${theme} ${width}: vault status is separated from its fields`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 600 });
      await page.addInitScript((theme) => localStorage.setItem('dachsterm.theme', theme), theme);
      await page.goto('/tests/ui/fixtures/dialog-audit.html?screen=vault&state=error');
      const state = page.locator('.vault-state');
      await expect(state).toBeVisible();
      const gap = await page
        .locator('.vault-panel')
        .evaluate(
          (panel) =>
            panel.querySelector('form')!.getBoundingClientRect().top -
            panel.querySelector('.vault-state')!.getBoundingClientRect().bottom,
        );
      expect(gap, 'the status badge must not touch the next field label').toBeGreaterThanOrEqual(
        12,
      );
      await page.getByLabel('현재 마스터 패스워드', { exact: true }).fill('layout-fixture-only');
      await page.getByRole('button', { name: '잠금 해제', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('점검용 오류');
      await capture(page, info, 'vault-error-spacing');
    });
    test(`${theme} ${width}: settings and popup layout inventory`, async ({ page }, info) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height: width === 360 ? 600 : 820 });
      await page.addInitScript((theme) => localStorage.setItem('dachsterm.theme', theme), theme);
      const go = async (screen: string, state = 'normal') => {
        await page.goto(`/tests/ui/fixtures/dialog-audit.html?screen=${screen}&state=${state}`);
      };
      await go('settings');
      const nav = page.getByRole('tablist', { name: '설정 분류' });
      await expect(nav).toHaveAttribute(
        'aria-orientation',
        width <= 700 ? 'horizontal' : 'vertical',
      );
      await page.locator('#settings-tab-appearance').focus();
      await page.keyboard.press(width <= 700 ? 'ArrowRight' : 'ArrowDown');
      await expect(page.locator('#settings-tab-terminal')).toHaveAttribute('aria-selected', 'true');
      for (const section of sections) {
        await page.locator(`#settings-tab-${section}`).click();
        await expect(page.locator('.settings-panel-heading')).toBeInViewport();
        await capture(page, info, `settings-${section}`);
        if (section === 'sessions') {
          await page.locator('.manager-template select').selectOption('template');
          await page.locator('.manager-search button').first().click();
          await page.getByRole('button', { name: '변경 미리보기' }).click();
          await capture(page, info, 'settings-sessions-preview');
        }
        if (section === 'recovery') {
          await page.getByLabel('저장된 설정 복구본').selectOption('recovery-fixture');
          await page.getByRole('button', { name: '선택한 복구본 가져오기' }).click();
          await capture(page, info, 'settings-recovery-confirm');
        }
      }
      for (const screen of screens) {
        await go(screen);
        if (screen === 'kube-mode')
          await page.getByRole('button', { name: '조회 모드', exact: true }).click();
        if (screen === 'external-link') await page.getByRole('link', { name: '외부 링크' }).click();
        await capture(page, info, screen);
        if (screen === 'key') {
          await page.getByRole('button', { name: '만들기', exact: true }).click();
          await expect(page.locator('.ssh-key-result')).toBeVisible();
          await capture(page, info, 'key-result');
        }
        if (screen === 'tunnels') {
          await page.getByRole('button', { name: '새 터널', exact: true }).first().click();
          await capture(page, info, 'tunnel-editor');
        }
      }
      await go('session');
      for (const protocol of ['ssh', 'ftps', 'ftp', 'telnet', 'serial']) {
        await page.getByRole('combobox', { name: '프로토콜', exact: true }).selectOption(protocol);
        await capture(page, info, `session-${protocol}`);
      }
      await page.getByRole('combobox', { name: '프로토콜', exact: true }).selectOption('ssh');
      await page.locator('summary', { hasText: '고급 옵션' }).click();
      await page.getByRole('combobox', { name: '인증 방식', exact: true }).selectOption('key');
      await capture(page, info, 'session-advanced-key');
      for (const state of ['new', 'unlocked', 'error']) {
        await go('vault', state);
        await capture(page, info, `vault-${state}`);
      }
      await go('settings', 'error');
      for (const section of ['git', 'agents', 'transfer', 'recovery', 'update']) {
        await page.locator(`#settings-tab-${section}`).click();
        await capture(page, info, `settings-${section}-error`);
      }
    });
  }
}
