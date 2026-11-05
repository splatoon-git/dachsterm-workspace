// Preserve release provenance while other work continues in the shared workspace.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('target/verification/survivor-g86-artifacts');
const files = [
  'daxterm-debug.exe',
  'daxterm-release.exe',
  'daxterm-nsis-payload.exe',
  'DaxTerm_0.5.1_x64-setup.exe',
];
const buffers = await Promise.all(files.map((file) => readFile(path.join(root, file))));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const patched = Buffer.from(buffers[1]);
const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const offset = patched.indexOf(marker);
assert(offset >= 0, 'Unbundled Tauri bundle-type marker missing');
patched.set(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS'), offset);
assert(
  patched.equals(buffers[2]),
  'Installed NSIS payload differs beyond the Tauri bundle-type marker',
);
const checks = [];
for (const name of ['play', 'integration', 'ui', 'performance', 'lifecycle']) {
  const file = path.join(root, 'evidence', `survivor-${name}-native.json`);
  const result = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(result.sha256, hash(buffers[0]), `${name} evidence binary mismatch`);
  checks.push(file);
}
const manifest = {
  version: '0.5.1',
  baseCommit: 'da01f5c',
  contentVersion: 3,
  sourceSnapshot: path.resolve('target/verification/g86-source'),
  files: files.map((name, i) => ({
    path: path.join(root, name),
    bytes: buffers[i].length,
    sha256: hash(buffers[i]),
  })),
  nsisPayloadOnlyChangesTauriBundleType: true,
  markerOffset: offset,
  checks,
};
await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
