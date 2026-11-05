import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
const name = `daxterm-probe-${randomUUID()}`;
const env = {
  ...process.env,
  PATH: `${path.join(homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`,
};
function capture(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Docker operation failed: ${args[0]}`);
  return result.stdout.trim();
}
async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env, ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
let created = false;
try {
  await run('cargo', ['build', '--locked', '-p', 'daxterm-ssh-probe']);
  await run('docker', ['build', '-t', 'daxterm-openssh-probe', 'tests/openssh']);
  capture([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--label',
    'app.daxterm.purpose=phase0-probe',
    '-p',
    '127.0.0.1::22',
    '--tmpfs',
    '/run/probe:rw,noexec,nosuid,mode=0700',
    'daxterm-openssh-probe',
  ]);
  created = true;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const result = spawnSync('docker', ['exec', name, 'test', '-f', '/run/probe/ready'], {
      stdio: 'ignore',
    });
    if (result.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('OpenSSH fixture startup timeout');
  env.DAXTERM_PROBE_PORT = capture(['port', name, '22/tcp']).split(':').at(-1);
  for (const [key, file] of [
    ['PASSWORD', 'password'],
    ['PASSPHRASE', 'passphrase'],
    ['PLAIN_KEY', 'plain'],
    ['ENCRYPTED_KEY', 'encrypted'],
    ['HOST_KEY', 'host.pub'],
    ['RSA_HOST_KEY', 'host_rsa.pub'],
  ])
    env[`DAXTERM_PROBE_${key}`] = capture(['exec', name, 'cat', `/run/probe/${file}`]);
  // Secrets exist only in the ephemeral fixture and this process/child environment; never print them.
  await run(
    path.resolve(
      'target',
      'debug',
      `daxterm-ssh-probe${process.platform === 'win32' ? '.exe' : ''}`,
    ),
    [],
    { timeout: 180_000 },
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (created) {
    capture(['rm', '-f', name]);
    console.log('PASS fixture removed (keys, credentials and remote files destroyed)');
  }
  for (const key of Object.keys(env)) if (key.startsWith('DAXTERM_PROBE_')) delete env[key];
}
