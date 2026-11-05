// Preserve the complete audit and fail on every finding reachable in the Windows graph.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const env = {
  ...process.env,
  PATH: `${path.join(homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`,
};
function cargo(args) {
  return spawnSync('cargo', args, {
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180000,
  });
}
const metadata = cargo([
  'metadata',
  '--locked',
  '--format-version',
  '1',
  '--filter-platform',
  'x86_64-pc-windows-msvc',
]);
if (metadata.status !== 0) throw new Error('Windows dependency graph unavailable');
const graph = JSON.parse(metadata.stdout);
const ids = new Set(graph.resolve.nodes.map((n) => n.id));
const packages = new Set(
  graph.packages.filter((p) => ids.has(p.id)).map((p) => `${p.name}@${p.version}`),
);
const result = cargo(['audit', '--json']);
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  throw new Error('Audit failed to return a valid report');
}
if (report.error || !report.vulnerabilities || !report.warnings)
  throw new Error('Audit database or scan unavailable');
const all = [...report.vulnerabilities.list, ...Object.values(report.warnings).flat()];
const alerts = all.map((a) => ({
  id: a.advisory.id,
  package: a.package.name,
  version: a.package.version,
  title: a.advisory.title,
  kind: a.kind ?? 'vulnerability',
}));
const windows = alerts.filter((a) => packages.has(`${a.package}@${a.version}`));
const excluded = alerts.filter((a) => !packages.has(`${a.package}@${a.version}`));
await mkdir('target/verification', { recursive: true });
await writeFile('target/verification/cargo-audit-all.json', JSON.stringify(report, null, 2));
await writeFile(
  'target/verification/windows-audit.json',
  JSON.stringify({ target: 'x86_64-pc-windows-msvc', windows, excluded }, null, 2),
);
for (const a of windows) console.log(`BLOCK ${a.id}: ${a.package}@${a.version} (${a.kind})`);
console.log(
  `Windows audit: ${windows.length} findings; ${excluded.length} outside the target graph (retained in report)`,
);
if (windows.length) process.exitCode = 1;
