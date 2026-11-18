// Fail on every npm advisory, except reviewed ones in audit-exceptions.json. An exception may only
// cover development tooling: anything reachable from production dependencies always blocks.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { exceptionProblems, exceptionsFor, matches } from './audit-exceptions.mjs';

function audit(flags) {
  // npm is a .cmd shim on Windows, which Node only starts through a shell; the command is fixed text.
  const result = spawnSync(`npm audit --json ${flags}`, {
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180000,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error('npm audit did not return a valid report');
  }
  if (report.error || !report.vulnerabilities) throw new Error('npm audit database unavailable');
  return report;
}

function advisories(report) {
  const found = new Map();
  for (const entry of Object.values(report.vulnerabilities))
    for (const via of entry.via)
      if (typeof via === 'object') {
        const id = String(via.url).split('/').pop();
        found.set(`${id} ${via.name}`, {
          id,
          package: via.name,
          range: via.range,
          severity: via.severity,
          title: via.title,
        });
      }
  return [...found.values()];
}

const exceptions = await exceptionsFor('npm');
const full = audit('');
const production = audit('--omit=dev');
const all = advisories(full);
const shipped = advisories(production);
const isShipped = (a) => shipped.some((s) => matches(s, a));
const excepted = (a) => exceptions.some((e) => matches(e, a));
const blocking = [...shipped, ...all.filter((a) => !isShipped(a) && !excepted(a))];
const allowed = all.filter((a) => !isShipped(a) && excepted(a));
const problems = exceptionProblems(
  exceptions,
  all.filter((a) => !isShipped(a)),
);

await mkdir('target/verification', { recursive: true });
await writeFile(
  'target/verification/npm-audit.json',
  JSON.stringify({ blocking, allowed, problems, full }, null, 2),
);
for (const a of blocking)
  console.log(`BLOCK ${a.id}: ${a.package} ${a.range} (${a.severity}) ${a.title}`);
for (const a of allowed)
  console.log(`ALLOW ${a.id}: ${a.package} ${a.range} (development only, excepted)`);
for (const p of problems) console.log(p);
console.log(
  `npm audit: ${blocking.length} findings, ${allowed.length} excepted development-only, ${problems.length} exception problems`,
);
if (blocking.length || problems.length) process.exitCode = 1;
