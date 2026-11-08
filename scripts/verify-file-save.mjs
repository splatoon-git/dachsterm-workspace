// Saving a file tab (GE.6) against the real app and a real SFTP server.
// Run through `node scripts/run-phase1.mjs --native --edit-only`.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function verifyFileSave({ page, pane, invoke, docker, probe, setStage }) {
  const container = probe('CONTAINER');
  const shell = (script) => docker(['exec', '-u', 'probe', container, 'sh', '-c', script]);
  const dir = '/home/probe/ge6';
  shell(`mkdir -p ${dir}`);
  const file = `${dir}/tab-save.txt`;
  const put = (text, target = file) => shell(`printf '%s' '${text}' > '${target}'`);
  const cat = (target = file) => docker(['exec', container, 'cat', target]);
  const mode = (target = file) => shell(`stat -c %a '${target}'`).trim();
  const leftovers = () => shell(`ls -A ${dir} | grep -c dachsterm || true`).trim();
  const source = {
    kind: 'ssh',
    connectionId: await pane().getAttribute('data-connection-id'),
  };
  const read = (path = file) =>
    invoke('file_read', { source, path, options: { large: false, encoding: null } });
  const write = (content, baseHash, path = file) =>
    invoke('file_write', { source, path, content, encoding: 'utf-8', baseHash });

  setStage('GE.6 SFTP saves over the original and keeps its mode');
  put('원본');
  shell(`chmod 640 '${file}'`);
  const first = await read();
  const saved = await write('수정본', first.hash);
  assert.equal(saved.status, 'saved');
  assert.equal(cat(), '수정본');
  assert.equal(mode(), '640');
  assert.equal(leftovers(), '0');

  setStage('GE.6 SFTP refuses a changed file');
  put('바깥에서 바꿈');
  const conflict = await write('편집본', saved.hash);
  assert.equal(conflict.status, 'conflict');
  assert.equal(cat(), '바깥에서 바꿈', 'A conflict must not reach the server');
  assert.equal(leftovers(), '0');

  setStage('GE.6 SFTP overwrites the version it was told about');
  const overwritten = await write('덮어씀', conflict.hash);
  assert.equal(overwritten.status, 'saved');
  assert.equal(cat(), '덮어씀');

  setStage('GE.6 SFTP new names and removed files');
  shell(`rm '${file}'`);
  assert.deepEqual(await write('사라짐', overwritten.hash), { status: 'conflict', hash: null });
  const fresh = await write('새 파일', null);
  assert.equal(fresh.status, 'saved');
  assert.equal(cat(), '새 파일');
  const taken = await write('또', null);
  assert.equal(taken.status, 'conflict');
  assert.equal(cat(), '새 파일', 'A new name must not replace a file already there');

  setStage('GE.6 SFTP follows links and respects a read-only file');
  const link = `${dir}/link.txt`;
  shell(`ln -sf tab-save.txt '${link}'`);
  const linked = await read(link);
  assert.equal((await write('링크로 저장', linked.hash, link)).status, 'saved');
  assert.equal(shell(`test -L '${link}' && echo linked`).trim(), 'linked');
  assert.equal(cat(), '링크로 저장');
  shell(`chmod 440 '${file}'`);
  const locked = await read();
  await assert.rejects(write('막힘', locked.hash), /쓸 권한/);
  assert.equal(cat(), '링크로 저장');
  shell(`chmod 640 '${file}'`);
  console.log('PASS GE.6 SFTP save, conflict, overwrite, new name, link and read-only file');

  setStage('GE.6 SFTP in the tab');
  const files = page.locator('.files');
  await files.getByLabel('원격 경로', { exact: true }).fill(dir);
  await files.getByLabel('원격 경로', { exact: true }).press('Enter');
  put('탭 내용');
  await files.getByRole('button', { name: '파일 새로 고침', exact: true }).click();
  await files.locator('.file-row').filter({ hasText: 'tab-save.txt' }).click();
  const tab = page.getByRole('tab', { name: 'tab-save.txt', exact: true });
  const dirty = page.getByRole('tab', { name: 'tab-save.txt 저장 안 됨', exact: true });
  const shown = page.locator('.pane-cell:not([hidden]) .file-tab');
  const editor = shown.locator('.view-lines').first();
  const edit = async (text) => {
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(text);
  };
  await expect(editor).toContainText('탭 내용', { timeout: 30000 });
  await edit(' 한글 입력');
  await expect(dirty).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(tab).toBeVisible();
  assert.equal(cat(), '탭 내용 한글 입력');

  put('서버 쪽 변경');
  await edit('!');
  await page.keyboard.press('Control+s');
  const card = shown.getByRole('alertdialog', { name: '저장 충돌' });
  await expect(card).toContainText('내용이 바뀌어');
  assert.equal(cat(), '서버 쪽 변경');
  await card.getByRole('button', { name: '서버 내용 보기' }).click();
  await expect(shown.getByText('서버 내용', { exact: true })).toBeVisible();
  await expect(shown.locator('.view-lines').first()).toContainText('서버 쪽 변경');
  await card.getByRole('button', { name: '비교 닫기' }).click();
  await card.getByRole('button', { name: '덮어쓰기', exact: true }).click();
  await page
    .getByRole('dialog', { name: '파일을 덮어씁니다' })
    .getByRole('button', { name: '덮어쓰기', exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await expect(tab).toBeVisible();
  assert.equal(cat(), '탭 내용 한글 입력!');

  setStage('GE.6 SFTP close asks');
  await edit('?');
  await page.getByRole('button', { name: 'tab-save.txt 탭 닫기' }).click();
  const asked = page.getByRole('dialog', { name: 'tab-save.txt 저장' });
  await asked.getByRole('button', { name: '저장', exact: true }).click();
  await expect(tab).toHaveCount(0);
  await expect(dirty).toHaveCount(0);
  assert.equal(cat(), '탭 내용 한글 입력!?');
  assert.equal(leftovers(), '0');
  shell(`rm -rf ${dir}`);
  await files.getByLabel('원격 경로', { exact: true }).fill('/home/probe');
  await files.getByLabel('원격 경로', { exact: true }).press('Enter');
  await expect(files.getByLabel('원격 경로', { exact: true })).toHaveValue('/home/probe');
  console.log('PASS GE.6 SFTP tab: edit, save, conflict card, diff, overwrite, close asks');
}
