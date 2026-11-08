import { expect, test, type Page } from '@playwright/test';
import type { Detection, KubeState } from '../../src/features/kube/kubeModel';
import type {} from './fixtures/kube-workspace';

const found = (state: KubeState, patch: Partial<Detection> = {}): Detection => ({
  state,
  kubectl: '/usr/local/bin/kubectl',
  kubeconfig: '/etc/rancher/rke2/rke2.yaml',
  context: 'dev',
  contexts: ['dev', 'prod'],
  namespaces: ['default', 'web'],
  namespacesForbidden: false,
  copyCommand: 'mkdir -p ~/.kube && sudo install',
  saved: null,
  ...patch,
});
const saved = {
  context: 'prod',
  namespace: 'web',
  kubectl: '/k',
  kubeconfig: '/c',
  operate: false,
};

async function open(
  page: Page,
  detections: Detection[],
  options: { persist?: boolean; copyResult?: unknown } = {},
) {
  await page.addInitScript(
    ({ detections, persist, copyResult }) => {
      window.__kube = {
        detections,
        persist,
        copyResult,
        calls: [],
        copied: [],
      } as unknown as Window['__kube'];
    },
    {
      detections,
      persist: options.persist ?? true,
      copyResult: options.copyResult ?? { typed: 'wait' },
    },
  );
  await page.goto('/tests/ui/fixtures/kube-workspace.html');
}
const calls = (page: Page, command: string) =>
  page.evaluate(
    (command) => window.__kube.calls.filter((call) => call.command === command),
    command,
  );

test('the first connection asks for a context and saves the choice', async ({ page }) => {
  await open(page, [found({ kind: 'ready' })]);
  await expect(page.getByLabel('context', { exact: true })).toHaveValue('dev');
  await expect(page.locator('.kube-setup-found')).toContainText('/usr/local/bin/kubectl');
  await page.getByLabel('namespace', { exact: true }).selectOption('web');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await expect(page.locator('.kube-empty')).toContainText('대시보드');
  await expect(page.getByRole('tablist', { name: '쿠버네티스 화면' })).toContainText('dev');
  const [save] = await calls(page, 'kube_save');
  expect(save.args.kube).toEqual({
    context: 'dev',
    namespace: 'web',
    kubectl: '/usr/local/bin/kubectl',
    kubeconfig: '/etc/rancher/rke2/rke2.yaml',
    operate: false,
  });
});

test('choosing another context reads that context again', async ({ page }) => {
  await open(page, [
    found({ kind: 'ready' }),
    found({ kind: 'ready' }, { context: 'prod', namespaces: ['prod-only'] }),
  ]);
  await page.getByLabel('context', { exact: true }).selectOption('prod');
  await expect(page.getByLabel('namespace', { exact: true }).locator('option')).toHaveText([
    '전체',
    'prod-only',
  ]);
  const detects = await calls(page, 'kube_detect');
  expect(detects[1].args).toMatchObject({
    context: 'prod',
    request: { mode: 'manual', kubectl: '/usr/local/bin/kubectl' },
  });
});

test('an account that cannot list namespaces types one', async ({ page }) => {
  await open(page, [found({ kind: 'ready' }, { namespaces: [], namespacesForbidden: true })]);
  await expect(page.getByText('이 계정은 namespace 목록을 볼 수 없어')).toBeVisible();
  await page.getByLabel('namespace', { exact: true }).fill('team-a');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await expect(page.locator('.kube-empty')).toBeVisible();
  const [save] = await calls(page, 'kube_save');
  expect((save.args.kube as { namespace: string }).namespace).toBe('team-a');
});

test('a saved session opens directly', async ({ page }) => {
  await open(page, [found({ kind: 'ready' }, { saved })]);
  await expect(page.locator('.kube-empty')).toContainText('대시보드');
  await expect(page.getByLabel('context', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: '쿠버네티스 화면' })).toContainText('prod');
  expect(await calls(page, 'kube_save')).toEqual([]);
});

test('a saved cluster that is down keeps the screen and says so', async ({ page }) => {
  await open(page, [found({ kind: 'unreachable' }, { saved })]);
  await expect(page.locator('.kube-empty')).toBeVisible();
  await expect(page.getByRole('tablist', { name: '쿠버네티스 화면' })).toContainText(
    '클러스터 연결 불가',
  );
});

test('an unreadable config offers the copy and a recheck that finishes by itself', async ({
  page,
}) => {
  await open(page, [
    found({ kind: 'configUnreadable' }),
    found({ kind: 'ready' }, { contexts: ['only'], context: 'only' }),
  ]);
  await expect(
    page.getByRole('heading', { name: '이 계정은 쿠버네티스 설정을 읽을 수 없습니다' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '터미널에서 설정 복사', exact: true }).click();
  expect(await page.evaluate(() => window.__kube.copied)).toEqual([
    'mkdir -p ~/.kube && sudo install',
  ]);
  const tabs = page.getByRole('tablist', { name: '쿠버네티스 화면' });
  await expect(tabs.getByRole('tab', { name: '서버 터미널', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(tabs).toContainText('Enter를 누르고');
  await tabs.getByRole('button', { name: '다시 확인', exact: true }).click();
  await expect(page.locator('.kube-empty')).toContainText('대시보드');
  const [save] = await calls(page, 'kube_save');
  expect((save.args.kube as { context: string }).context).toBe('only');
});

test('several contexts still ask after a recheck', async ({ page }) => {
  await open(page, [found({ kind: 'authFailed' }), found({ kind: 'ready' })]);
  await expect(page.getByRole('heading', { name: '클러스터 인증에 실패했습니다' })).toBeVisible();
  await page.getByRole('button', { name: '다시 확인', exact: true }).click();
  await expect(page.getByLabel('context', { exact: true })).toBeVisible();
  expect(await calls(page, 'kube_save')).toEqual([]);
});

test('a busy shell blocks the copy and explains why', async ({ page }) => {
  await open(page, [found({ kind: 'configUnreadable' })], {
    copyResult: { blocked: '터미널이 사용 중입니다.' },
  });
  await page.getByRole('button', { name: '터미널에서 설정 복사', exact: true }).click();
  await expect(page.getByText('터미널이 사용 중입니다.')).toBeVisible();
  await expect(page.getByRole('tab', { name: '서버 터미널', exact: true })).toHaveAttribute(
    'aria-selected',
    'false',
  );
});

test('no source to copy from says so instead of offering the button', async ({ page }) => {
  await open(page, [found({ kind: 'authFailed' }, { copyCommand: null })]);
  await expect(
    page.getByRole('button', { name: '터미널에서 설정 복사', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('복사할 원본을 찾지 못했습니다')).toBeVisible();
});

test('a missing kubectl takes a typed command', async ({ page }) => {
  await open(page, [
    found({ kind: 'kubectlMissing' }, { kubectl: '', kubeconfig: '', contexts: [] }),
    found({ kind: 'ready' }, { kubectl: 'microk8s kubectl', kubeconfig: '' }),
  ]);
  await expect(page.getByRole('heading', { name: 'kubectl을 찾을 수 없습니다' })).toBeVisible();
  await page.getByLabel('kubectl 명령', { exact: true }).fill('microk8s kubectl');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await expect(page.getByLabel('context', { exact: true })).toBeVisible();
  const detects = await calls(page, 'kube_detect');
  expect(detects[1].args.request).toEqual({
    mode: 'manual',
    kubectl: 'microk8s kubectl',
    kubeconfig: '',
  });
});

test('a terminal session is not saved', async ({ page }) => {
  await open(page, [found({ kind: 'ready' })], { persist: false });
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await expect(page.locator('.kube-empty')).toBeVisible();
  expect(await calls(page, 'kube_save')).toEqual([]);
});

test('the server hit its session limit', async ({ page }) => {
  await open(page, [
    found({ kind: 'channelLimit' }, { kubectl: '', kubeconfig: '', contexts: [] }),
  ]);
  await expect(
    page.getByRole('heading', { name: '서버의 동시 세션 한도에 걸렸습니다' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '다시 확인', exact: true })).toBeEnabled();
});
