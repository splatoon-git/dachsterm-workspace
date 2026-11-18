import { chromium } from '@playwright/test';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Run against an isolated `npm run dev` server. This is a frontend layout inventory, not an
// SSH/backend test. Each browser context has disposable settings and never uses the user's app.
// Usage: npm run audit:ui -- http://127.0.0.1:1420 test-results/ui-audit
const baseURL = process.argv[2] || 'http://127.0.0.1:1420';
const out = path.resolve(process.argv[3] || 'test-results/ui-audit');
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const results = [];
async function measure(page, name) {
  const data = await page.evaluate(() => {
    const root = document.querySelector('dialog[open]') || document.body;
    const visible = (e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const controls = [...root.querySelectorAll('button,input,select,textarea')]
      .filter(visible)
      .map((e) => {
        const s = getComputedStyle(e),
          r = e.getBoundingClientRect();
        return {
          tag: e.tagName,
          type: e.getAttribute('type'),
          name: (
            e.getAttribute('aria-label') ||
            e.textContent ||
            e.closest('label')?.textContent ||
            ''
          )
            .trim()
            .slice(0, 80),
          class: e.className,
          font: s.fontSize,
          line: s.lineHeight,
          height: r.height,
          width: r.width,
          x: r.x,
          y: r.y,
          bottom: r.bottom,
          disabled: e.disabled,
        };
      });
    const text = [...root.querySelectorAll('h1,h2,h3,h4,label,p,small,summary,legend')]
      .filter(visible)
      .map((e) => ({
        tag: e.tagName,
        class: e.className,
        text: e.textContent.trim().slice(0, 100),
        font: getComputedStyle(e).fontSize,
        line: getComputedStyle(e).lineHeight,
      }));
    const overflow = [...root.querySelectorAll('*')]
      .filter(
        (e) =>
          visible(e) &&
          e.clientWidth > 0 &&
          e.scrollWidth > e.clientWidth + 2 &&
          !['auto', 'scroll'].includes(getComputedStyle(e).overflowX),
      )
      .slice(0, 40)
      .map((e) => ({
        tag: e.tagName,
        class: e.className,
        client: e.clientWidth,
        scroll: e.scrollWidth,
        text: e.textContent.trim().slice(0, 80),
      }));
    return {
      controls,
      text,
      overflow,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      rootWidth: root.clientWidth,
    };
  });
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  results.push({ name, ...data });
}
for (const theme of ['pms-retro-light', 'github-dark', 'terminal-green']) {
  for (const width of [1280, 800, 560, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 820 } });
    await context.addInitScript((theme) => localStorage.setItem('dachsterm.theme', theme), theme);
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const nav = page.getByRole('tablist', { name: '설정 분류' });
    for (const section of [
      'appearance',
      'terminal',
      'git',
      'agents',
      'vault',
      'sessions',
      'transfer',
      'recovery',
      'update',
    ]) {
      await nav.locator(`#settings-tab-${section}`).click();
      await measure(page, `${theme}-${width}-settings-${section}`);
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '새 SSH 연결', exact: true }).click();
    await measure(page, `${theme}-${width}-session`);
    await page.locator('summary', { hasText: '고급 옵션' }).click();
    await measure(page, `${theme}-${width}-session-advanced`);
    await page.getByLabel('인증 방식', { exact: true }).selectOption('key');
    await measure(page, `${theme}-${width}-session-key`);
    await context.close();
    console.log(`measured ${theme} ${width}`);
  }
}
await browser.close();
await writeFile(path.join(out, 'measurements.json'), JSON.stringify(results, null, 2));
const css = (await readdir('src', { recursive: true })).filter((f) => f.endsWith('.css'));
const definitions = [];
for (const file of css) {
  const contents = await readFile(path.join('src', file), 'utf8');
  contents.split('\n').forEach((line, i) => {
    if (/(?:font-size|line-height|font-weight|(?:min-)?height)\s*:/.test(line))
      definitions.push({ file, line: i + 1, declaration: line.trim() });
  });
}
await writeFile(
  path.join(out, 'source-inventory.json'),
  JSON.stringify({ cssFiles: css.length, definitions }, null, 2),
);
// Overflow candidates need inspection: clipped accessibility labels and a footer's deliberate
// negative margin are not layout defects. Never label this inventory a pass/fail visual review.
console.log(
  JSON.stringify(
    {
      screens: results.length,
      cssFiles: css.length,
      pageOverflow: results.filter((r) => r.pageOverflow).map((r) => r.name),
      overflowCandidates: results.filter((r) => r.overflow.length).length,
      output: out,
    },
    null,
    2,
  ),
);
