// Runs the product engine's connection-path checks (examples/connect_probe.rs) against the
// connect fixture. Start the fixture first: `npm run connect:fixture -- up`. It is left running,
// because other checks share it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const secrets = path.join(tmpdir(), 'dachsterm-connect-fixture');
if (!existsSync(path.join(secrets, 'proxy.password'))) {
  console.error('The connect fixture is not up. Run: npm run connect:fixture -- up');
  process.exit(2);
}
const env = {
  ...process.env,
  PATH: `${path.join(homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`,
  DACHSTERM_CONNECT_FIXTURE: secrets,
};
const result = spawnSync(
  'cargo',
  ['run', '--locked', '-p', 'dachsterm', '--example', 'connect_probe'],
  { stdio: 'inherit', env },
);
process.exit(result.status ?? 1);
