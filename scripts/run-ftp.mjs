import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const windows = process.platform === 'win32';
const nativeRequested = ['--native', '--native-only', '--queue-native-only'].some((flag) =>
  process.argv.includes(flag),
);
// The native steps drive the app through WebView2's debugging port, which macOS does not have.
if (nativeRequested && !windows)
  throw new Error('FTP native checks need WebView2 and run on Windows only');
const executable = (name) => (windows ? `${name}.exe` : name);
const root = await mkdtemp(path.join(tmpdir(), 'dachsterm-ftp-'));
const targetRoot = path.resolve(process.env.CARGO_TARGET_DIR ?? 'target');
const python =
  process.env.DACHSTERM_FTP_PYTHON ||
  path.resolve(windows ? '.tools/ftp-fixture/Scripts/python.exe' : '.tools/ftp-fixture/bin/python');
const env = {
  ...process.env,
  PATH: `${path.join(homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`,
  DACHSTERM_FTP_ROOT: root,
  DACHSTERM_TEST_BINARY:
    process.env.DACHSTERM_TEST_BINARY ?? path.join(targetRoot, 'debug', executable('dachsterm')),
  DACHSTERM_FTP_PASSWORD: randomBytes(32).toString('base64url'),
};
let fixture;
async function cleanup() {
  const absolute = path.resolve(root);
  if (
    path.dirname(absolute) !== path.resolve(tmpdir()) ||
    !path.basename(absolute).startsWith('dachsterm-ftp-')
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
    await run('cargo', ['build', '-p', 'dachsterm', '--example', 'ftp_probe', '--locked']);
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
    DACHSTERM_FTP_PORT: String(info.ports.ftp),
    DACHSTERM_FTPS_PORT: String(info.ports.ftps),
    DACHSTERM_FTP_LEGACY_PORT: String(info.ports.legacy),
    DACHSTERM_FTP_CA: info.ca,
  };
  if (!process.argv.includes('--native-only') && !process.argv.includes('--queue-native-only'))
    await run(path.join(targetRoot, 'debug/examples', executable('ftp_probe')), [], connectionEnv);
  if (process.argv.includes('--queue-native-only'))
    await run(process.execPath, ['scripts/test-transfer-queue-native.mjs'], connectionEnv);
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
