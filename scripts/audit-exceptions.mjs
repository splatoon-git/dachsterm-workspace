// Reviewed audit exceptions shared by audit-npm.mjs and audit-dependencies.mjs. Each one names the
// advisory and package, says why it is accepted and when to look again. Which advisories an
// exception may cover is each audit's own policy; expired or no-longer-reported ones always fail.
import { readFile } from 'node:fs/promises';

export async function exceptionsFor(ecosystem) {
  const all = JSON.parse(await readFile('scripts/audit-exceptions.json', 'utf8'));
  const list = all[ecosystem];
  if (!Array.isArray(list)) throw new Error(`audit-exceptions.json has no ${ecosystem} list`);
  for (const e of list)
    if (!e.id || !e.package || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.review ?? ''))
      throw new Error(`Malformed ${ecosystem} exception: ${JSON.stringify(e)}`);
  return list;
}

export const matches = (e, a) => e.id === a.id && e.package === a.package;

/** Problems with the list itself, given every advisory the exceptions could have applied to. */
export function exceptionProblems(list, reported) {
  const today = new Date().toISOString().slice(0, 10);
  const problems = [];
  for (const e of list) {
    if (e.review < today)
      problems.push(`EXPIRED ${e.id} (${e.package}): review was due ${e.review}`);
    if (!reported.some((a) => matches(e, a)))
      problems.push(`STALE ${e.id} (${e.package}): no longer reported, remove the exception`);
  }
  return problems;
}
