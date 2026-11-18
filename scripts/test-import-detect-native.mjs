// The import from this PC (I.2) in the built app: the empty connection list offers what it found,
// the offer opens the preview, and the sessions land under the program's group. A throwaway
// PuTTY session is written to the registry for the run and removed afterwards; the app's data is
// a temporary folder. Other programs' real settings on this PC are only counted, never printed.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';

if (process.platform !== 'win32') {
  console.log('SKIP the registry import is Windows-only.');
  process.exit(0);
}
const executable =
  process.env.DACHSTERM_EXE ??
  path.resolve(process.env.CARGO_TARGET_DIR ?? 'target', 'debug', 'dachsterm.exe');

const vendor = 'HKCU\\Software\\SimonTatham';
const name = `DachsTerm check ${randomUUID().slice(0, 8)}`;
const key = `${vendor}\\PuTTY\\Sessions\\${encodeURIComponent(name)}`;
function reg(args) {
  return spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
}
const vendorExisted = reg(['query', vendor]).status === 0;
for (const [value, type, data] of [
  ['Protocol', 'REG_SZ', 'ssh'],
  ['HostName', 'REG_SZ', 'import-check.invalid'],
  ['UserName', 'REG_SZ', 'tester'],
  ['PortNumber', 'REG_DWORD', '2222'],
]) {
  const added = reg(['add', key, '/v', value, '/t', type, '/d', data, '/f']);
  assert.equal(added.status, 0, `reg add ${value}: ${added.stderr}`);
}

const directory = mkdtempSync(path.join(tmpdir(), 'dachsterm-import-'));
let stop = async () => {};
const checks = [];
const pass = (label, detail = '') => {
  checks.push(label);
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
};
try {
  const launched = await launchNativeApp({ executable, directory });
  stop = launched.stop;
  const { page } = launched;
  page.setDefaultTimeout(15000);

  const found = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('config_detect'));
  // Only what was found and how many: places and contents stay off the log.
  const summary = found.map((f) => ({
    source: f.source,
    count: f.count,
    skipped: f.skipped,
    include: f.include,
    problem: f.problem,
  }));
  console.log(`found ${JSON.stringify(summary)}`);
  const putty = found.find((f) => f.source === 'putty');
  assert.ok(putty && !putty.problem && putty.count >= 1, 'PuTTY registry sessions are found');
  pass('config_detect reads the PuTTY registry', `${putty.count} sessions`);

  const offer = page.getByRole('group', { name: '이 PC에서 찾은 세션' });
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: /^PuTTY 세션 \d+개 가져오기…$/ }).click();
  pass('the empty connection list offers the found sessions');

  const label = page.getByLabel(`${name} 사용자명`);
  await expect(label).toHaveValue('tester');
  await page.getByRole('button', { name: '선택 해제' }).click();
  await page.locator('.transfer-row', { hasText: name }).getByRole('checkbox').check();
  await expect(page.getByLabel(/새 ‘PuTTY’ 그룹 아래에 넣기/)).toBeChecked();
  await page.getByRole('button', { name: '1개 세션 추가' }).click();
  await expect(page.getByText('1개 세션을 추가했습니다.')).toBeVisible();
  pass('the offer opens the preview and adds the ticked session');

  const saved = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('sessions'));
  const added = saved.profiles.find((p) => p.name === name);
  assert.ok(added, 'the session was saved');
  assert.deepEqual(
    [added.host, added.port, added.username],
    ['import-check.invalid', 2222, 'tester'],
  );
  const group = saved.groups.find((g) => g.id === added.groupId);
  assert.equal(group?.name, 'PuTTY');
  assert.equal(group?.parentId ?? null, null);
  pass('the session is saved under a new top-level PuTTY group');

  // Found again, the saved session starts unticked.
  await page
    .getByRole('group', { name: '이 PC에서 찾은 설정' })
    .getByRole('button', { name: '다시 찾기' })
    .click();
  const list = page.getByRole('group', { name: '이 PC에서 찾은 설정' });
  await list
    .locator('.found-source', { hasText: 'PuTTY' })
    .getByRole('button', { name: '미리보기' })
    .click();
  const row = page.locator('.transfer-row', { hasText: name });
  await expect(row).toContainText('이미 저장된 세션과 같은 대상');
  await expect(row.getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('button', { name: '가져오기 취소' }).click();
  pass('a session already saved starts unticked');

  const bookmarks = found.find((f) => f.source === 'bookmarks');
  if (!bookmarks) console.log('SKIP no bookmarks file on this PC');
  else {
    assert.equal(bookmarks.problem, null, 'the bookmarks file this PC uses is readable');
    const entry = list.locator('.found-source', { hasText: '세션 북마크' });
    await expect(entry).toContainText(`세션 북마크 ${bookmarks.count}개`);
    // Entries that were all left out still open, so the preview can say why.
    if (bookmarks.count > 0 || bookmarks.skipped > 0) {
      await entry.getByRole('button', { name: '미리보기' }).click();
      await expect(page.getByRole('heading', { name: /^변환 결과: / })).toContainText(
        `${bookmarks.count}개`,
      );
      await page.getByRole('button', { name: '가져오기 취소' }).click();
    } else await expect(entry.getByRole('button', { name: '미리보기' })).toBeDisabled();
    pass(
      'the bookmarks file this PC uses is found and counted',
      `${bookmarks.count} sessions, ${bookmarks.skipped} left out`,
    );
  }
} finally {
  await stop();
  reg(vendorExisted ? ['delete', key, '/f'] : ['delete', vendor, '/f']);
  rmSync(directory, { recursive: true, force: true });
}
assert.notEqual(reg(['query', key]).status, 0, 'the throwaway registry session is removed');
console.log(`PASS ${checks.length + 1} checks, throwaway registry session removed`);
