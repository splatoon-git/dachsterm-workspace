import type { GitLogEntry } from './gitWrite';

const resultLabel = { done: '완료', failed: '실패', typed: '터미널에 입력' };

/** The last Git commands of this tab, newest first. Shown only once there is one. */
export function GitOutput({ log }: { log: GitLogEntry[] }) {
  if (!log.length) return null;
  return (
    <details className="git-output">
      <summary>
        출력 <small>{log.length}</small>
      </summary>
      <ol aria-label="실행한 Git 명령">
        {log.map((entry) => (
          <li key={entry.id} data-result={entry.result}>
            <code>{entry.command}</code>
            <small>{resultLabel[entry.result]}</small>
            {entry.detail && <p>{entry.detail}</p>}
          </li>
        ))}
      </ol>
    </details>
  );
}
