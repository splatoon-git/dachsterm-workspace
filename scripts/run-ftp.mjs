import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const root = await mkdtemp(path.join(tmpdir(), 'daxterm-ftp-'));
const targetRoot = path.resolve(process.env.CARGO_TARGET_DIR ?? 'target');
const python =
  process.env.DAXTERM_FTP_PYTHON || path.resolve('.tools/ftp-fixture/Scripts/python.exe');
const env = {
  ...process.env,
  PATH: `${process.env.USERPROFILE}\\.cargo\\bin;${process.env.PATH}`,
  DAXTERM_FTP_ROOT: root,
  DAXTERM_TEST_BINARY: path.join(targetRoot, 'debug', 'daxterm.exe'),
  DAXTERM_FTP_PASSWORD: randomBytes(32).toString('base64url'),
};
let fixture;
async function cleanup() {
  const absolute = path.resolve(root);
  if (
    path.dirname(absolute) !== path.resolve(tmpdir()) ||
    !path.basename(absolute).startsWith('daxterm-ftp-')
  )
    throw new Error('unsafe FTP cleanup path');
  await rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
async function run(command, args, extra = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...env, ...extra },
      stdio: 'inherit',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('FTP validation timeout'));
    }, 300000);
    child.once('exit', () => clearTimeout(timer));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`FTP validation exited ${code}`)),
    );
  });
}
try {
  if (!process.argv.includes('--reuse-build'))
    await run('cargo', ['build', '-p', 'daxterm', '--example', 'ftp_probe', '--locked']);
  fixture = spawn(python, ['scripts/ftp-fixture.py'], {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const info = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('FTP fixture startup timeout')), 15000);
    fixture.stdout.on('data', (data) => {
      text += data;
      if (text.includes('\n')) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(text.split('\n')[0]));
        } catch {
          reject(new Error('FTP fixture response invalid'));
        }
      }
    });
    fixture.on('error', reject);
    fixture.on('exit', () => {
      clearTimeout(timer);
      reject(new Error('FTP fixture exited'));
    });
  });
  const connectionEnv = {
    DAXTERM_FTP_PORT: String(info.ports.ftp),
    DAXTERM_FTPS_PORT: String(info.ports.ftps),
    DAXTERM_FTP_LEGACY_PORT: String(info.ports.legacy),
    DAXTERM_FTP_CA: info.ca,
  };
  if (!process.argv.includes('--native-only'))
    await run(path.join(targetRoot, 'debug/examples/ftp_probe.exe'), [], connectionEnv);
  if (process.argv.includes('--native') || process.argv.includes('--native-only'))
    await run(process.execPath, ['scripts/test-ftp-native.mjs'], connectionEnv);
} finally {
  if (fixture && fixture.exitCode === null) {
    await new Promise((resolve) => {
      fixture.once('exit', resolve);
      fixture.kill();
    });
  }
  await cleanup();
}
