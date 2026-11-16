/** What the matching worker is given: the rules to run and the terminal's new logical lines. */
export type MatchRule = { id: string; pattern: string; ignoreCase: boolean };
export type MatchRequest = { id: number; rules: MatchRule[]; lines: string[] };
/** `rule` indexes the request's rules; `start` and `end` are UTF-16 offsets in the line. */
export type Match = { line: number; rule: number; start: number; end: number };
export type WorkerReply =
  { type: 'rule'; id: number; rule: string } | { type: 'done'; id: number; matches: Match[] };

/** More matches than this in one batch would only be cut by the decoration limit anyway. */
export const maxMatches = 2000;

const compiled = new Map<string, RegExp | null>();
function expression(rule: MatchRule) {
  const key = `${rule.ignoreCase}\u0000${rule.pattern}`;
  if (!compiled.has(key)) {
    try {
      compiled.set(key, new RegExp(rule.pattern, rule.ignoreCase ? 'gi' : 'g'));
    } catch {
      compiled.set(key, null);
    }
    // Rules are few; the cache only has to outlive edits in one run.
    if (compiled.size > 256) compiled.delete(compiled.keys().next().value!);
  }
  return compiled.get(key) ?? null;
}

/**
 * Every rule against every line. `started` runs before each rule so the caller can tell which one
 * was running if the batch never finishes. Empty matches are skipped.
 */
export function matchLines(
  rules: readonly MatchRule[],
  lines: readonly string[],
  started: (rule: MatchRule) => void = () => {},
): Match[] {
  const matches: Match[] = [];
  rules.forEach((rule, index) => {
    const regex = expression(rule);
    if (!regex) return;
    started(rule);
    for (let line = 0; line < lines.length; line++) {
      regex.lastIndex = 0;
      const text = lines[line];
      let found: RegExpExecArray | null;
      while ((found = regex.exec(text))) {
        if (!found[0].length) {
          regex.lastIndex++;
          if (regex.lastIndex > text.length) break;
          continue;
        }
        matches.push({ line, rule: index, start: found.index, end: found.index + found[0].length });
        if (matches.length >= maxMatches) return;
      }
    }
  });
  return matches.slice(0, maxMatches);
}
