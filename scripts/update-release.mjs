#!/usr/bin/env node
// Release files for the in-app update (CG.6).
//
//   node scripts/update-release.mjs collect [--out release] [--config <overlay.json>]...
//     After `tauri build --config src-tauri/tauri.release.conf.json` on one OS, copies that OS's
//     update package and its signature into --out and records them in <platform>.json.
//   node scripts/update-release.mjs manifest [--out release] [--notes <file>] [--base-url <url>]
//     Joins the recorded platforms into latest.json, which the app reads from the endpoint in
//     tauri.conf.json. Upload latest.json and the packages to the release named v<version>.
//
// The signing key never passes through here: the Tauri CLI reads it from
// TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) while building and writes the .sig files this reads.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...rest] = process.argv.slice(2);
const options = { out: 'release', config: [], notes: null, baseUrl: null };
for (let i = 0; i < rest.length; i += 2) {
  const [flag, value] = [rest[i], rest[i + 1]];
  if (value === undefined) fail(`${flag}에 값이 없습니다.`);
  if (flag === '--out') options.out = value;
  else if (flag === '--config') options.config.push(value);
  else if (flag === '--notes') options.notes = value;
  else if (flag === '--base-url') options.baseUrl = value;
  else fail(`모르는 옵션: ${flag}`);
}
const out = resolve(options.out);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** tauri.conf.json with the overlays the build used, merged the way the CLI merges them. */
function config() {
  const merge = (base, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      base[key] =
        value && typeof value === 'object' && !Array.isArray(value) && base[key]
          ? merge({ ...base[key] }, value)
          : value;
    }
    return base;
  };
  return options.config.reduce(
    (merged, path) => merge(merged, readJson(resolve(path))),
    readJson(join(root, 'src-tauri/tauri.conf.json')),
  );
}

function collect() {
  const conf = config();
  if (!conf.plugins?.updater?.pubkey?.trim())
    fail(
      'plugins.updater.pubkey가 비어 있습니다. 이 빌드는 업데이트를 받지 못하므로 배포하지 않습니다.',
    );
  const { version } = conf;
  const bundle = join(root, 'target/release/bundle');
  let platform, source, name;
  if (process.platform === 'darwin') {
    if (process.arch !== 'arm64') fail('macOS 배포는 Apple Silicon에서만 만듭니다.');
    platform = 'darwin-aarch64';
    source = join(bundle, 'macos', `${conf.productName}.app.tar.gz`);
    name = `${conf.productName}_${version}_aarch64.app.tar.gz`;
  } else if (process.platform === 'win32') {
    platform = 'windows-x86_64';
    name = `${conf.productName}_${version}_x64-setup.exe`;
    source = join(bundle, 'nsis', name);
  } else fail(`배포 대상이 아닌 운영체제: ${process.platform}`);
  for (const path of [source, `${source}.sig`])
    if (!existsSync(path))
      fail(`${path}가 없습니다. tauri.release.conf.json으로 서명 키와 함께 빌드했는지 확인하세요.`);
  mkdirSync(out, { recursive: true });
  copyFileSync(source, join(out, name));
  const signature = readFileSync(`${source}.sig`, 'utf8').trim();
  writeFileSync(
    join(out, `${platform}.json`),
    `${JSON.stringify({ version, platform, file: name, signature }, null, 2)}\n`,
  );
  console.log(`${platform}: ${name}`);
}

function manifest() {
  const conf = config();
  const parts = readdirSync(out)
    .filter((f) => /^(darwin|windows)-[a-z0-9_]+\.json$/.test(f))
    .map((f) => readJson(join(out, f)));
  if (!parts.length) fail(`${out}에 collect 결과가 없습니다.`);
  const versions = new Set(parts.map((p) => p.version));
  if (versions.size !== 1) fail(`운영체제별 버전이 다릅니다: ${[...versions].join(', ')}`);
  const [version] = versions;
  const base =
    options.baseUrl ??
    conf.plugins.updater.endpoints[0].replace(
      /\/releases\/latest\/download\/latest\.json$/,
      `/releases/download/v${version}`,
    );
  const platforms = Object.fromEntries(
    parts.map((p) => [p.platform, { url: `${base}/${p.file}`, signature: p.signature }]),
  );
  const notes = options.notes ? readFileSync(resolve(options.notes), 'utf8').trim() : '';
  const latest = { version, notes, pub_date: new Date().toISOString(), platforms };
  writeFileSync(join(out, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`latest.json: ${version} · ${Object.keys(platforms).join(', ')}`);
}

if (command === 'collect') collect();
else if (command === 'manifest') manifest();
else fail('사용법: node scripts/update-release.mjs collect|manifest [옵션]');
