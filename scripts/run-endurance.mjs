// Endurance checks (roadmap 5.1) of the product engine against an ephemeral OpenSSH container.
// The probe asks for faults with `ACTION <id> <kind> <seconds>` lines; this runner performs them:
//   suspend       stop the probe process (a stand-in for the PC sleeping), then continue it
//   suspend-drop  the same, and kill the server side of every session while it is stopped
//   freeze        stop every server process of the probe user, so nothing answers, then
//                 continue them (an SSH-level black hole: the kernel still takes the packets)
//   link          take the server container off its network, then put it back
//   kill          SIGKILL the probe; the next process recovers from the same data folder
// Usage: node scripts/run-endurance.mjs [--scenarios a,b] [--minutes N] [--cycles N]
//        [--output-mib N] [--transfer-mib N] [--fault-mib N] [--reuse-build] [--rebuild-image]
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

if (process.platform === 'win32') {
  // SIGSTOP and SIGCONT do not exist on Windows. The suspend faults need another way there.
  console.error('run-endurance supports macOS; the suspend faults need SIGSTOP');
  process.exit(1);
}
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const all = [
  'output',
  'transfer',
  'cycles',
  'blip',
  'suspend',
  'suspend-drop',
  'stall',
  'blackhole',
  'link',
  'quit-graceful',
  'quit-kill',
  'long',
];
const scenarios = arg('scenarios', all.join(',')).split(',');
for (const s of scenarios) if (!all.includes(s)) throw new Error(`unknown scenario ${s}`);
const targetRoot = path.resolve(process.env.CARGO_TARGET_DIR ?? 'target');
// DACHSTERM_ENDURANCE_BINARY runs another build of the probe, such as one without a fix.
const binary =
  process.env.DACHSTERM_ENDURANCE_BINARY ??
  path.join(targetRoot, 'release', 'examples', 'endurance_probe');
let name = '';
const work = mkdtempSync(path.join(tmpdir(), 'dachsterm-endurance-'));
const signals = path.join(work, 'signals');
mkdirSync(signals);
const reportDir = path.resolve('target', 'verification');
mkdirSync(reportDir, { recursive: true });
const env = {
  ...process.env,
  PATH: `${path.join(homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`,
  DACHSTERM_ENDURANCE_SIGNALS: signals,
  DACHSTERM_ENDURANCE_MINUTES: arg('minutes', '60'),
  DACHSTERM_ENDURANCE_CYCLES: arg('cycles', '300'),
  DACHSTERM_ENDURANCE_OUTPUT_MIB: arg('output-mib', '256'),
  DACHSTERM_ENDURANCE_TRANSFER_MIB: arg('transfer-mib', '2048'),
  DACHSTERM_ENDURANCE_FAULT_MIB: arg('fault-mib', '512'),
};
const docker = (args, options = {}) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 180_000, ...options });
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

async function perform(child, id, kind, seconds) {
  const ms = Number(seconds) * 1000;
  log(`runner: ${kind} ${seconds}s`);
  if (kind === 'kill') {
    child.kill('SIGKILL');
    return;
  }
  if (kind === 'suspend' || kind === 'suspend-drop') {
    child.kill('SIGSTOP');
    // While the PC "sleeps", the server drops every session of the probe user.
    if (kind === 'suspend-drop') {
      await wait(2000);
      await serverShell('pkill -KILL -u probe');
    }
    await wait(ms);
    child.kill('SIGCONT');
  } else if (kind === 'freeze') {
    await serverShell('pkill -STOP -u probe');
    await wait(ms);
    await serverShell('pkill -CONT -u probe');
  } else if (kind === 'link') {
    docker(['network', 'disconnect', 'bridge', name]);
    await wait(ms);
    docker(['network', 'connect', 'bridge', name]);
  } else throw new Error(`unknown action ${kind}`);
  writeFileSync(path.join(signals, `${id}.done`), '');
  log(`runner: ${kind} over`);
}

/** Runs the probe for some scenarios; resolves with its exit code, or 'killed'. */
function probe(list, dataDir, report) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], {
      env: {
        ...env,
        DACHSTERM_ENDURANCE_SCENARIOS: list,
        DACHSTERM_ENDURANCE_DIR: dataDir,
        DACHSTERM_ENDURANCE_REPORT: report,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let killed = false;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      log(line);
      const m = /^ACTION (\S+) (\S+) (\d+)$/.exec(line);
      if (m) {
        if (m[2] === 'kill') killed = true;
        perform(child, m[1], m[2], m[3]).catch((e) => {
          log(`runner action failed: ${e.message}`);
          child.kill('SIGCONT');
          child.kill('SIGKILL');
        });
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(killed ? 'killed' : code));
  });
}

// A root shell kept open in the server. Faults go through it, because a busy Docker can take
// a minute to start each `docker exec` or `docker pause`, and the fault would last that long.
let shell;
let shellLines;
function openServerShell() {
  shell = spawn('docker', ['exec', '-i', name, 'sh'], { stdio: ['pipe', 'pipe', 'inherit'] });
  shellLines = readline.createInterface({ input: shell.stdout });
}
function serverShell(command) {
  const marker = `DONE_${randomUUID()}`;
  return new Promise((resolve) => {
    const onLine = (line) => {
      if (line === marker) {
        shellLines.off('line', onLine);
        resolve();
      }
    };
    shellLines.on('line', onLine);
    // pkill exits 1 when nothing matched; that is not a failure here.
    shell.stdin.write(`${command}; echo ${marker}\n`);
  });
}

/** A new server: new host keys and password, so each fixture starts a fresh trust. */
async function startFixture() {
  name = `dachsterm-endurance-${randomUUID()}`;
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--label',
    'app.dachsterm.purpose=endurance',
    '-p',
    '127.0.0.1::22',
    '--tmpfs',
    '/run/probe:rw,noexec,nosuid,mode=0700',
    'dachsterm-openssh-probe',
  ]);
  created = true;
  for (
    let i = 0;
    i < 60 && spawnSync('docker', ['exec', name, 'test', '-f', '/run/probe/ready']).status;
    i++
  )
    await wait(500);
  env.DACHSTERM_PROBE_PORT = docker(['port', name, '22/tcp']).split(':').at(-1);
  for (const [key, file] of [
    ['PASSWORD', 'password'],
    ['HOST_KEY', 'host.pub'],
    ['RSA_HOST_KEY', 'host_rsa.pub'],
  ])
    env[`DACHSTERM_PROBE_${key}`] = docker(['exec', name, 'cat', `/run/probe/${file}`]);
  const versions = docker(['exec', name, 'sh', '-c', 'ssh -V 2>&1; uname -r']);
  log(`server: ${versions.replace(/\n/g, ' / ')}`);
  openServerShell();
  await serverShell('true');
  return versions;
}

let created = false;
let failed = false;
try {
  if (!process.argv.includes('--reuse-build'))
    await new Promise((resolve, reject) => {
      const c = spawn(
        'cargo',
        ['build', '--locked', '--release', '-p', 'dachsterm', '--example', 'endurance_probe'],
        { stdio: 'inherit', env },
      );
      c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('cargo build failed'))));
    });
  // A busy Docker can take minutes even for a cached build; reuse the image when it exists.
  const imageExists =
    spawnSync('docker', ['image', 'inspect', 'dachsterm-openssh-probe'], { stdio: 'ignore' })
      .status === 0;
  if (!imageExists || process.argv.includes('--rebuild-image'))
    docker(['build', '-q', '-t', 'dachsterm-openssh-probe', 'tests/openssh'], {
      timeout: 1_800_000,
    });
  let versions = await startFixture();
  for (const scenario of scenarios) {
    // Each scenario starts from a new data folder, as a new app install would.
    const dataDir = path.join(work, scenario);
    const report = path.join(reportDir, `endurance-${scenario}.json`);
    let result;
    if (scenario === 'quit-kill') {
      result = await probe('quit-kill-start', dataDir, path.join(work, 'kill-start.json'));
      if (result !== 'killed') throw new Error(`quit-kill start ended with ${result}`);
      log('runner: probe killed; starting a new process on the same data folder');
      result = await probe('quit-kill-recover', dataDir, report);
    } else result = await probe(scenario, dataDir, report);
    log(`${scenario}: exit ${result}`);
    if (result !== 0) failed = true;
    // Docker does not restore the published port after `link`; later checks need a new server.
    if (scenario === 'link' && scenario !== scenarios.at(-1)) {
      shell.stdin.end();
      docker(['rm', '-f', name]);
      versions = await startFixture();
    }
    if (existsSync(report)) {
      const json = JSON.parse(readFileSync(report, 'utf8'));
      json._environment = { server: versions, platform: process.platform, arch: process.arch };
      writeFileSync(report, JSON.stringify(json, null, 2));
    }
  }
} catch (error) {
  console.error(error.message);
  failed = true;
} finally {
  shell?.stdin.end();
  if (created) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  rmSync(work, { recursive: true, force: true });
  for (const key of Object.keys(env)) if (key.startsWith('DACHSTERM_PROBE_')) delete env[key];
  log(created ? 'fixture removed' : 'no fixture');
}
process.exitCode = failed ? 1 : 0;
