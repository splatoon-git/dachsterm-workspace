// Port check and port list (TL.6, TL.7) in the built app against real OpenSSH servers and targets.
// Passwords are generated or read per run and are never printed.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';

const executable =
  process.env.DACHSTERM_EXE ??
  path.resolve(process.env.CARGO_TARGET_DIR ?? 'target', 'debug', 'dachsterm.exe');
const run = randomUUID().slice(0, 8);
const network = `dachsterm-tl6-net-${run}`;
const name = (part) => `dachsterm-tl6-${part}-${run}`;
const containers = [];
const directory = mkdtempSync(path.join(tmpdir(), 'dachsterm-tl6-'));
const alpinePassword = randomBytes(24).toString('hex');
/** Runs only the port list stages, for when the port check stages have already passed. */
const listOnly = process.argv.includes('--list-only');
const OPEN = '포트 개통';
const USE = '포트 사용 여부';

function tool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw new Error(`${path.basename(command)} did not run`);
  return result;
}
function docker(args, options) {
  const result = tool('docker', args, options);
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed`);
  return result.stdout;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const build = (tag, dockerfile) =>
  docker(['build', '-q', '-t', tag, '-'], { input: dockerfile, timeout: 300000 });

function start(part, image, args, command = []) {
  const container = name(part);
  containers.push(container);
  docker(['run', '-d', '--name', container, '--network', network, ...args, image, ...command]);
  return container;
}
const portOf = (container, inner) =>
  Number(
    docker(['port', container, `${inner}/tcp`])
      .trim()
      .split('\n')[0]
      .split(':')
      .pop(),
  );
async function until(check, what) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await wait(500);
  }
  throw new Error(`${what} did not become ready`);
}
const sshdUp = (container, port) => () =>
  tool('docker', [
    'exec',
    container,
    'sh',
    '-c',
    `cat /proc/net/tcp | grep -qi ":$(printf '%04X' ${port}) "`,
  ]).status === 0;

const ALPINE_BASE = `set -e
ssh-keygen -A >/dev/null
adduser -D -s /bin/sh probe
echo "probe:$PW" | chpasswd
`;
const SSHD = 'exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes -o PermitRootLogin=no';
const NO_TOOLS = 'rm -f $(which nc netstat lsof 2>/dev/null)\n';
const JAIL = (
  root,
) => `mkdir -p ${root}/bin ${root}/lib ${root}/dev ${root}/usr/bin ${root}/home/probe
cp /bin/busybox ${root}/bin/; cp /lib/ld-musl-*.so.1 ${root}/lib/
ln -s busybox ${root}/bin/sh; ln -s busybox ${root}/bin/cat
mknod -m 666 ${root}/dev/null c 1 3
chown root:root ${root}; chmod 755 ${root}
`;
const STUB_LSOF = `printf '#!/bin/sh\\nprintf "p42\\\\ncexampled\\\\nf3\\\\nPTCP\\\\nn*:7000\\\\n"\\n' > /jail/usr/bin/lsof; chmod 755 /jail/usr/bin/lsof\n`;
const STUB_NETSTAT = `printf '#!/bin/sh\\nprintf "Proto Recv-Q Send-Q Local Foreign (state)\\\\ntcp4 0 0 *.7001 *.* LISTEN\\\\n"\\n' > /jail/usr/bin/netstat; chmod 755 /jail/usr/bin/netstat\n`;
function alpine(part, script, sshOptions = '-o AllowTcpForwarding=no') {
  return start(
    part,
    name2('alpine'),
    ['-e', `PW=${alpinePassword}`, '-p', '127.0.0.1::22'],
    ['sh', '-c', `${ALPINE_BASE}${script}${SSHD} ${sshOptions}`],
  );
}
const name2 = (tag) => `dachsterm-tl6-${tag}`;

let opened;
let stage = 'startup';
const pageOf = () => opened.page;
const invoke = (command, args = {}) =>
  pageOf().evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const region = (title) => pageOf().getByRole('region', { name: title, exact: true });
const status = (title) => region(title).getByRole('status');
const rows = (title) => region(title).locator('.tool-results tbody tr');
const rowOf = (title, host, port) =>
  region(title).locator(
    `.tool-results tbody tr:has(td:nth-child(2):text-is("${host}")):has(td:nth-child(3):text-is("${port}"))`,
  );
const button = (title, label) => region(title).getByRole('button', { name: label, exact: true });
const summary = (title) => region(title).locator('.tool-summary');

async function openTool(title) {
  const page = pageOf();
  await page.locator('.toolbar-menu summary', { hasText: '도구' }).click();
  await page
    .getByRole('navigation', { name: '네트워크 도구 목록' })
    .getByRole('button', { name: title, exact: true })
    .click();
  await expect(region(title)).toBeVisible();
}
async function closeTool(title) {
  await pageOf()
    .getByRole('button', { name: `${title} 탭 닫기`, exact: true })
    .click();
  await expect(region(title)).toHaveCount(0);
}
async function pick(title, session) {
  await region(title).getByRole('radio', { name: '리모트', exact: true }).check();
  await region(title).locator('.tool-session > button').click();
  await region(title).locator('.tool-session-list button').filter({ hasText: session }).click();
}
/** Answers only what appears: a connected terminal or a known host key asks nothing. */
async function login(title, session, password) {
  await pick(title, session);
  const prompt = region(title).getByRole('form', { name: '서버 추가 인증' });
  const card = region(title).getByRole('alert', { name: '최초 호스트키 확인' });
  const connected = status(title).filter({ hasText: '연결됨' });
  for (;;) {
    await expect(prompt.or(card).or(connected).first()).toBeVisible({ timeout: 30000 });
    if (await connected.isVisible()) return;
    if (await prompt.isVisible()) {
      await prompt.locator('input').fill(password);
      await prompt.getByRole('button', { name: '인증 응답', exact: true }).click();
      await expect(prompt).toBeHidden({ timeout: 30000 });
    } else {
      await card.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
      await expect(card).toBeHidden({ timeout: 30000 });
    }
  }
}
/** Starts a check and answers the several-hosts question when it comes. */
async function submit(title, targets, ports, seconds = 3) {
  await region(title).getByLabel('대상', { exact: true }).fill(targets);
  await region(title).getByLabel('포트', { exact: true }).fill(ports);
  await region(title).getByLabel('시간 초과(초)').fill(String(seconds));
  await button(title, '점검').click();
}
async function confirmCheck() {
  const dialog = pageOf().getByRole('dialog', { name: '여러 대상 점검' });
  await expect(dialog).toContainText('허가된 망에서만');
  await dialog.locator('.form-actions .primary').click();
  await expect(dialog).toBeHidden();
}
/** The total is part of the wait, or the summary left by the check before could satisfy it. */
const finished = (title, total) =>
  expect(summary(title)).toContainText(`${total}개 중 `, { timeout: 120000 });
const expectOutcome = (title, host, port, text) =>
  expect(rowOf(title, host, port).locator('.tool-outcome')).toHaveText(text, { timeout: 30000 });

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const synSent = (container) =>
  Number(
    tool('docker', [
      'exec',
      container,
      'sh',
      '-c',
      'awk \'$4 == "02"\' /proc/net/tcp | wc -l',
    ]).stdout.trim(),
  );
const logins = (container) =>
  docker(['exec', container, 'ps', '-eo', 'args'])
    .split('\n')
    .filter((line) => line.startsWith('sshd: probe') && !line.includes('[priv]')).length;

function profile(session, port, over = {}) {
  return {
    id: session,
    name: session,
    host: '127.0.0.1',
    port,
    username: 'probe',
    auth: 'password',
    protocol: 'ssh',
    tlsCaPath: '',
    encoding: 'utf-8',
    keyPath: '',
    groupId: null,
    favorite: false,
    timeout: 15,
    keepalive: 5,
    lastConnected: null,
    hasSecret: false,
    jumpIds: [],
    tags: [],
    sortOrder: 0,
    ...over,
  };
}

const localListener = net.createServer();
const localUdp = dgram.createSocket('udp4');
try {
  stage = 'images and network';
  docker(['build', '-q', '-t', 'dachsterm-tl6-openssh', 'tests/openssh'], { timeout: 300000 });
  build(
    name2('main'),
    'FROM dachsterm-tl6-openssh\nRUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*\n',
  );
  build(name2('alpine'), 'FROM alpine:3.22\nRUN apk add --no-cache openssh-server\n');
  build(name2('target'), 'FROM alpine:3.22\nRUN apk add --no-cache iptables socat\n');
  docker(['network', 'create', network]);

  stage = 'servers and target';
  const main = start('main', name2('main'), [
    '-p',
    '127.0.0.1::22',
    '-p',
    '127.0.0.1::2230',
    '-p',
    '127.0.0.1::2231',
  ]);
  await until(
    () => tool('docker', ['exec', main, 'test', '-f', '/run/probe/ready']).status === 0,
    'the main server',
  );
  const password = docker(['exec', main, 'cat', '/run/probe/password']).trim();
  docker([
    'exec',
    main,
    'sh',
    '-c',
    "sed -e 's/^Port 22/Port 2230/' -e 's/^AllowTcpForwarding yes/AllowTcpForwarding no/' /etc/ssh/sshd_config > /run/probe/noforward; /usr/sbin/sshd -f /run/probe/noforward",
  ]);
  docker([
    'exec',
    main,
    'sh',
    '-c',
    "sed -e 's/^Port 22/Port 2231/' /etc/ssh/sshd_config > /run/probe/limit; ulimit -n 64; /usr/sbin/sshd -f /run/probe/limit",
  ]);
  await until(sshdUp(main, 2230), 'the no-forwarding server');
  await until(sshdUp(main, 2231), 'the low-descriptor server');
  docker(['exec', '-d', '-u', 'probe', main, 'python3', '-m', 'http.server', '7777']);

  const target = start(
    'target',
    name2('target'),
    ['--cap-add', 'NET_ADMIN'],
    ['sh', '-c', 'socat TCP-LISTEN:8001,reuseaddr,fork EXEC:/bin/cat'],
  );
  for (const rule of [
    '-A INPUT -p tcp --dport 8003 -j DROP',
    '-A INPUT -p tcp --dport 8004 -j REJECT --reject-with icmp-host-unreachable',
    '-A INPUT -p tcp --dport 8005 -j REJECT --reject-with icmp-net-unreachable',
    '-A INPUT -p tcp --dport 10000:11000 -j DROP',
  ])
    docker(['exec', target, 'iptables', ...rule.split(' ')]);
  const targetIp = docker([
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    target,
  ]).trim();

  const nc = alpine('nc', '');
  const bare = alpine('bare', NO_TOOLS);
  const jailLsof = alpine(
    'jail-lsof',
    `${NO_TOOLS}${JAIL('/jail')}${STUB_LSOF}printf 'Match User probe\\n ChrootDirectory /jail\\n' >> /etc/ssh/sshd_config\n`,
  );
  const jailNetstat = alpine(
    'jail-netstat',
    `${NO_TOOLS}${JAIL('/jail')}${STUB_NETSTAT}printf 'Match User probe\\n ChrootDirectory /jail\\n' >> /etc/ssh/sshd_config\n`,
  );
  for (const container of [nc, bare, jailLsof, jailNetstat])
    await until(sshdUp(container, 22), container);

  stage = 'app start and sessions';
  opened = await launchNativeApp({ executable, directory });
  pageOf().setDefaultTimeout(15000);
  await expect(pageOf().getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  const mainPort = portOf(main, 22);
  const sessions = [
    profile('TL6-main', mainPort),
    profile('TL6-noforward', portOf(main, 2230)),
    profile('TL6-limit', portOf(main, 2231)),
    profile('TL6-nc', portOf(nc, 22)),
    profile('TL6-bare', portOf(bare, 22)),
    profile('TL6-jl', portOf(jailLsof, 22)),
    profile('TL6-jn', portOf(jailNetstat, 22)),
    // Not the main server's port: a connected terminal there would be reused and SSH would work.
    profile('TL6-dead', portOf(main, 2230)),
  ];
  const imported = await invoke('config_apply', {
    data: JSON.stringify({
      format: 'dachsterm.sessions',
      version: 3,
      profiles: sessions,
      groups: [],
      tunnels: [],
      templates: [],
    }),
  });
  assert.equal(imported, sessions.length);
  await pageOf().reload();
  await expect(pageOf().getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();

  if (!listOnly) {
    stage = 'local: the five results';
    await openTool(OPEN);
    const closedPort = await freePort();
    const local = [
      ['127.0.0.1', mainPort, '열림'],
      ['127.0.0.1', closedPort, '닫힘'],
      ['192.0.2.1', 80, '응답 없음'],
      ['240.0.0.1', 80, '도달 불가'],
      ['no-such-name.invalid', 80, '확인 불가'],
    ];
    for (const [host, port, expected] of local) {
      await submit(OPEN, host, String(port));
      await expectOutcome(OPEN, host, port, expected);
      console.log(`PASS local ${host}:${port} is ${expected}`);
    }

    stage = 'local: limits and confirmation';
    await submit(OPEN, '10.0.0.0/23', '22');
    await expect(region(OPEN).getByRole('alert')).toContainText('너무 큽니다');
    await submit(OPEN, '10.0.0.0/24', '1-17');
    await expect(region(OPEN).getByRole('alert')).toContainText('4352회');
    await submit(OPEN, '127.1.1.0/24', '1');
    await confirmCheck();
    await finished(OPEN, 256);
    await expect(summary(OPEN)).toContainText('256개 중 0개 열림');
    await expect(rows(OPEN)).toHaveCount(0);
    await region(OPEN).getByLabel('전체 결과 보기').check();
    await expect(rows(OPEN)).toHaveCount(256);
    await region(OPEN).getByLabel('전체 결과 보기').uncheck();
    console.log('PASS the limits refuse too much, and a range asks first and shows open ports');

    stage = 'local: cancel';
    await submit(OPEN, '192.0.2.0/25', '80', 30);
    await confirmCheck();
    await expect(summary(OPEN)).toContainText('진행');
    const started = Date.now();
    await button(OPEN, '취소').click();
    await expect(summary(OPEN)).toContainText('취소됨', { timeout: 5000 });
    assert.ok(Date.now() - started < 5000, 'cancel did not take effect promptly');
    await closeTool(OPEN);
    console.log('PASS a local check stops at once when cancelled');

    stage = 'remote: the five results and two-stage verdict';
    await openTool(OPEN);
    await login(OPEN, 'TL6-main', password);
    const dead = 'no-such-name.invalid';
    await submit(OPEN, `${targetIp} ${dead}`, '8001,8002,8003,8004,8005');
    await confirmCheck();
    await finished(OPEN, 10);
    await expectOutcome(OPEN, targetIp, 8001, '열림');
    await expectOutcome(OPEN, targetIp, 8002, '닫힘');
    await expectOutcome(OPEN, targetIp, 8003, '응답 없음');
    await expectOutcome(OPEN, targetIp, 8004, '도달 불가');
    await expectOutcome(OPEN, targetIp, 8005, '도달 불가');
    await expectOutcome(OPEN, dead, 8001, '확인 불가');
    await expect(rowOf(OPEN, dead, 8001)).toContainText('이름을 해석');
    console.log('PASS remote gives all five results, and the description settles each closed port');

    stage = 'remote: more undecided than can be confirmed';
    await submit(OPEN, targetIp, '9000-9064');
    await finished(OPEN, 65);
    await region(OPEN).getByLabel('전체 결과 보기').check();
    await expect(rows(OPEN)).toHaveCount(65);
    await expectOutcome(OPEN, targetIp, 9000, '닫힘 또는 도달 불가');
    await expectOutcome(OPEN, targetIp, 9064, '닫힘 또는 도달 불가');
    await region(OPEN).getByLabel('전체 결과 보기').uncheck();
    await submit(OPEN, targetIp, '9000-9063');
    await finished(OPEN, 64);
    await region(OPEN).getByLabel('전체 결과 보기').check();
    await expectOutcome(OPEN, targetIp, 9063, '닫힘');
    await region(OPEN).getByLabel('전체 결과 보기').uncheck();
    console.log('PASS 65 undecided stay undecided and 64 are confirmed one by one');

    stage = 'remote: unresolved channel limit, then cancel';
    await submit(OPEN, targetIp, '10000-10299', 1);
    await expect(summary(OPEN)).toContainText('서버 응답 대기 중', { timeout: 60000 });
    let peak = 0;
    for (let i = 0; i < 8; i++) {
      peak = Math.max(peak, synSent(main));
      await wait(250);
    }
    assert.ok(peak >= 200 && peak <= 256, `unresolved channels: ${peak}`);
    console.log(`PASS the check waits at the unresolved limit (server had ${peak}, limit 256)`);
    await button(OPEN, '취소').click();
    await expect(summary(OPEN)).toContainText('정리하려고 출발지 연결을 닫았습니다', {
      timeout: 10000,
    });
    await expect(status(OPEN)).toContainText('연결을 닫았습니다', { timeout: 10000 });
    await expect.poll(() => synSent(main), { timeout: 15000 }).toBe(0);
    await expect.poll(() => logins(main), { timeout: 15000 }).toBe(0);
    await expect(button(OPEN, '다시 연결')).toBeVisible();
    await closeTool(OPEN);
    console.log('PASS cancelling ends the owned connection, which clears the server');

    stage = 'remote: running out of descriptors stops the check';
    await openTool(OPEN);
    await login(OPEN, 'TL6-limit', password);
    await submit(OPEN, targetIp, '10000-10199', 1);
    await finished(OPEN, 200);
    await expect(region(OPEN).locator('.tool-notice')).toContainText(
      '서버가 연결을 더 시작하지 못함',
    );
    await region(OPEN).getByLabel('전체 결과 보기').check();
    await expect(rows(OPEN)).toHaveCount(200);
    assert.equal(
      await rows(OPEN).filter({ hasText: '닫힘' }).count(),
      0,
      'exhaustion was shown as closed',
    );
    await expect(
      region(OPEN).locator('.tool-results tbody tr', { hasText: '시도하지 않았습니다' }).first(),
    ).toBeVisible();
    await closeTool(OPEN);
    console.log('PASS exhausting the server stops the check and nothing is called closed');

    stage = 'remote fallback: bash';
    await openTool(OPEN);
    await login(OPEN, 'TL6-noforward', password);
    await submit(OPEN, targetIp, '8001,8002,8003,8004');
    await finished(OPEN, 4);
    await expectOutcome(OPEN, targetIp, 8001, '열림');
    await expect(rowOf(OPEN, targetIp, 8001)).toContainText('bash');
    await expectOutcome(OPEN, targetIp, 8002, '닫힘');
    await expectOutcome(OPEN, targetIp, 8003, '응답 없음');
    await expectOutcome(OPEN, targetIp, 8004, '도달 불가');
    await closeTool(OPEN);
    console.log("PASS with forwarding forbidden the server's bash tells the results apart");

    stage = 'remote fallback: nc';
    await openTool(OPEN);
    await login(OPEN, 'TL6-nc', alpinePassword);
    await submit(OPEN, targetIp, '8001,8002,8003');
    await finished(OPEN, 3);
    await expectOutcome(OPEN, targetIp, 8001, '열림');
    await expect(rowOf(OPEN, targetIp, 8001)).toContainText('nc');
    await expectOutcome(OPEN, targetIp, 8002, '닫힘 또는 응답 없음');
    await expectOutcome(OPEN, targetIp, 8003, '닫힘 또는 응답 없음');
    await closeTool(OPEN);
    console.log('PASS without bash, nc is used and says it cannot tell refused from silent');

    stage = 'remote fallback: nothing to use';
    await openTool(OPEN);
    await login(OPEN, 'TL6-bare', alpinePassword);
    await submit(OPEN, targetIp, '8001');
    await finished(OPEN, 1);
    await expectOutcome(OPEN, targetIp, 8001, '확인 불가');
    await expect(rowOf(OPEN, targetIp, 8001)).toContainText('bash, nc도 없습니다');
    await closeTool(OPEN);
    console.log('PASS with forwarding forbidden and no tools the result is unknown');

    stage = 'remote: a shared terminal stays when a check is cancelled';
    const page = pageOf();
    await page.locator('.profile-target').filter({ hasText: 'TL6-main' }).dblclick();
    const authDialog = page.getByRole('dialog', { name: 'TL6-main 인증' });
    await authDialog.getByLabel('비밀번호', { exact: true }).fill(password);
    await authDialog.getByRole('button', { name: '연결', exact: true }).click();
    await expect(
      page.locator('.pane-cell.focused .terminal-pane:not([hidden]) .connection-message'),
    ).toContainText('연결됨', { timeout: 30000 });
    await expect.poll(() => logins(main)).toBe(1);
    await openTool(OPEN);
    await pick(OPEN, 'TL6-main');
    await expect(status(OPEN)).toContainText('터미널 연결을 함께', { timeout: 20000 });
    await submit(OPEN, targetIp, '10300-10319', 30);
    await expect(summary(OPEN)).toContainText('진행');
    await expect.poll(() => synSent(main), { timeout: 10000 }).toBeGreaterThan(0);
    await button(OPEN, '취소').click();
    await expect(summary(OPEN)).toContainText('서버가 응답할 때까지 유지', { timeout: 10000 });
    await wait(1000);
    assert.equal(logins(main), 1, 'the terminal connection was closed');
    await expect(status(OPEN)).toContainText('터미널 연결을 함께');
    await closeTool(OPEN);
    console.log('PASS cancelling on a shared terminal leaves that terminal connected');
  }

  stage = 'local port list';
  const listenPort = await freePort();
  await new Promise((resolve) => localListener.listen(listenPort, '127.0.0.1', resolve));
  await new Promise((resolve) => localUdp.bind(0, '127.0.0.1', resolve));
  const udpPort = localUdp.address().port;
  const unused = await freePort();
  await openTool(USE);
  await button(USE, '확인').click();
  await expect(summary(USE)).toContainText('Windows 소켓 표', { timeout: 20000 });
  assert.ok((await rows(USE).count()) > 0, 'the whole list is empty');
  const ports = region(USE).getByLabel('포트(비우면 전체)');
  await ports.fill(`${listenPort},${udpPort},${unused}`);
  await expect(summary(USE)).toContainText('사용 중 2개 · 사용 안 함 1개');
  await expect(rows(USE).filter({ hasText: String(listenPort) })).toContainText('node.exe');
  await expect(rows(USE).filter({ hasText: String(udpPort) })).toContainText('UDP');
  await expect(region(USE).locator('.tool-unused')).toContainText(String(unused));
  await closeTool(USE);
  console.log('PASS this PC lists TCP and UDP with process names and answers about a port');

  stage = 'remote port list ladder';
  async function listFrom(session, secret, expected, check) {
    await openTool(USE);
    await login(USE, session, secret);
    await button(USE, '확인').click();
    await expect(summary(USE)).toContainText(expected, { timeout: 20000 });
    await check();
    await closeTool(USE);
    console.log(`PASS ${session} reads the port list by ${expected}`);
  }
  await listFrom('TL6-main', password, '/proc/net, ss', async () => {
    await expect(rows(USE).filter({ hasText: '7777' }).first()).toContainText('python3 (');
    const ssh = rows(USE).filter({ has: pageOf().locator('td:first-child', { hasText: /^22$/ }) });
    await expect(ssh.first()).toContainText('권한 없음');
    await expect(region(USE).locator('.tool-notice')).toContainText('다른 계정');
  });
  await listFrom('TL6-nc', alpinePassword, '/proc/net, netstat', async () => {
    await expect(rows(USE).filter({ hasText: 'TCP' }).first()).toBeVisible();
  });
  await listFrom('TL6-bare', alpinePassword, '프로세스 이름을 읽을 도구가 없습니다', async () => {
    await expect(rows(USE).first()).toContainText('알 수 없음');
  });
  await listFrom('TL6-jl', alpinePassword, 'lsof', async () => {
    await expect(rows(USE).filter({ hasText: '7000' })).toContainText('exampled (42)');
  });
  await listFrom('TL6-jn', alpinePassword, 'netstat', async () => {
    await expect(rows(USE).filter({ hasText: '7001' })).toContainText('알 수 없음');
  });

  stage = 'SSH fails: asked ports are tried from this PC';
  await openTool(USE);
  await pick(USE, 'TL6-dead');
  const prompt = region(USE).getByRole('form', { name: '서버 추가 인증' });
  await expect(prompt).toBeVisible({ timeout: 30000 });
  await prompt.locator('input').fill('not-the-password');
  await prompt.getByRole('button', { name: '인증 응답', exact: true }).click();
  const newKey = region(USE).getByRole('alert', { name: '최초 호스트키 확인' });
  await expect(newKey.or(button(USE, '다시 연결')).first()).toBeVisible({ timeout: 30000 });
  if (await newKey.isVisible())
    await newKey.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  await expect(button(USE, '다시 연결')).toBeVisible({ timeout: 30000 });
  await expect(button(USE, '확인')).toBeDisabled();
  const deadPort = portOf(main, 2230);
  await region(USE).getByLabel('포트(비우면 전체)').fill(String(deadPort));
  await button(USE, '확인').click();
  await expect(region(USE).getByRole('heading', { name: '외부에서 확인한 결과' })).toBeVisible({
    timeout: 20000,
  });
  await expectOutcome(USE, '127.0.0.1', deadPort, '열림');
  await closeTool(USE);
  console.log('PASS with SSH failed the asked port is tried from this PC and labelled so');
  console.log('PASS TL.6 and TL.7 port tools');
} catch (error) {
  console.error(`FAILED at: ${stage}`);
  const failure = process.env.DACHSTERM_FAILURE_SCREENSHOT;
  if (failure) await opened?.page.screenshot({ path: failure }).catch(() => {});
  // Only the assertion and its place: a call log could echo what was typed into a card.
  const lines = error instanceof Error ? (error.stack ?? '').split('\n') : [];
  console.error(lines[0] ?? 'failed');
  console.error(lines.filter((line) => /^\s*(Expected|Received):/.test(line)).join(' '));
  console.error(lines.find((line) => line.includes('test-port-tools-native')) ?? '');
  process.exitCode = 1;
} finally {
  await opened?.stop();
  localListener.close();
  try {
    localUdp.close();
  } catch {
    // Never bound: an earlier stage failed.
  }
  for (const container of containers) tool('docker', ['rm', '-f', container]);
  tool('docker', ['network', 'rm', network]);
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
