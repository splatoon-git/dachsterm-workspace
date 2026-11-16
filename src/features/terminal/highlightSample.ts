import type { HighlightRule } from './highlightRules';
import { highlightWorker, type HighlightWorker } from './highlightWorker';

/**
 * Output a rule is tried on before it is saved: common log and shell lines, and long runs of one
 * character, where an expression that backtracks without end shows itself.
 */
export function sampleLines(): string[] {
  const lines = [
    '2026-11-16T12:00:00.000Z INFO worker[42] request served in 12ms path=/api/v1/items?page=7',
    '2026-11-16T12:00:01.000Z ERROR db: connection refused (10.0.0.12:5432) retry=3',
    'drwxr-xr-x  2 user user  4096 Nov 16 12:00 한글 폴더 directory-name-0123456789',
    'Nov 16 12:00:02 host sshd[811]: Accepted publickey for user from 192.168.0.10 port 52144',
    'user@host:~/project$ make test',
    'WARNING: deprecated option --legacy, use --modern instead',
  ];
  const runs = ['a', ' ', '0', '-', '.', 'x', '/', '가'].map((c) => c.repeat(512) + '!');
  return [...Array.from({ length: 40 }, (_, i) => lines[i % lines.length]), ...runs];
}

/** `slow` when the rule cannot get through the sample in the worker's batch limit. */
export async function trySample(
  rule: Pick<HighlightRule, 'id' | 'pattern' | 'ignoreCase'>,
  worker: HighlightWorker = highlightWorker(),
): Promise<'ok' | 'slow' | 'unavailable'> {
  const result = await worker.match(
    [{ id: rule.id, pattern: rule.pattern, ignoreCase: rule.ignoreCase }],
    sampleLines(),
  );
  return result.kind === 'done' ? 'ok' : result.kind === 'timeout' ? 'slow' : 'unavailable';
}
