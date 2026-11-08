import { gitSentence, gitStatusText, gitTooltip } from '../features/git/gitStatus';
import { useGitStatus } from '../features/git/useGitStatus';
import type { TerminalSession } from '../features/terminal/session';

const stopReasons = { timeout: '시간 초과', tooLarge: '출력이 너무 큼' };

/**
 * The branch and change count of the folder the focused tab's shell is in (SSH, local, WSL). Shown only when
 * there is something to show: a repository, a stopped query, or a manual query's failure. With
 * automatic queries off, a small button asks once.
 */
export function GitStatusItem({ session }: { session: TerminalSession }) {
  const git = useGitStatus(session);
  if (!git?.directory) return null;
  const { view, error, refresh } = git;
  const item =
    view && 'repo' in view ? (
      <button
        type="button"
        className="status-git"
        title={`${gitTooltip(view.repo)}\n클릭하면 새로 고칩니다`}
        aria-label={`${gitSentence(view.repo)}. 새로 고침`}
        onClick={refresh}
      >
        {gitStatusText(view.repo)}
      </button>
    ) : view ? (
      <button
        type="button"
        className="status-git"
        title={`Git 자동 조회를 멈췄습니다 (${stopReasons[view.stopped]}). 클릭하면 다시 조회합니다`}
        onClick={refresh}
      >
        Git 조회 멈춤
      </button>
    ) : !git.auto ? (
      <button type="button" className="status-git" title="Git 상태 조회" onClick={refresh}>
        Git
      </button>
    ) : null;
  return (
    <>
      {item}
      {error && (
        <span className="status-message" role="status" title={error}>
          Git · {error}
        </span>
      )}
    </>
  );
}
