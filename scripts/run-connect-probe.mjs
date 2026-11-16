// Runs the product engine's connection-path checks (examples/connect_probe.rs) against the
// connect fixture. Start the fixture first: `npm run connect:fixture -- up`. It is left running,
// because other checks share it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const secrets = path.join(tmpdir(), 'dachsterm-connect-fixture');
if (!existsSync(path.join(secrets, 'proxy.password'))) {
  console.error('The connect fixture is not up. Run: npm run connect:fixture -- up');
  process.exit(2);
}
// The fixture X server's cookie in an Xauthority file of its own, for the X11 check (CG.9). The
// app reads `XAUTHORITY`; this PC's own file is left alone.
const xauth = mkdtempSync(path.join(tmpdir(), 'dachsterm-xauth-'));
const field = (bytes) =>
  Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 255]), bytes]);
const cookie = Buffer.from(readFileSync(path.join(secrets, 'x11.cookie'), 'utf8').trim(), 'hex');
writeFileSync(
  path.join(xauth, 'Xauthority'),
  Buffer.concat([
    Buffer.from([0, 0]),
    field(Buffer.from([127, 0, 0, 1])),
    field(Buffer.from('40000')),
    field(Buffer.from('MIT-MAGIC-COOKIE-1')),
    field(cookie),
  ]),
  { mode: 0o600 },
);
const env = {
  ...process.env,
  PATH: `${path.join(homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`,
  DACHSTERM_CONNECT_FIXTURE: secrets,
  XAUTHORITY: path.join(xauth, 'Xauthority'),
};
const result = spawnSync(
  'cargo',
  ['run', '--locked', '-p', 'dachsterm', '--example', 'connect_probe'],
  { stdio: 'inherit', env },
);
rmSync(xauth, { recursive: true, force: true });
process.exit(result.status ?? 1);
