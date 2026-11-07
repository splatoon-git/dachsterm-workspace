import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
const name = `dachsterm-probe-${randomUUID()}`;
const native = process.argv.includes('--native');
const reuseBuild = process.argv.includes('--reuse-build');
const targetRoot = path.resolve(process.env.CARGO_TARGET_DIR ?? 'target');
const stressIndex = process.argv.indexOf('--stress-minutes');
const stressMinutes = stressIndex < 0 ? 0 : Number(process.argv[stressIndex + 1]);
if (!Number.isInteger(stressMinutes) || stressMinutes < 0 || stressMinutes > 1440)
  throw new Error('stress-minutes must be an integer from 0 to 1440');
const env = {
  ...process.env,
  PATH: `${path.join(homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`,
  DACHSTERM_PROBE_STRESS_SECONDS: String(stressMinutes * 60),
  DACHSTERM_TEST_BINARY:
    process.env.DACHSTERM_TEST_BINARY ?? path.join(targetRoot, 'debug', 'dachsterm.exe'),
};
if (process.argv.includes('--jumps')) env.DACHSTERM_PROBE_JUMPS = '1';
if (process.argv.includes('--agent-only')) env.DACHSTERM_AGENT_ONLY = '1';
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
let agentBridge;
const agentSockets = new Set();
try {
  if (native && !reuseBuild && !process.argv.includes('--skip-app-build'))
    await run(process.execPath, [
      'node_modules/@tauri-apps/cli/tauri.js',
      'build',
      '--debug',
      '--no-bundle',
    ]);
  if (!reuseBuild)
    await run('cargo', ['build', '--locked', '-p', 'dachsterm', '--example', 'phase1_probe']);
  await run('docker', ['build', '-t', 'dachsterm-openssh-probe', 'tests/openssh']);
  capture([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--label',
    'app.dachsterm.purpose=phase1-probe',
    '-p',
    '127.0.0.1::22',
    '-p',
    '127.0.0.1::2222',
    '-p',
    '127.0.0.1::2223',
    '--tmpfs',
    '/run/probe:rw,noexec,nosuid,mode=0700',
    'dachsterm-openssh-probe',
  ]);
  created = true;
  if (process.argv.includes('--jumps')) env.DACHSTERM_PROBE_CONTAINER = name;
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
  env.DACHSTERM_PROBE_PORT = capture(['port', name, '22/tcp']).split(':').at(-1);
  env.DACHSTERM_PROBE_MFA_PORT = capture(['port', name, '2223/tcp']).split(':').at(-1);
  if (process.platform === 'win32') {
    env.DACHSTERM_TEST_AGENT_PIPE = `\\\\.\\pipe\\dachsterm-agent-${randomUUID()}`;
    const agentPort = Number(capture(['port', name, '2222/tcp']).split(':').at(-1));
    agentBridge = net.createServer((client) => {
      const remote = net.connect(agentPort, '127.0.0.1');
      for (const socket of [client, remote]) {
        agentSockets.add(socket);
        socket.on('close', () => agentSockets.delete(socket));
      }
      client.on('error', () => remote.destroy());
      remote.on('error', () => client.destroy());
      client.on('close', () => remote.destroy());
      remote.on('close', () => client.destroy());
      client.pipe(remote).pipe(client);
    });
    await new Promise((resolve, reject) => {
      agentBridge.once('error', reject);
      agentBridge.listen(env.DACHSTERM_TEST_AGENT_PIPE, resolve);
    });
  }
  for (const [key, file] of [
    ['PASSWORD', 'password'],
    ['PASSPHRASE', 'passphrase'],
    ['PLAIN_KEY', 'plain'],
    ['RSA_KEY', 'rsa'],
    ['RSA_ENCRYPTED_KEY', 'rsa_encrypted'],
    ['RSA_PEM_KEY', 'rsa_pem'],
    ['RSA_PKCS8_KEY', 'rsa_pkcs8'],
    ['ENCRYPTED_KEY', 'encrypted'],
    ['HOST_KEY', 'host.pub'],
    ['RSA_HOST_KEY', 'host_rsa.pub'],
  ])
    env[`DACHSTERM_PROBE_${key}`] = capture(['exec', name, 'cat', `/run/probe/${file}`]);
  // Secrets exist only in the ephemeral fixture and this process/child environment; never print them.
  if (!reuseBuild)
    await run(
      path.resolve(
        targetRoot,
        'debug',
        'examples',
        `phase1_probe${process.platform === 'win32' ? '.exe' : ''}`,
      ),
      [],
      { timeout: (360 + stressMinutes * 60) * 1000 },
    );
  if (native) {
    env.DACHSTERM_PROBE_CONTAINER = name;
    await run(
      process.execPath,
      [
        process.argv.includes('--jumps')
          ? 'scripts/test-jump-native.mjs'
          : process.argv.includes('--session-transfer')
            ? 'scripts/test-session-transfer-native.mjs'
            : 'scripts/test-native.mjs',
      ],
      { timeout: 420_000 },
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const socket of agentSockets) socket.destroy();
  agentBridge?.close();
  if (created) {
    capture(['rm', '-f', name]);
    console.log('PASS fixture removed (keys, credentials and remote files destroyed)');
  }
  for (const key of Object.keys(env)) if (key.startsWith('DACHSTERM_PROBE_')) delete env[key];
}
