import { Icon } from '../../components/Icon';
import { branchLabel } from './gitStatus';
import type { GitViewRepo } from './gitViewModel';

/** The branch and how far it is from its upstream, with the view's two small buttons. */
export function GitViewHeader({
  repo,
  refresh,
  more,
}: {
  repo: GitViewRepo | null;
  refresh: () => void;
  more: (anchor: HTMLElement) => void;
}) {
  const upstream =
    repo?.upstream && `${repo.upstream} 대비 앞섬 ${repo.ahead} · 뒤처짐 ${repo.behind}`;
  return (
    <div className="git-view-head">
      <span className="git-view-branch" title={repo?.root}>
        {repo && (
          <>
            <Icon name="branch" size={14} />
            <span className="git-view-branch-name">{branchLabel({ ...repo, entries: [] })}</span>
            {repo.upstream && (
              <span className="git-view-sync" title={upstream ?? undefined}>
                ↑{repo.ahead} ↓{repo.behind}
              </span>
            )}
          </>
        )}
      </span>
      <button
        type="button"
        className="git-view-tool"
        aria-label="Git 새로 고침"
        title="새로 고침"
        onClick={refresh}
      >
        <Icon name="refresh" size={14} />
      </button>
      <button
        type="button"
        className="git-view-tool"
        aria-label="Git 더 보기"
        title="더 보기"
        onClick={(e) => more(e.currentTarget)}
      >
        <Icon name="more" size={14} />
      </button>
    </div>
  );
}
