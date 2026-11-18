// Preserve the complete audit and fail on every finding reachable in a released platform's graph,
// except unmaintained notices reviewed in audit-exceptions.json.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { exceptionProblems, exceptionsFor, matches } from './audit-exceptions.mjs';
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
const targets = ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin'];
const packages = new Set();
for (const target of targets) {
  const metadata = cargo([
    'metadata',
    '--locked',
    '--format-version',
    '1',
    '--filter-platform',
    target,
  ]);
  if (metadata.status !== 0) throw new Error(`Dependency graph unavailable for ${target}`);
  const graph = JSON.parse(metadata.stdout);
  const ids = new Set(graph.resolve.nodes.map((n) => n.id));
  for (const p of graph.packages) if (ids.has(p.id)) packages.add(`${p.name}@${p.version}`);
}
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
const shipped = alerts.filter((a) => packages.has(`${a.package}@${a.version}`));
const excluded = alerts.filter((a) => !packages.has(`${a.package}@${a.version}`));
// Only unmaintained notices may be excepted; vulnerabilities and unsound code in the app always block.
const exceptions = await exceptionsFor('cargo');
const exceptable = shipped.filter((a) => a.kind === 'unmaintained');
const excepted = (a) => exceptable.includes(a) && exceptions.some((e) => matches(e, a));
const blocking = shipped.filter((a) => !excepted(a));
const allowed = shipped.filter(excepted);
const problems = exceptionProblems(exceptions, exceptable);
await mkdir('target/verification', { recursive: true });
await writeFile('target/verification/cargo-audit-all.json', JSON.stringify(report, null, 2));
await writeFile(
  'target/verification/dependency-audit.json',
  JSON.stringify({ targets, blocking, allowed, problems, excluded }, null, 2),
);
for (const a of blocking) console.log(`BLOCK ${a.id}: ${a.package}@${a.version} (${a.kind})`);
for (const a of allowed)
  console.log(`ALLOW ${a.id}: ${a.package}@${a.version} (${a.kind}, excepted)`);
for (const p of problems) console.log(p);
console.log(
  `Dependency audit: ${blocking.length} findings, ${allowed.length} excepted, ${problems.length} exception problems; ${excluded.length} outside the target graphs (retained in report)`,
);
if (blocking.length || problems.length) process.exitCode = 1;
