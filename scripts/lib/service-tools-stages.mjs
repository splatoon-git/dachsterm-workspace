// Service check and route trace (TL.8, TL.9) in the built app. Runs inside test-port-tools-native,
// which owns the app, the servers and their helpers. Stages use real OpenSSH and real targets only.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';

const SERVICE = '서비스 연결';
const WEB_IMAGE = `FROM nginx:1.27-alpine
RUN apk add --no-cache openssl && mkdir -p /etc/nginx/tls && openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=svc.example -days 30 -addext subjectAltName=DNS:svc.example -keyout /etc/nginx/tls/k.pem -out /etc/nginx/tls/c.pem
RUN printf 'server { listen 8080; location / { return 200; } }\\nserver { listen 8443 ssl; ssl_certificate /etc/nginx/tls/c.pem; ssl_certificate_key /etc/nginx/tls/k.pem; location / { return 200; } }\\n' > /etc/nginx/conf.d/default.conf
`;
// A script, because socat's own address syntax would strip the quotes around a greeting.
const SAY = String.raw`printf '#!/bin/sh\necho 220 mail.example ready\nsleep 2\n' > /say; chmod 755 /say; `;
const SPEAKS = 'socat TCP-LISTEN:8202,reuseaddr,fork EXEC:/say';
const SILENT = `socat TCP-LISTEN:8204,reuseaddr,fork SYSTEM:'sleep 30'`;

/** Servers the session list needs before the app imports it. */
export async function prepareServices(context) {
  const { docker, build, name2, name, network, start, until, tool, networks, portOf, sshdUp } =
    context;
  const { profile, alpine, alpinePassword, ALPINE_BASE, NO_TOOLS } = context;
  build(name2('web'), WEB_IMAGE);
  build(
    name2('tracer'),
    'FROM alpine:3.22\nRUN apk add --no-cache openssh-server traceroute iputils-tracepath iproute2\n',
  );
  const farNetwork = `${network}-far`;
  docker(['network', 'create', farNetwork]);
  networks.push(farNetwork);
  const ipOn = (container, on) =>
    docker([
      'inspect',
      '-f',
      `{{(index .NetworkSettings.Networks "${on}").IPAddress}}`,
      container,
    ]).trim();
  const subnetOf = (on) =>
    docker(['network', 'inspect', '-f', '{{(index .IPAM.Config 0).Subnet}}', on]).trim();

  const web = start('web', name2('web'), ['-p', '127.0.0.1::8080', '-p', '127.0.0.1::8443']);
  await until(() => tool('docker', ['exec', web, 'pgrep', 'nginx']).status === 0, 'the web server');
  const svc = start(
    'svc',
    name2('target'),
    ['--cap-add', 'NET_ADMIN', '-p', '127.0.0.1::8202', '-p', '127.0.0.1::8204'],
    ['sh', '-c', `${SAY}${SILENT} & exec ${SPEAKS}`],
  );
  await until(sshdUp(svc, 8202), 'the banner service');
  await until(sshdUp(svc, 8204), 'the silent service');
  docker(['exec', svc, 'iptables', '-A', 'INPUT', '-p', 'tcp', '--dport', '8205', '-j', 'DROP']);

  // Two networks and a router between them, so a route has a hop before its target.
  const router = start(
    'router',
    name2('target'),
    ['--cap-add', 'NET_ADMIN', '--sysctl', 'net.ipv4.ip_forward=1'],
    ['sleep', '100000'],
  );
  docker(['network', 'connect', farNetwork, router]);
  const routerNear = ipOn(router, network);
  const routerFar = ipOn(router, farNetwork);
  const nearSubnet = subnetOf(network);
  const far = start(
    'far',
    name2('target'),
    ['--cap-add', 'NET_ADMIN'],
    ['sh', '-c', `ip route add ${nearSubnet} via ${routerFar}; ${SAY}exec ${SPEAKS}`],
    farNetwork,
  );
  await until(sshdUp(far, 8202), 'the far target');
  const tracer = start(
    'tracer',
    name2('tracer'),
    ['--cap-add', 'NET_ADMIN', '-e', `PW=${alpinePassword}`, '-p', '127.0.0.1::22'],
    [
      'sh',
      '-c',
      `${ALPINE_BASE}echo "root:$PW" | chpasswd\nip route add ${subnetOf(farNetwork)} via ${routerNear}\nexec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes -o PermitRootLogin=yes -o AllowTcpForwarding=yes`,
    ],
  );
  await until(sshdUp(tracer, 22), 'the tracing server');
  const notrace = alpine('notrace', `${NO_TOOLS}rm -f /usr/bin/traceroute\n`);
  await until(sshdUp(notrace, 22), 'the server with no tracing tool');

  return {
    web,
    svc,
    far,
    routerNear,
    farIp: ipOn(far, farNetwork),
    webIp: ipOn(web, network),
    svcIp: ipOn(svc, network),
    svcName: name('svc'),
    sessions: [
      profile('TL8-root', portOf(tracer, 22), { username: 'root' }),
      profile('TL8-user', portOf(tracer, 22)),
      profile('TL8-notrace', portOf(notrace, 22)),
    ],
  };
}

export async function serviceStages(context, servers) {
  const { region, button, pageOf, openTool, closeTool, login, answerLogin, setStage } = context;
  const { docker, portOf, freePort, submit, rowOf, password, alpinePassword, OPEN, main } = context;
  const pane = () => region(SERVICE);
  const line = () => pane().locator('.service-result summary');
  const steps = () => pane().locator('.service-result .service-steps');
  const trace = () => pane().locator('.service-result .service-trace');
  const hops = () => trace().locator('tbody tr');
  const conclusion = () => trace().getByRole('status');

  async function check(target, format = 'auto') {
    await pane().getByLabel('대상', { exact: true }).fill(target);
    await pane().locator('.tool-format select').selectOption(format);
    await button(SERVICE, '점검').click();
  }
  /** The target is part of the wait, or the result of the check before could satisfy it. */
  const expectLine = (route, text) =>
    expect(line())
      .toContainText(route, { timeout: 40000 })
      .then(() => expect(line()).toContainText(text));
  async function runTrace() {
    await line().click();
    await trace().getByRole('button', { name: '실행', exact: true }).click();
  }
  const established = (port) =>
    Number(
      docker([
        'exec',
        main,
        'sh',
        '-c',
        `ss -Htn state established '( dport = :${port} )' | wc -l`,
      ]).trim(),
    );

  const httpPort = portOf(servers.web, 8080);
  const httpsPort = portOf(servers.web, 8443);
  const bannerPort = portOf(servers.svc, 8202);
  const silentPort = portOf(servers.svc, 8204);

  async function traceFrom(session, secret, expected) {
    await openTool(SERVICE);
    await login(SERVICE, session, secret);
    await check(`${servers.farIp}:8202`);
    await expectLine(`${servers.farIp}:8202`, '배너');
    await runTrace();
    await expected();
    await closeTool(SERVICE);
  }

  const stages = [
    [
      'service: local',
      async () => {
        await openTool(SERVICE);
        await check(`127.0.0.1:${httpPort}`);
        await expectLine(`이 PC → 127.0.0.1:${httpPort}`, '연결됨 · HTTP 200');
        await expect(steps()).toContainText('HTTP/1.1 200 OK · Server: nginx');
        console.log('PASS local HTTP is found by automatic and answers with its status');

        await check(`127.0.0.1:${httpsPort}`);
        await expectLine(`127.0.0.1:${httpsPort}`, '연결됨 · HTTPS 200');
        await expect(steps()).toContainText('자체 서명(신뢰 안 됨)');
        await expect(steps()).toContainText('svc.example');
        await expect(steps()).toContainText('TLS');
        console.log('PASS local HTTPS reads a self-signed certificate and says it is not trusted');

        await check(`https://127.0.0.1:${httpsPort}/health`);
        await expectLine(`127.0.0.1:${httpsPort}`, 'HTTPS 200');
        await check(`127.0.0.1:${httpsPort}`, 'tls');
        await expectLine(`127.0.0.1:${httpsPort}`, '연결됨 · TLS');
        await check(`127.0.0.1:${httpPort}`, 'tls');
        await expectLine(`127.0.0.1:${httpPort}`, '서비스 확인 안 됨');
        await expect(steps()).toContainText(/서버가 (TLS로 답하지|연결을 닫)/);
        console.log('PASS a URL, the TLS format and TLS against a plain port are each reported');
        await closeTool(SERVICE);
      },
    ],
    [
      'service: local banner and silence',
      async () => {
        await openTool(SERVICE);
        await check(`127.0.0.1:${bannerPort}`);
        await expectLine(`127.0.0.1:${bannerPort}`, '연결됨 · 배너');
        await expect(steps()).toContainText('220 mail.example ready');
        console.log('PASS a server that speaks first is shown by its banner');

        await check(`127.0.0.1:${silentPort}`, 'banner');
        await expectLine(`127.0.0.1:${silentPort}`, '서비스 확인 안 됨');
        await expect(steps()).toContainText('장비나 프록시');
        const closed = await freePort();
        await check(`127.0.0.1:${closed}`);
        await expectLine(`127.0.0.1:${closed}`, '닫힘');
        await check('192.0.2.1:80');
        await expectLine('192.0.2.1:80', '응답 없음');
        console.log('PASS silence after connecting, a closed port and no response are told apart');

        await closeTool(SERVICE);
      },
    ],
    [
      'service: local public HTTPS',
      async () => {
        await openTool(SERVICE);
        await check('https://www.google.com');
        await expectLine('www.google.com:443', 'HTTPS');
        await expect(steps()).toContainText('신뢰 OK');
        await expect(steps()).toContainText('이름 해석');
        console.log('PASS a public HTTPS site verifies against the system store');
        await closeTool(SERVICE);
      },
    ],
    [
      'service: cancel',
      async () => {
        await openTool(SERVICE);
        await check(`127.0.0.1:${silentPort}`, 'banner');
        await button(SERVICE, '취소').click();
        await expect(pane().locator('.tool-pending').filter({ hasText: '취소됨' })).toBeVisible();
        await closeTool(SERVICE);
        console.log('PASS a running check can be cancelled');
      },
    ],
    [
      'service: remote',
      async () => {
        await openTool(SERVICE);
        await login(SERVICE, 'TL6-main', password);
        await check(`${servers.webIp}:8080`);
        await expectLine(`TL6-main → ${servers.webIp}:8080`, '연결됨 · HTTP 200');
        await check(`${servers.webIp}:8443`);
        await expectLine(`${servers.webIp}:8443`, '연결됨 · HTTPS 200');
        await expect(steps()).toContainText('자체 서명(신뢰 안 됨)');
        await check(`${servers.svcIp}:8202`);
        await expectLine(`${servers.svcIp}:8202`, '연결됨 · 배너');
        await expect(steps()).toContainText('220 mail.example ready');
        await check(`${servers.svcIp}:8204`, 'banner');
        await expectLine(`${servers.svcIp}:8204`, '서비스 확인 안 됨');
        await expect.poll(() => established(8204), { timeout: 15000 }).toBe(0);
        await check(`${servers.svcIp}:8206`);
        await expectLine(`${servers.svcIp}:8206`, '닫힘');
        await check(`${servers.svcIp}:8205`);
        await expectLine(`${servers.svcIp}:8205`, '응답 없음');
        await check(`${servers.svcName}:8202`);
        await expectLine(`${servers.svcName}:8202`, '배너');
        await expect(steps()).toContainText('서버에서 해석(시간 측정 불가)');
        await expect(steps()).toContainText(servers.svcIp);
        await closeTool(SERVICE);
      },
    ],
    [
      'service: remote public HTTPS',
      async () => {
        await openTool(SERVICE);
        await login(SERVICE, 'TL6-main', password);
        await check('https://www.google.com');
        await expectLine('www.google.com:443', 'HTTPS');
        await expect(steps()).toContainText('신뢰 OK');
        await closeTool(SERVICE);
        console.log(
          'PASS remote gives the same answers over an SSH channel and leaves nothing open',
        );
      },
    ],
    [
      'service: remote forwarding forbidden',
      async () => {
        await openTool(SERVICE);
        await login(SERVICE, 'TL6-noforward', password);
        await check(`${servers.svcIp}:8202`);
        await expectLine(`${servers.svcIp}:8202`, '확인 불가 · 서버가 이 연결을 금지했습니다.');
        await closeTool(SERVICE);
        console.log('PASS forbidden forwarding is reported, not shown as a closed service');
      },
    ],
    [
      'port check row to service check',
      async () => {
        await openTool(OPEN);
        await submit(OPEN, '127.0.0.1', String(httpPort));
        await expect(rowOf(OPEN, '127.0.0.1', httpPort).locator('.tool-outcome')).toHaveText(
          '열림',
          {
            timeout: 30000,
          },
        );
        await rowOf(OPEN, '127.0.0.1', httpPort).click({ button: 'right' });
        await pageOf().getByRole('menuitem', { name: '서비스 연결로 보기' }).click();
        await expectLine(`이 PC → 127.0.0.1:${httpPort}`, 'HTTP 200');
        await closeTool(SERVICE);
        await closeTool(OPEN);
        await openTool(OPEN);
        await login(OPEN, 'TL8-root', alpinePassword);
        await submit(OPEN, servers.svcIp, '8202');
        await expect(rowOf(OPEN, servers.svcIp, 8202).locator('.tool-outcome')).toHaveText('열림', {
          timeout: 30000,
        });
        await rowOf(OPEN, servers.svcIp, 8202).click({ button: 'right' });
        await pageOf().getByRole('menuitem', { name: '서비스 연결로 보기' }).click();
        await answerLogin(SERVICE, alpinePassword);
        await expectLine(`TL8-root → ${servers.svcIp}:8202`, '배너');
        await closeTool(SERVICE);
        await closeTool(OPEN);
        console.log('PASS a port check row opens the service check with its target and its source');
      },
    ],
    [
      'trace: from this PC',
      async () => {
        await openTool(SERVICE);
        await check(`127.0.0.1:${httpPort}`);
        await expectLine(`127.0.0.1:${httpPort}`, 'HTTP 200');
        await runTrace();
        await expect(conclusion()).toHaveText('대상까지 도달했습니다.', { timeout: 15000 });
        await expect(trace()).toContainText('참고용 ICMP');
        await expect(trace()).toContainText('무관');
        await expect(hops()).toHaveCount(1);
        console.log('PASS the loopback is one hop by ICMP, labelled as reference only');
        await closeTool(SERVICE);
      },
    ],
    [
      'trace: a real route',
      async () => {
        await openTool(SERVICE);
        await check('1.1.1.1:443');
        await expectLine('1.1.1.1:443', '연결됨');
        await runTrace();
        await expect(conclusion()).toContainText(/대상까지 도달|마지막 응답 장비는/, {
          timeout: 90000,
        });
        assert.ok((await hops().count()) > 1, 'a real route has more than one hop');
        console.log(`PASS a real route shows its hops (${await hops().count()})`);
        await closeTool(SERVICE);
      },
    ],
    [
      'trace: cancel',
      async () => {
        await openTool(SERVICE);
        await check('192.0.2.1:80');
        await expectLine('192.0.2.1:80', '응답 없음');
        await runTrace();
        await expect(hops().first()).toBeVisible({ timeout: 20000 });
        await trace().getByRole('button', { name: '취소', exact: true }).click();
        await expect(trace().locator('.tool-pending').filter({ hasText: '취소됨' })).toBeVisible({
          timeout: 5000,
        });
        await expect(conclusion()).toHaveCount(0);
        await closeTool(SERVICE);
        console.log('PASS a running trace can be cancelled and then concludes nothing');
      },
    ],
    [
      'trace: root sends TCP to the port',
      async () => {
        await traceFrom('TL8-root', alpinePassword, async () => {
          await expect(conclusion()).toHaveText('대상까지 도달했습니다.', { timeout: 90000 });
          await expect(trace()).toContainText('점검한 포트로 보낸 TCP');
          await expect(hops().first()).toContainText(servers.routerNear);
          await expect(hops().last()).toContainText(servers.farIp);
          await expect(hops().last()).toContainText('대상');
        });
        console.log(
          'PASS root traces by TCP to the checked port, through the router to the target',
        );
      },
    ],
    [
      'trace: an ordinary account',
      async () => {
        await traceFrom('TL8-user', alpinePassword, async () => {
          await expect(conclusion()).toHaveText('대상까지 도달했습니다.', { timeout: 90000 });
          await expect(trace()).toContainText('참고용 UDP');
          await expect(trace()).toContainText('무관');
          await expect(hops().first()).toContainText(servers.routerNear);
        });
        console.log('PASS an ordinary account traces by UDP and says it is only for reference');
      },
    ],
    [
      'trace: replies stop partway',
      async () => {
        await openTool(SERVICE);
        await login(SERVICE, 'TL8-root', alpinePassword);
        await check(`${servers.farIp}:8202`);
        await expectLine(`${servers.farIp}:8202`, '배너');
        docker(['exec', servers.far, 'iptables', '-I', 'INPUT', '-j', 'DROP']);
        await runTrace();
        await expect(conclusion()).toHaveText(
          `마지막 응답 장비는 ${servers.routerNear}, 그 다음 구간에서 끊김`,
          { timeout: 120000 },
        );
        const lastHop = await hops().last().textContent();
        assert.ok(lastHop.includes('응답 없음'), 'the hops after the router are silent');
        await closeTool(SERVICE);
        console.log(
          'PASS when replies stop the conclusion names only the last device that replied',
        );
      },
    ],
    [
      'trace: no tool',
      async () => {
        for (const session of ['TL8-notrace', 'TL6-bare']) {
          await openTool(SERVICE);
          await login(SERVICE, session, alpinePassword);
          await check(`${servers.svcIp}:8202`);
          await expectLine(`${servers.svcIp}:8202`, '확인 불가');
          await runTrace();
          await expect(conclusion()).toHaveText('이 서버에서는 경로 추적을 할 수 없습니다', {
            timeout: 30000,
          });
          await expect(hops()).toHaveCount(0);
          await closeTool(SERVICE);
        }
        console.log(
          'PASS a server with no tool, or a BusyBox one it cannot run, says tracing is not possible',
        );
      },
    ],
  ];
  // `--from=<stage>` starts at a stage, so one that failed can be rerun without the ones before it.
  const from = process.argv.find((item) => item.startsWith('--from='))?.slice('--from='.length);
  const start = from ? stages.findIndex(([name]) => name === from) : 0;
  assert.ok(start >= 0, `no stage named ${from}`);
  for (const [name, run] of stages.slice(start)) {
    setStage(name);
    await run();
  }
  console.log('PASS TL.8 and TL.9 service check and route trace');
}
