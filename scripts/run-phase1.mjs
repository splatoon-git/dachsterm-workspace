import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
if (process.argv.includes('--edit-only')) env.DACHSTERM_EDIT_ONLY = '1';
if (process.argv.includes('--credentials-only')) env.DACHSTERM_PROBE_CREDENTIALS_ONLY = '1';
// `--git-versions-only`: the version servers alone, after the Debian checks have passed.
if (process.argv.includes('--git-versions-only')) {
  env.DACHSTERM_PROBE_CREDENTIALS_ONLY = '1';
  env.DACHSTERM_PROBE_VERSIONS_ONLY = '1';
}
// HTTPS Git credentials (DX.12): servers with older and newer git and tmux, built from
// tests/git-servers. Off by default because it builds and starts four more images.
const gitVersions = process.argv.some((a) => a.startsWith('--git-versions'))
  ? ['centos:7', 'ubuntu:18.04', 'ubuntu:20.04', 'alpine:edge']
  : [];
const network = `dachsterm-probe-net-${randomUUID()}`;
const gitServer = `dachsterm-git-https-${randomUUID()}`;
const gitContainers = [];
let gitHome;
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
let networkCreated = false;
async function waitFor(check, what) {
  for (let i = 0; i < 120; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} startup timeout`);
}
const succeeds = (args) => spawnSync('docker', args, { stdio: 'ignore' }).status === 0;
let agentBridge;
let agentSocketPath;
let agentPause;
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
  // The HTTPS Git server answers as git.test on a network only the probe's containers join.
  capture(['network', 'create', '--label', 'app.dachsterm.purpose=phase1-probe', network]);
  networkCreated = true;
  await run('docker', ['build', '-q', '-t', 'dachsterm-git-https', 'tests/git-https']);
  capture([
    'run',
    '-d',
    '--rm',
    '--name',
    gitServer,
    '--label',
    'app.dachsterm.purpose=phase1-probe',
    '--network',
    network,
    '--network-alias',
    'git.test',
    'dachsterm-git-https',
  ]);
  gitContainers.push(gitServer);
  capture(['network', 'connect', network, name]);
  const reachesGit = "import socket; socket.create_connection(('git.test', 3000), 2).close()";
  await waitFor(
    () =>
      succeeds(['exec', gitServer, 'test', '-s', '/var/lib/gitea/probe/password']) &&
      succeeds(['exec', name, 'python3', '-c', reachesGit]),
    'HTTPS Git server',
  );
  env.DACHSTERM_PROBE_GIT_PASSWORD = capture([
    'exec',
    gitServer,
    'cat',
    '/var/lib/gitea/probe/password',
  ]);
  const servers = [];
  for (const base of gitVersions) {
    const label = base.replace(/[:.]/g, '-');
    const image = `dachsterm-git-server:${label}`;
    await run('docker', [
      'build',
      '-q',
      '--build-arg',
      `BASE=${base}`,
      '-t',
      image,
      'tests/git-servers',
    ]);
    const server = `dachsterm-git-server-${label}-${randomUUID()}`;
    capture([
      'run',
      '-d',
      '--rm',
      '--name',
      server,
      '--label',
      'app.dachsterm.purpose=phase1-probe',
      '--network',
      network,
      '-p',
      '127.0.0.1::22',
      image,
    ]);
    gitContainers.push(server);
    await waitFor(() => succeeds(['exec', server, 'test', '-f', '/run/probe/ready']), label);
    const port = capture(['port', server, '22/tcp']).split(':').at(-1);
    const password = capture(['exec', server, 'cat', '/run/probe/password']);
    servers.push(`${label}:${port}:${password}`);
  }
  if (servers.length) env.DACHSTERM_PROBE_GIT_SERVERS = servers.join(',');
  // This PC's git, as the app runs it, reads only this folder: no system or user settings,
  // and a `store` helper the checks fill and empty. The real credential manager is never asked.
  gitHome = mkdtempSync(path.join(tmpdir(), 'dachsterm-git-home-'));
  const gitStore = path.join(gitHome, 'store');
  writeFileSync(gitStore, '');
  writeFileSync(
    path.join(gitHome, 'gitconfig'),
    `[credential]\n\thelper = "store --file '${gitStore.replaceAll('\\', '/')}'"\n`,
  );
  env.DACHSTERM_PROBE_GIT_STORE = gitStore;
  const isolatedGit = {
    // macOS finds the login Keychain through HOME, and the probe's OS credential checks use it.
    // GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM below still keep git off the user's settings.
    ...(process.platform === 'darwin' ? {} : { HOME: gitHome }),
    XDG_CONFIG_HOME: gitHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(gitHome, 'gitconfig'),
  };
  env.DACHSTERM_PROBE_PORT = capture(['port', name, '22/tcp']).split(':').at(-1);
  env.DACHSTERM_PROBE_MFA_PORT = capture(['port', name, '2223/tcp']).split(':').at(-1);
  // The fixture's agent stands in for this PC's agent, so no real key is offered or forwarded.
  {
    let listenAt;
    if (process.platform === 'win32') {
      env.DACHSTERM_TEST_AGENT_PIPE = `\\\\.\\pipe\\dachsterm-agent-${randomUUID()}`;
      listenAt = env.DACHSTERM_TEST_AGENT_PIPE;
    } else {
      // /tmp keeps the path under the 104-byte socket limit on macOS.
      agentSocketPath = `/tmp/dachsterm-agent-${randomUUID()}.sock`;
      env.SSH_AUTH_SOCK = agentSocketPath;
      listenAt = agentSocketPath;
    }
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
      agentBridge.listen(listenAt, resolve);
    });
    // A native check switches this stand-in off and on, as a stopped and restarted ssh-agent
    // service, by creating and removing this file.
    env.DACHSTERM_AGENT_PAUSE = path.join(tmpdir(), `dachsterm-agent-pause-${randomUUID()}`);
    let listening = true;
    agentPause = setInterval(() => {
      const paused = existsSync(env.DACHSTERM_AGENT_PAUSE);
      if (paused && listening) {
        listening = false;
        agentBridge.close();
        for (const socket of agentSockets) socket.destroy();
      } else if (!paused && !listening) {
        listening = true;
        if (agentSocketPath) rmSync(agentSocketPath, { force: true });
        agentBridge.listen(listenAt);
      }
    }, 200);
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
      {
        env: { ...env, ...isolatedGit },
        timeout: (900 + stressMinutes * 60 + gitVersions.length * 120) * 1000,
      },
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
      { env: { ...env, ...isolatedGit }, timeout: 420_000 },
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(agentPause);
  if (env.DACHSTERM_AGENT_PAUSE) rmSync(env.DACHSTERM_AGENT_PAUSE, { force: true });
  for (const socket of agentSockets) socket.destroy();
  agentBridge?.close();
  if (agentSocketPath) rmSync(agentSocketPath, { force: true });
  for (const container of gitContainers)
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  if (created) {
    capture(['rm', '-f', name]);
    console.log('PASS fixture removed (keys, credentials and remote files destroyed)');
  }
  if (networkCreated) spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  if (gitHome) rmSync(gitHome, { recursive: true, force: true });
  for (const key of Object.keys(env)) if (key.startsWith('DACHSTERM_PROBE_')) delete env[key];
}
