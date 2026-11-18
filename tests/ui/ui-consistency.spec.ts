import { expect, test, type Locator } from '@playwright/test';
import type { Detection } from '../../src/features/kube/kubeModel';
import type {} from './fixtures/kube-workspace';

async function controlBoxes(controls: Locator) {
  return controls.evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          height: box.height,
          top: box.top,
          bottom: box.bottom,
          font: parseFloat(getComputedStyle(element).fontSize),
        };
      }),
  );
}

for (const theme of ['pms-retro-light', 'github-dark', 'terminal-green']) {
  for (const width of [1280, 800, 560, 360]) {
    test.describe(`${theme} ${width}px`, () => {
      test.use({ viewport: { width, height: 820 } });
      test.beforeEach(async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem('dachsterm.theme', value), theme);
      });

      test('settings keep actions aligned with fields and headings above body text', async ({
        page,
      }) => {
        await page.goto('/');
        await page.getByRole('button', { name: '설정', exact: true }).click();
        await page.locator('#settings-tab-agents').click();
        const row = page.locator('.agent-preset-row').first();
        const fields = await controlBoxes(row.locator('input,select'));
        const [action] = await controlBoxes(row.locator(':scope > button'));
        expect(fields.length).toBeGreaterThan(2);
        expect(
          fields.every((field) => field.height === action.height && field.font === action.font),
        ).toBe(true);
        // At narrow widths the name occupies the first row; the remove action stays beside it.
        expect(Math.abs(fields[0].bottom - action.bottom)).toBeLessThanOrEqual(1);
        const hierarchy = await page.locator('.settings-panel').evaluate((panel) => {
          const size = (selector: string) =>
            parseFloat(getComputedStyle(panel.querySelector(selector)!).fontSize);
          return {
            title: size('h3'),
            section: size('.dialog-section h3'),
            body: size('.dialog-section p'),
          };
        });
        expect(hierarchy.title).toBeGreaterThan(hierarchy.section);
        expect(hierarchy.section).toBeGreaterThanOrEqual(hierarchy.body);
        expect(
          await page
            .locator('.settings-panel')
            .evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
        ).toBe(true);

        await page.locator('#settings-tab-terminal').click();
        const [addRule] = await controlBoxes(
          page.getByRole('button', { name: '규칙 추가', exact: true }),
        );
        const [fontSelect] = await controlBoxes(page.getByLabel('글꼴 크기', { exact: true }));
        expect(addRule.height).toBe(fontSelect.height);
        expect(addRule.font).toBe(fontSelect.font);
      });

      test('key creation action shares the input and footer size', async ({ page }) => {
        await page.goto('/');
        await page.getByRole('button', { name: '새 SSH 연결', exact: true }).click();
        await page.getByLabel('인증 방식', { exact: true }).selectOption('key');
        const dialog = page.getByRole('dialog', { name: '새 연결', exact: true });
        const [create] = await controlBoxes(
          dialog.getByRole('button', { name: '새 키…', exact: true }),
        );
        const [name] = await controlBoxes(dialog.getByLabel('이름', { exact: true }));
        const [save] = await controlBoxes(
          dialog.getByRole('button', { name: '저장', exact: true }),
        );
        expect(create.height).toBe(name.height);
        expect(create.height).toBe(save.height);
        expect(create.font).toBe(name.font);
      });

      test('cluster setup follows the tab left edge and keeps one form scale', async ({
        page,
      }, testInfo) => {
        const detection: Detection = {
          state: { kind: 'configMissing' },
          kubectl: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\kubectl.exe',
          kubeconfig: '',
          context: '',
          contexts: [],
          namespaces: [],
          namespacesForbidden: false,
          copyCommand: '',
          saved: null,
        };
        await page.addInitScript((found) => {
          window.__kube = {
            detections: [found],
            persist: false,
            copyResult: { typed: 'wait' },
            calls: [],
            copied: [],
          } as unknown as Window['__kube'];
        }, detection);
        await page.goto('/tests/ui/fixtures/kube-workspace.html');
        const heading = page.getByRole('heading', {
          name: '쿠버네티스 설정 파일을 찾을 수 없습니다',
        });
        await expect(heading).toBeVisible();
        const geometry = await page.locator('.kube-setup').evaluate((setup) => {
          const card = setup.querySelector('.kube-setup-card')!;
          const title = card.querySelector('h2')!;
          const firstTab = document.querySelector('.kube-header > button')!;
          const tab = firstTab.getBoundingClientRect();
          const action = card.querySelector('.form-actions > button')!;
          const field = card.querySelector('input')!;
          return {
            title: title.getBoundingClientRect().left,
            tabText: tab.left + parseFloat(getComputedStyle(firstTab).paddingLeft),
            action: action.getBoundingClientRect().left,
            field: field.getBoundingClientRect().left,
            headingSize: parseFloat(getComputedStyle(title).fontSize),
            bodySize: parseFloat(getComputedStyle(card.querySelector('p')!).fontSize),
            overflow: setup.scrollWidth > setup.clientWidth,
          };
        });
        expect(geometry.title).toBe(geometry.tabText);
        expect(geometry.action).toBe(geometry.field);
        expect(geometry.headingSize).toBeGreaterThan(geometry.bodySize);
        expect(geometry.overflow).toBe(false);
        const controls = await controlBoxes(
          page.locator('.kube-setup-form input,.kube-setup-form button'),
        );
        expect(new Set(controls.map((control) => control.height)).size).toBe(1);
        expect(new Set(controls.map((control) => control.font)).size).toBe(1);
        await page.screenshot({ path: testInfo.outputPath('cluster-setup.png') });
      });
    });
  }
}
