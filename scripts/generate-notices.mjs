// Inventory and verbatim license texts; no source paths or credentials in output.
import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const env = {
  ...process.env,
  PATH: `${path.join(homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`,
};
const platforms = ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin'];
const packages = new Map();
for (const platform of platforms) {
  const metadata = spawnSync(
    'cargo',
    ['metadata', '--locked', '--format-version', '1', '--filter-platform', platform],
    { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  if (metadata.status !== 0) throw new Error('Cargo metadata failed; no notices generated');
  const cargo = JSON.parse(metadata.stdout);
  const reachable = new Set(cargo.resolve.nodes.map((n) => n.id));
  for (const p of cargo.packages) if (reachable.has(p.id)) packages.set(p.id, p);
}
const items = [...packages.values()]
  .filter((p) => p.source || p.name === 'ssh-key')
  .map((p) => ({
    ecosystem: 'cargo',
    name: p.name,
    version: p.version,
    license: p.license ?? 'SEE LICENSE FILE',
    root: path.dirname(p.manifest_path),
    licenseFile: p.license_file,
    repository: p.repository,
  }));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
for (const [location, p] of Object.entries(lock.packages)) {
  if (!location || p.dev) continue;
  const manifest = JSON.parse(await readFile(path.join(location, 'package.json'), 'utf8'));
  items.push({
    ecosystem: 'npm',
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === 'string' ? manifest.license : 'UNDECLARED',
    root: path.resolve(location),
  });
}
items.sort((a, b) =>
  `${a.ecosystem}:${a.name}:${a.version}`.localeCompare(`${b.ecosystem}:${b.name}:${b.version}`),
);
const records = [];
const notices = [
  'DachsTerm third-party notices',
  'Generated from locked Windows and macOS dependency metadata. Includes build dependencies; inclusion does not imply every component is shipped.',
  'Project branding and application licensing are managed separately.',
  '',
];
let missing = 0;
for (const item of items) {
  const names = (await readdir(item.root)).filter((name) =>
    /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(name),
  );
  if (item.licenseFile && !names.includes(item.licenseFile)) names.push(item.licenseFile);
  const texts = [];
  for (const name of names.sort()) {
    try {
      const licensePath = path.resolve(item.root, name);
      if (!licensePath.startsWith(item.root + path.sep)) continue;
      const body = await readFile(licensePath, 'utf8');
      if (body.length <= 1024 * 1024) texts.push({ name, body });
    } catch {
      /* directories are not license documents */
    }
  }
  const upstreamFile = `licenses/upstream/${item.name}-${item.version}.json`;
  if (!texts.length && process.argv.includes('--fetch-missing') && item.repository) {
    const repo = item.repository.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/);
    if (repo) {
      try {
        const vcs = JSON.parse(
          await readFile(path.join(item.root, '.cargo_vcs_info.json'), 'utf8'),
        );
        if (!/^[0-9a-f]{40}$/.test(vcs.git.sha1)) throw new Error('invalid commit');
        const candidates = [
          'LICENSE',
          'LICENSE.md',
          'LICENSE.txt',
          'LICENSE-2.0.txt',
          'LICENCE',
          'COPYING',
          'LICENSE-APACHE',
          'LICENSE-MIT',
        ];
        const fetched = [];
        for (const name of candidates) {
          const url = `https://raw.githubusercontent.com/${repo[1]}/${repo[2].replace(/\.git$/, '')}/${vcs.git.sha1}/${name}`;
          const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
          if (response.ok) {
            const body = await response.text();
            if (body.length > 50 && body.length < 1024 * 1024) fetched.push({ name: url, body });
          }
        }
        if (fetched.length) {
          await mkdir('licenses/upstream', { recursive: true });
          await writeFile(
            upstreamFile,
            JSON.stringify(
              { name: item.name, version: item.version, commit: vcs.git.sha1, texts: fetched },
              null,
              2,
            ) + '\n',
          );
        }
      } catch {
        /* An unavailable upstream leaves a visible release gate. */
      }
    }
  }
  if (!texts.length) {
    try {
      const upstream = JSON.parse(await readFile(upstreamFile, 'utf8'));
      if (upstream.name === item.name && upstream.version === item.version)
        texts.push(...upstream.texts);
    } catch {
      /* Missing text remains explicit below. */
    }
  }
  if (!texts.length) missing++;
  records.push({
    ecosystem: item.ecosystem,
    name: item.name,
    version: item.version,
    license: item.license,
    repository: item.repository ?? null,
    licenseTextsFound: texts.length,
  });
  notices.push(
    `\n========== ${item.ecosystem}: ${item.name} ${item.version} (${item.license}) ==========\n`,
  );
  for (const text of texts) notices.push(`--- ${text.name} ---\n${text.body}`);
  if (!texts.length) notices.push('REVIEW REQUIRED: no packaged license text found.');
}
await mkdir('licenses', { recursive: true });
await writeFile(
  'licenses/dependencies.json',
  JSON.stringify({ platforms, components: records, missingLicenseTexts: missing }, null, 2) + '\n',
);
await writeFile('licenses/THIRD_PARTY_NOTICES.txt', notices.join('\n'));
console.log(
  `Generated notices: ${records.length} components; ${missing} require license text review`,
);
if (missing) process.exitCode = 1;
