// The external edit save card (GE.1) against the real app and a real SFTP server.
// Run through `node scripts/run-phase1.mjs --native --edit-only`.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { chooseTabMenu } from './native-workspace.mjs';

export async function verifyEditSaveCard({
  page,
  pane,
  invoke,
  docker,
  probe,
  directory,
  screenshots,
  showConnections,
  connected,
  setStage,
}) {
  let remote = '/home/probe/edit-save.txt';
  const container = probe('CONTAINER');
  const cat = (file = remote) => docker(['exec', container, 'cat', file]);
  const onServer = (text) =>
    docker(['exec', '-u', 'probe', container, 'sh', '-c', `printf '%s' '${text}' > '${remote}'`]);
  const card = () => pane().getByRole('alertdialog', { name: '외부 편집 저장 확인', exact: true });
  const press = (name) => card().getByRole('button', { name, exact: true }).click();
  const uploaded = (text, timeout = 15000) => expect.poll(() => cat(), { timeout }).toBe(text);
  const row = async () => (await invoke('edit_list')).find((e) => e.id === edit.id);
  const status = (value) => expect.poll(async () => (await row()).status).toBe(value);
  const asked = (text) => expect(card()).toContainText(text, { timeout: 15000 });
  const save = (text) => writeFile(edit.local, text, 'utf8');
  const upload = '서버 파일에 업로드할까요?';
  const conflict = '서버 파일도 변경되었습니다';

  setStage('GE.1 start an external edit');
  onServer('original');
  const helper = path.join(directory, 'edit-save-helper.cjs');
  await writeFile(
    helper,
    "require('fs').writeFileSync(process.argv[2], 'first save', 'utf8');",
    'utf8',
  );
  const profile = (await invoke('sessions')).profiles[0];
  const edit = await invoke('edit_start', {
    id: await pane().getAttribute('data-connection-id'),
    profileId: profile.id,
    path: remote,
    program: process.execPath,
    args: [helper],
    encoding: 'original',
    uploadMode: 'ask',
  });

  // Connecting shows the file view; the point of the card is that another view does not hide it.
  await showConnections();
  setStage('GE.1 upload on the card');
  await asked(upload);
  await expect(card()).toContainText('edit-save.txt');
  await page.screenshot({ path: path.join(screenshots, 'edit-save-card.png') });
  assert.equal(cat(), 'original', 'Nothing is uploaded before the answer');
  await press('업로드');
  await uploaded('first save');
  await expect(card()).toBeHidden();
  console.log('PASS GE.1 a saved revision asks on the tab with the files view closed, and uploads');

  setStage('GE.1 cancel on the card');
  await save('second save');
  await asked(upload);
  await press('취소 · 수정본 보존');
  await status('recovery');
  await expect(card()).toBeHidden();
  assert.equal(cat(), 'first save');
  assert.equal(await readFile(edit.local, 'utf8'), 'second save');
  await invoke('edit_resolve', {
    id: edit.id,
    connectionId: await pane().getAttribute('data-connection-id'),
    profileId: profile.id,
    choice: 'retry',
    path: null,
  });
  await uploaded('second save');
  console.log('PASS GE.1 cancel keeps the revision and leaves the server alone');

  setStage('GE.1 conflict overwrite');
  onServer('changed on server 1');
  await save('third save');
  await asked(upload);
  await press('업로드');
  await asked(conflict);
  assert.equal(cat(), 'changed on server 1', 'A conflict must not reach the server');
  await press('덮어쓰기…');
  await expect(card().getByRole('button', { name: '취소', exact: true })).toBeFocused();
  await press('덮어쓰기');
  await uploaded('third save');

  setStage('GE.1 conflict reload');
  onServer('changed on server 2');
  await save('fourth save');
  await asked(upload);
  await press('업로드');
  await asked(conflict);
  await press('다시 받기');
  await expect.poll(() => readFile(edit.local, 'utf8')).toBe('changed on server 2');
  await status('watching');
  assert.equal(cat(), 'changed on server 2');

  setStage('GE.1 conflict save as');
  onServer('changed on server 3');
  await save('fifth save');
  await asked(upload);
  await press('업로드');
  await asked(conflict);
  await press('다른 이름…');
  const copy = '/home/probe/edit-save-copy.txt';
  await card().getByLabel('새 서버 경로', { exact: true }).fill(copy);
  await press('업로드');
  await expect.poll(() => cat(copy)).toBe('fifth save');
  assert.equal(cat(), 'changed on server 3', 'Saving under another name keeps the original');
  remote = copy; // The edit follows the new name from here on.
  await status('watching');
  console.log('PASS GE.1 a conflict asks again: overwrite, download again, another name');

  setStage('GE.1 automatic during this connection');
  await save('sixth save');
  await asked(upload);
  await press('이 연결 동안 자동 업로드');
  await uploaded('sixth save');
  await expect.poll(async () => (await row()).uploadMode).toBe('auto');
  const recovery = JSON.parse(
    await readFile(path.join(path.dirname(edit.local), 'recovery.json'), 'utf8'),
  );
  assert.equal(recovery.uploadMode, 'ask', 'The connection-only mode must not reach the disk');
  assert.equal('modeAfterConnection' in recovery, false);
  await save('seventh save');
  await uploaded('seventh save');
  await expect(card()).toBeHidden();
  console.log('PASS GE.1 automatic upload during the connection, not stored');

  setStage('GE.1 ends with the connection');
  await chooseTabMenu(page, '연결 종료');
  await expect(pane().getByRole('button', { name: '재접속', exact: true })).toBeVisible();
  await expect.poll(async () => (await row()).uploadMode, { timeout: 10000 }).toBe('ask');
  await pane().getByRole('button', { name: '재접속', exact: true }).click();
  await connected();
  await save('eighth save');
  await asked(upload);
  assert.equal(cat(), 'seventh save', 'A reconnected tab must ask again');
  await press('업로드');
  await uploaded('eighth save');
  const reconnected = await pane().getAttribute('data-connection-id');
  assert.equal((await row()).connectionId, reconnected, 'The answering tab takes the edit over');
  assert.equal((await row()).uploadMode, 'ask');
  await save('ninth save');
  await asked(upload);
  assert.equal(cat(), 'eighth save');
  await press('취소 · 수정본 보존');
  await status('recovery');
  console.log('PASS GE.1 the automatic upload ends on reconnect and the new tab asks');
}
