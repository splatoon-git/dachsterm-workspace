// Connect fixture for CG.1~CG.9 (tests/connect-fixture): proxies, jump and target SSH servers,
// Telnet, an external X server and a serial-console stand-in, all on 127.0.0.1.
//
//   npm run connect:fixture -- up       build, start and copy the throwaway secrets out
//   npm run connect:fixture -- status   ports and the secrets folder (never the secrets)
//   npm run connect:fixture -- serial   keep a virtual serial port open with socat (macOS)
//   npm run connect:fixture -- down     stop and delete the containers, volume and secrets copy
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const compose = ['compose', '-f', 'tests/connect-fixture/compose.yaml'];
const secrets = join(tmpdir(), 'dachsterm-connect-fixture');
const serialLink = join(secrets, 'tty.dachs-serial');

function docker(args, options = {}) {
  const result = spawnSync('docker', [...compose, ...args], { stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function copySecrets() {
  rmSync(secrets, { recursive: true, force: true });
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  docker(['cp', 'init:/run/fixture/.', secrets]);
  for (const name of readdirSync(secrets)) {
    chmodSync(join(secrets, name), name.endsWith('.pub') ? 0o644 : 0o600);
  }
}

function status() {
  console.log(`HTTP_PROXY=127.0.0.1:43128 (user probe, password file proxy.password)
SOCKS5_PROXY=127.0.0.1:41080 (user probe, password file proxy.password)
TARGET=target:22 (only through a proxy or the jump host; user probe, password file user.password)
JUMP=127.0.0.1:42222 (user probe; key plain, or password file user.password)
CERT_KEYS=cert_ed25519, cert_rsa (valid), cert_expired, cert_other (wrong principal)
TELNET=127.0.0.1:42323 (user probe, password file user.password)
X_DISPLAY=127.0.0.1:40000 (cookie file x11.cookie)
SERIAL_TCP=127.0.0.1:47000 (serial: ${serialLink})
SECRETS=${secrets}`);
}

function serial() {
  if (process.platform !== 'darwin') {
    console.error('A virtual serial port needs socat with PTYs (macOS). On Windows use com0com.');
    process.exit(2);
  }
  if (!existsSync(secrets)) mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const child = spawn(
    'socat',
    ['-d', '-d', `pty,raw,echo=0,link=${serialLink}`, 'tcp:127.0.0.1:47000'],
    { stdio: 'inherit' },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
}

const action = process.argv[2] ?? 'status';
if (action === 'up') {
  docker(['up', '-d', '--build', '--wait', 'target', 'jump', 'edge']);
  copySecrets();
  status();
} else if (action === 'down') {
  docker(['down', '-v']);
  rmSync(secrets, { recursive: true, force: true });
} else if (action === 'status') {
  docker(['ps']);
  status();
} else if (action === 'serial') {
  serial();
} else {
  console.error('usage: connect-fixture.mjs up|status|serial|down');
  process.exit(2);
}
