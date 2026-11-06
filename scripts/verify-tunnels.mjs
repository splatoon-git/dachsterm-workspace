// Exercise the production editor and real SSH forwarding; fixture values are never logged.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function echo(port, socks = false) {
  const socket = net.connect(port, '127.0.0.1');
  let received = Buffer.alloc(0);
  let failure;
  socket.on('data', (bytes) => {
    received = Buffer.concat([received, bytes]);
  });
  socket.on('error', (e) => {
    failure = e;
  });
  async function read(size) {
    const until = Date.now() + 10000;
    while (received.length < size) {
      if (failure || Date.now() > until) throw new Error('Tunnel roundtrip failed');
      await new Promise((r) => setTimeout(r, 25));
    }
    const bytes = received.subarray(0, size);
    received = received.subarray(size);
    return bytes;
  }
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    if (socks) {
      socket.write(Buffer.from([5, 1, 0]));
      assert.deepEqual(await read(2), Buffer.from([5, 0]));
      const host = Buffer.from('localhost');
      socket.write(
        Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0x23, 0x28])]),
      );
      assert.equal((await read(10))[1], 0);
    }
    const payload = Buffer.from('DACHSTERM_TUNNEL_UI_ROUNDTRIP');
    socket.write(payload);
    assert.deepEqual(await read(payload.length), payload);
  } finally {
    socket.destroy();
  }
}

export async function verifyTunnels({ page, invoke, probe, screenshots }) {
  const localEcho = net.createServer((socket) => socket.pipe(socket));
  await new Promise((r) => localEcho.listen(0, '127.0.0.1', r));
  const dialog = page.getByRole('dialog', { name: 'SSH 터널', exact: true });
  async function open() {
    await page.locator('.toolbar-menu > summary').filter({ hasText: '도구' }).click();
    await page.getByRole('button', { name: '터널', exact: true }).click();
    await expect(dialog).toBeVisible();
  }
  try {
    await open();
    for (const [kind, label] of [
      ['local', '로컬 포워딩'],
      ['remote', '원격 포워딩'],
      ['dynamic', 'SOCKS5 프록시'],
    ]) {
      const name = `UI ${kind}`;
      await dialog.getByRole('button', { name: '새 터널', exact: true }).click();
      await dialog.getByRole('radio', { name: new RegExp(label) }).check();
      await dialog.getByLabel('이름', { exact: true }).fill(name);
      await dialog.getByLabel('리스닝 포트').fill('0');
      if (kind !== 'dynamic')
        await dialog
          .getByLabel('목적지 포트', { exact: true })
          .fill(String(kind === 'remote' ? localEcho.address().port : 9000));
      await page.screenshot({ path: path.join(screenshots, `tunnel-editor-${kind}.png`) });
      await dialog.getByRole('button', { name: '설정 저장' }).click();
      const row = dialog.getByRole('article', { name, exact: true });
      await expect(row).toContainText('중지됨');
      await row.getByLabel('연결 시 자동 시작').click();
      await expect(row.getByLabel('연결 시 자동 시작')).toBeChecked();
      await expect
        .poll(async () => (await invoke('tunnel_configs')).find((c) => c.name === name)?.autoStart)
        .toBe(true);
      await row.getByLabel('연결 시 자동 시작').click();
      await expect(row.getByLabel('연결 시 자동 시작')).not.toBeChecked();
      await expect
        .poll(async () => (await invoke('tunnel_configs')).find((c) => c.name === name)?.autoStart)
        .toBe(false);
      await row.getByRole('button', { name: '시작', exact: true }).click();
      await expect(row).toContainText('실행 중');
      await expect(row.getByRole('button', { name: '수정' })).toBeDisabled();
      const status = (await invoke('tunnel_list')).find(
        (s) => s.name === name && s.status === 'running',
      );
      assert(status?.port > 0);
      if (kind === 'remote') {
        // Keep the Node event loop available for the local echo server.
        await promisify(execFile)('docker', [
          'exec',
          probe('CONTAINER'),
          'python3',
          '-c',
          `import socket; s=socket.create_connection(('127.0.0.1',${status.port}),timeout=5); s.sendall(b'UI_REMOTE'); assert s.recv(9)==b'UI_REMOTE'; s.close()`,
        ]);
      } else await echo(status.port, kind === 'dynamic');
      await dialog.getByRole('button', { name: '대화상자 닫기' }).click();
      await open();
      await expect(row).toContainText('실행 중');
      if (kind === 'local') await echo(status.port);
      await row.getByRole('button', { name: '중지', exact: true }).click();
      await expect(row).toContainText('중지됨');
    }
    await page.screenshot({ path: path.join(screenshots, 'tunnel-saved-list.png') });
    for (const kind of ['local', 'remote', 'dynamic']) {
      const row = dialog.getByRole('article', { name: `UI ${kind}`, exact: true });
      await row.getByRole('button', { name: '삭제', exact: true }).click();
      await row.getByRole('button', { name: '삭제 확인' }).click();
      await expect(row).toHaveCount(0);
    }
    await dialog.getByRole('button', { name: '대화상자 닫기' }).click();
    console.log(
      'PASS native tunnel visual editor / saved list / autostart toggle / local, remote, SOCKS5 real roundtrip / close preservation / stop / delete',
    );
  } finally {
    await new Promise((r) => localEcho.close(r));
  }
}
