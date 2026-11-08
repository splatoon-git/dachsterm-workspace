// GE.3: what a drag out does with server files before the OS drag starts. It needs no mouse, so
// the SFTP and FTP scripts can check it in a hidden window.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function checkServerDragFetch({ invoke, source, file, body, folder, big, appData }) {
  const prepare = (target) => invoke('files_drag_prepare', { source, paths: [target] });
  const id = await prepare(file);
  assert.equal(typeof id, 'string');
  const root = path.join(appData, 'drag-out');
  const name = path.posix.basename(file);
  const fetched = [];
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory())
      fetched.push(await readFile(path.join(root, entry.name, name)).catch(() => null));
  assert.ok(
    fetched.some((data) => data?.equals(body)),
    'the fetched file must have the same bytes and name',
  );
  await assert.rejects(prepare(folder), /다운로드를 쓰세요/);
  await assert.rejects(prepare(big), /다운로드를 쓰세요/);
}
