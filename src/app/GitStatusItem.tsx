import { Icon } from '../components/Icon';
import { gitSentence, gitStatusText, gitTooltip } from '../features/git/gitStatus';
import { useGitStatus } from '../features/git/useGitStatus';
import type { TerminalSession } from '../features/terminal/session';
import { useGitDisplay } from '../lib/gitDisplay';

const stopReasons = { timeout: '시간 초과', tooLarge: '출력이 너무 큼' };

/**
 * The branch and change count of the folder the focused tab's shell is in (SSH, local, WSL). Shown only when
 * there is something to show: a repository, a stopped query, or a manual query's failure. With
 * automatic queries off, a small button asks once.
 *
 * Clicking a repository opens the Git view and also queries again, which is the only refresh left
 * when automatic queries are off. A detached window has no Git view, so there it only refreshes.
 */
export function GitStatusItem({
  session,
  showGit,
}: {
  session: TerminalSession;
  showGit?: () => void;
}) {
  const git = useGitStatus(session);
  const { detail, statusBar } = useGitDisplay();
  if (!git?.directory || !statusBar) return null;
  const { view, error, refresh } = git;
  const icon = <Icon name="branch" size={12} />;
  const item =
    view && 'repo' in view ? (
      <button
        type="button"
        className="status-git"
        title={`${gitTooltip(view.repo)}\n클릭하면 ${showGit ? 'Git 보기를 엽니다' : '새로 고칩니다'}`}
        aria-label={`${gitSentence(view.repo)}. ${showGit ? 'Git 보기 열기' : '새로 고침'}`}
        onClick={() => {
          showGit?.();
          refresh();
        }}
      >
        {icon}
        {gitStatusText(view.repo, detail)}
      </button>
    ) : view ? (
      <button
        type="button"
        className="status-git"
        title={`Git 자동 조회를 멈췄습니다 (${stopReasons[view.stopped]}). 클릭하면 다시 조회합니다`}
        onClick={refresh}
      >
        {icon}
        Git 조회 멈춤
      </button>
    ) : !git.auto ? (
      <button type="button" className="status-git" title="Git 상태 조회" onClick={refresh}>
        {icon}
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
