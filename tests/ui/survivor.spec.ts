import { test, expect, type Page } from '@playwright/test';
import type {} from './fixtures/survivor';

const fixture = '/tests/ui/fixtures/survivor.html';
const game = (page: Page) => page.locator('.survivor-game');
const state = (page: Page) =>
  page.evaluate(() => {
    const c = window.survivorUi.controller,
      r = c.session.run!;
    return {
      tick: r.tick,
      x: r.player.x,
      y: r.player.y,
      choice: r.choice?.id,
      phase: r.phase,
      stage: r.stage.index,
      pending: r.pendingChoices,
      gold: r.gold,
      level: r.level,
      profile: c.store.getSnapshot().profile,
    };
  });
async function start(page: Page, clock = false) {
  await page.goto(fixture);
  if (clock) await frozenClock(page);
  await page.getByRole('button', { name: '새 도전 시작', exact: true }).click();
  await expect(game(page)).toHaveAttribute('data-phase', 'playing');
}
async function frozenClock(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
}

for (const width of [360, 560, 1280])
  test(`survivor cards, stage and result fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await start(page);
    if (width === 560) await page.evaluate(() => window.survivorUi.dark());
    await page.evaluate(() => window.survivorUi.battle());
    await expect(game(page)).toHaveAttribute('data-phase', 'paused');
    await page.screenshot({
      path: `target/verification/survivor-battle-${width}.png`,
      fullPage: true,
    });
    await page.evaluate(() => window.survivorUi.cards(1));
    const cards = page.locator('.survivor-card');
    await expect(cards).toHaveCount(3);
    await expect(cards.first()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(cards.nth(1)).toBeFocused();
    expect(await game(page).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const boxes = await cards.evaluateAll((es) =>
      es.map((e) => ({
        x: e.getBoundingClientRect().x,
        y: e.getBoundingClientRect().y,
        h: e.getBoundingClientRect().height,
      })),
    );
    expect(boxes.every((b) => b.h >= 44)).toBe(true);
    if (width === 360) expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
    else expect(boxes[1].y).toBe(boxes[0].y);
    await page.screenshot({
      path: `target/verification/survivor-cards-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press('Enter');
    await expect(game(page)).toHaveAttribute('data-phase', 'playing');
    await page.evaluate(() => window.survivorUi.clear(3));
    await expect(page.getByRole('button', { name: '다음 스테이지 4', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '정산하고 쉼터로', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: '도전 결과', exact: true })).toContainText(
      '25 + 보스 40 + 첫 보스 30 = 95 골드',
    );
    expect((await state(page)).profile.gold).toBe(95);
    await page.screenshot({
      path: `target/verification/survivor-result-${width}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: '쉼터', exact: true }).click();
    await expect(page.getByTestId('survivor-balance')).toHaveText('95');
  });

test('held keys cannot confirm consecutive cards, rerolls or the next stage; blur preserves selection', async ({
  page,
}) => {
  await start(page, true);
  await page.keyboard.down('d');
  await page.clock.runFor(250);
  expect((await state(page)).x).toBeGreaterThan(1600);
  await page.evaluate(() => window.survivorUi.cards(2));
  const first = await state(page);
  await page.clock.runFor(500);
  expect((await state(page)).tick).toBe(first.tick);
  await page.keyboard.down('1');
  await expect.poll(async () => (await state(page)).pending).toBe(1);
  const second = await state(page);
  await page.keyboard.down('1');
  await page.clock.runFor(400);
  expect((await state(page)).choice).toBe(second.choice);
  await page.keyboard.up('1');
  await page.keyboard.down('r');
  await expect.poll(async () => (await state(page)).choice).not.toBe(second.choice);
  const rerolled = (await state(page)).choice;
  await page.keyboard.down('r');
  expect((await state(page)).choice).toBe(rerolled);
  await page.keyboard.up('r');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(game(page)).toHaveAttribute('data-phase', 'paused');
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  await expect(game(page)).toHaveAttribute('data-phase', 'choosing');
  expect((await state(page)).choice).toBe(rerolled);
  await page.keyboard.press('1');
  await page.clock.runFor(200);
  expect((await state(page)).x).toBe(first.x);
  await page.keyboard.up('d');
  await page.evaluate(() => window.survivorUi.clear());
  const before = await state(page);
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  expect((await state(page)).stage).toBe(2);
  expect((await state(page)).gold).toBe(before.gold);
  await page.keyboard.up('Enter');
});

test('inactive tabs, pointer cancel, settings and text fields preserve input ownership', async ({
  page,
}) => {
  await start(page, true);
  const right = page.getByRole('button', { name: '→ 이동', exact: true });
  await right.scrollIntoViewIfNeeded();
  const box = await right.boundingBox();
  const scroll = await page.evaluate(() => scrollY);
  await page.mouse.move(box!.x + 20, box!.y + 20);
  await page.mouse.down();
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  await page.clock.runFor(200);
  const moved = await state(page);
  expect(moved.x).toBeGreaterThan(1600);
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })),
  );
  await page.mouse.up();
  await page.clock.runFor(200);
  expect((await state(page)).x).toBe(moved.x);
  await page.getByRole('button', { name: '테스트 탭 전환' }).click();
  const paused = await state(page);
  await page.clock.runFor(3000);
  expect((await state(page)).tick).toBe(paused.tick);
  await page.getByRole('button', { name: '테스트 탭 전환' }).click();
  await expect(game(page)).toHaveAttribute('data-phase', 'paused');
  await page.getByRole('textbox', { name: '외부 텍스트 입력' }).fill('wasd123rpm');
  await expect(page.getByRole('textbox')).toHaveValue('wasd123rpm');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(game(page)).toHaveAttribute('data-motion', 'reduced');
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  await page.keyboard.press('m');
  expect((await state(page)).profile.settings.muted).toBe(false);
  await page.keyboard.press('m');
  expect((await state(page)).profile.settings.muted).toBe(true);
});

test('failed close retains result and original checkpoint until explicit retry; StrictMode releases lock', async ({
  page,
  context,
}) => {
  await start(page);
  await page.evaluate(() => window.survivorUi.clear(6));
  const before = (await state(page)).profile;
  await page.evaluate(() => {
    window.survivorUi.failWrites = true;
  });
  await page.getByRole('button', { name: '테스트 탭 닫기' }).click();
  await expect(game(page)).toHaveAttribute('data-phase', 'result');
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await state(page)).profile.gold).toBe(0);
  expect((await state(page)).profile.checkpoint?.runId).toBe(before.checkpoint?.runId);
  await expect(page.getByRole('button', { name: '다시 시작', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    window.survivorUi.failWrites = false;
  });
  await page.getByRole('button', { name: '저장 재시도', exact: true }).click();
  expect((await state(page)).profile.gold).toBe(135);
  await page.getByRole('button', { name: '테스트 탭 닫기' }).click();
  await expect(page.getByText('탭 닫힘', { exact: true })).toBeVisible();
  const peer = await context.newPage();
  await peer.goto(fixture);
  await expect(peer.getByRole('button', { name: '새 도전 시작', exact: true })).toBeEnabled();
  await expect(peer.getByTestId('survivor-balance')).toHaveText('135');
});

test('production catalog retains terminal, Esc pauses, tab close failure cancels removal, reopen takes lock', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.toolbar-menu > summary').filter({ hasText: '보기' }).click();
  await page.getByRole('button', { name: '터미널 미리보기', exact: true }).click();
  await page.locator('.xterm').evaluate((e) => e.setAttribute('data-survivor-kept', 'yes'));
  await page.locator('.sidebar-games summary').click();
  const launch = page
    .getByRole('navigation', { name: '게임 목록' })
    .getByRole('button', { name: '닥스의 서바이버', exact: true });
  await launch.click();
  await page.getByRole('button', { name: '새 도전 시작', exact: true }).click();
  await expect(game(page)).toHaveAttribute('data-phase', 'playing');
  await page.keyboard.press('Escape');
  await expect(page.locator('.xterm')).toBeVisible();
  await expect(page.locator('.xterm')).toHaveAttribute('data-survivor-kept', 'yes');
  await page.getByRole('tab', { name: '닥스의 서바이버', exact: true }).click();
  await expect(game(page)).toHaveAttribute('data-phase', 'paused');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Object.assign(window, {
      restoreSurvivorWrites: () => {
        Storage.prototype.setItem = original;
      },
    });
    Storage.prototype.setItem = function (k, v) {
      if (k === 'daxterm.games.survivor.v1') throw Error('test quota');
      original.call(this, k, v);
    };
  });
  await page.getByRole('button', { name: '닥스의 서바이버 탭 닫기', exact: true }).click();
  await expect(game(page)).toHaveAttribute('data-phase', 'result');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.evaluate('window.restoreSurvivorWrites()');
  await page.getByRole('button', { name: '저장 재시도', exact: true }).click();
  await page.getByRole('button', { name: '닥스의 서바이버 탭 닫기', exact: true }).click();
  await expect(game(page)).toHaveCount(0);
  await launch.click();
  await expect(page.getByRole('button', { name: '새 도전 시작', exact: true })).toBeEnabled();
});

test('resize and theme redraw preserve frozen engine, choices and logical aspect ratio', async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() => window.survivorUi.cards(2));
  await expect(game(page)).toHaveAttribute('data-phase', 'choosing');
  const serialized = await page.evaluate(() =>
    JSON.stringify(window.survivorUi.controller.session.run),
  );
  await page.setViewportSize({ width: 360, height: 900 });
  await expect
    .poll(() => page.locator('canvas').evaluate((c) => Math.abs(c.width / c.height - 16 / 9)))
    .toBeLessThan(0.02);
  const before = await page.locator('canvas').evaluate((c) => c.toDataURL());
  await page.evaluate(() => window.survivorUi.dark());
  await expect.poll(() => page.locator('canvas').evaluate((c) => c.toDataURL())).not.toBe(before);
  expect(await page.evaluate(() => JSON.stringify(window.survivorUi.controller.session.run))).toBe(
    serialized,
  );
  await page.getByRole('button', { name: '테스트 탭 전환' }).click();
  await page.getByRole('button', { name: '테스트 탭 전환' }).click();
  await expect(game(page)).toHaveAttribute('data-phase', 'paused');
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  expect((await state(page)).choice).toBe(JSON.parse(serialized).choice.id);
});

test('focus loss pauses without stealing text focus; modified keys remain untouched', async ({
  page,
}) => {
  await start(page);
  const text = page.getByRole('textbox', { name: '외부 텍스트 입력' });
  await text.click();
  await expect(game(page)).toHaveAttribute('data-phase', 'paused');
  await expect(text).toBeFocused();
  await page.keyboard.type('wasd 123 rpm');
  await expect(text).toHaveValue('wasd 123 rpm');
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  const intercepted = await game(page).evaluate((element) => {
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    element.querySelector('canvas')!.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(intercepted).toBe(false);
  await expect(game(page)).toHaveAttribute('data-phase', 'playing');
});

test('a long frame gap pauses before combat and saves, then resume drops held movement', async ({
  page,
}) => {
  await start(page, true);
  await page.keyboard.down('d');
  await page.clock.runFor(250);
  const before = await state(page);
  await page.clock.fastForward(60_000);
  await expect(game(page)).toHaveAttribute('data-phase', 'paused');
  const suspended = await state(page);
  expect(suspended.tick).toBe(before.tick);
  expect(suspended.profile.checkpoint?.tick).toBe(before.tick);
  expect(suspended.profile.settlements).toHaveLength(0);
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  await page.clock.runFor(500);
  const resumed = await state(page);
  expect(resumed.x).toBe(suspended.x);
  expect(resumed.tick - suspended.tick).toBeLessThanOrEqual(30);
  await page.keyboard.up('d');
});

test('page lifecycle suspension preserves a pending card and checkpoints without settling', async ({
  page,
}) => {
  await start(page, true);
  await page.evaluate(() => window.survivorUi.cards(2));
  const before = await state(page);
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await expect(game(page)).toHaveAttribute('data-phase', 'paused');
  await page.clock.fastForward(120_000);
  expect((await state(page)).profile.settlements).toHaveLength(0);
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  await expect(game(page)).toHaveAttribute('data-phase', 'choosing');
  expect((await state(page)).choice).toBe(before.choice);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  );
  await expect(game(page)).toHaveAttribute('data-phase', 'paused');
  const after = await state(page);
  expect(after.tick).toBe(before.tick);
  expect(after.profile.checkpoint?.tick).toBe(before.tick);
  expect(after.profile.settlements).toHaveLength(0);
});
