import { expect, test } from '@playwright/test';

test('camera travel clears old pixels and taking damage keeps terrain anchored', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/survivor-quality.html');
  await page.waitForFunction(() => window.survivorQuality?.ready());
  expect(await page.evaluate(() => window.survivorQuality.checkMovingTerrain())).toEqual({
    returnsToScene: true,
    stableOnHit: true,
  });
});

test('four regions render distinctly, preserve run state and fit both themes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/tests/ui/fixtures/survivor-quality.html');
  await page.waitForFunction(() => !!window.survivorQuality);
  // Wait for the shared atlas so its redraw cannot replace a later region capture.
  await page.waitForFunction(() => window.survivorQuality.ready());
  const images: string[] = [];
  for (const dark of [false, true])
    for (const stage of [1, 4, 7, 10]) {
      const result = await page.evaluate(
        ({ stage, dark }) => window.survivorQuality.draw(stage, dark),
        { stage, dark },
      );
      expect(result.immutable).toBe(true);
      images.push(result.pixels);
      await page.screenshot({
        path: `target/verification/survivor-region-${stage}-${dark ? 'dark' : 'light'}.png`,
      });
    }
  expect(new Set(images).size).toBe(8);
  for (const width of [360, 560]) {
    await page.setViewportSize({ width, height: 720 });
    const result = await page.evaluate(() => window.survivorQuality.draw(7, true));
    expect(result.immutable).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `target/verification/survivor-region-narrow-${width}.png` });
  }
  expect(errors).toEqual([]);
});

test('dense rendering is read-only, deterministic with reduced motion, and reports frame cost', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/tests/ui/fixtures/survivor-quality.html');
  await page.waitForFunction(() => !!window.survivorQuality);
  await page.waitForFunction(() => window.survivorQuality.ready());
  const a = await page.evaluate(() => window.survivorQuality.draw(7, false, true));
  const b = await page.evaluate(() => window.survivorQuality.draw(7, false, true));
  const animated = await page.evaluate(() => window.survivorQuality.draw(7, false, true, false));
  expect(animated.immutable).toBe(true);
  expect(a.immutable && b.immutable).toBe(true);
  expect(a.pixels).toBe(b.pixels);
  await testInfo.attach('renderer-cost', {
    body: JSON.stringify({
      entities: 180,
      frames: 360,
      p95ms: [a.p95, b.p95],
      animatedP95ms: animated.p95,
      scope: 'Chromium RAF-paced Canvas submission; not full gameplay/GPU frame time',
    }),
    contentType: 'application/json',
  });
  await page.screenshot({ path: 'target/verification/survivor-region-crowd.png' });
});
