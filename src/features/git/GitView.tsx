import { useMemo, useState } from 'react';
import type { TerminalSession } from '../terminal/session';
import { GitCommitBox } from './GitCommitBox';
import { GitOutput } from './GitOutput';
import { GitViewHeader } from './GitViewHeader';
import { GitViewList } from './GitViewList';
import { useGitViewMenu } from './GitViewMenu';
import { GitWriteDialog } from './GitWriteDialogs';
import { groupEntries, stoppedReason, type GitViewRepo, type GitViewResult } from './gitViewModel';
import type { GitDialogRequest } from './gitWrite';
import { useGitView } from './useGitView';
import { useGitWrite } from './useGitWrite';
import './gitView.css';

const treeKey = 'dachsterm.gitView.tree';
function readTree() {
  try {
    return localStorage.getItem(treeKey) === 'true';
  } catch {
    // Storage can be blocked; the flat list is the default.
    return false;
  }
}
function saveTree(tree: boolean) {
  try {
    localStorage.setItem(treeKey, String(tree));
  } catch {
    // Storage can be blocked; the layout simply is not remembered.
  }
}

function Empty({ title, text, action }: { title: string; text?: string; action?: () => void }) {
  return (
    <div className="file-empty">
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action && (
        <button type="button" onClick={action}>
          다시 조회
        </button>
      )}
    </div>
  );
}

function ResultBody({
  result,
  remote,
  retry,
  children,
}: {
  result: GitViewResult;
  remote: boolean;
  retry: () => void;
  children: React.ReactNode;
}) {
  if (result.kind === 'repo') return children;
  if (result.kind === 'notRepo')
    return <Empty title="Git 저장소가 아닙니다" text={result.detail || undefined} />;
  if (result.kind === 'stopped')
    return <Empty title={stoppedReason[result.reason]} action={retry} />;
  return (
    <Empty
      title={result.detail}
      text={remote ? '서버에 git을 설치한 뒤 다시 조회하세요.' : 'git을 설치한 뒤 다시 조회하세요.'}
      action={retry}
    />
  );
}

/** The sidebar's Git view (GE.7): the selected tab's repository, and what changed in it. */
export function GitView({
  session,
  review,
}: {
  session: TerminalSession | undefined;
  /** Opens the change review for this tab, where it can have one. */
  review?: () => void;
}) {
  const model = useGitView(session);
  const [tree, setTree] = useState(readTree);
  const [notice, setNotice] = useState('');
  const ready = model.state === 'ready' ? model : null;
  const repo: GitViewRepo | null = ready?.result?.kind === 'repo' ? ready.result : null;
  const groups = useMemo(() => (repo ? groupEntries(repo.entries) : []), [repo]);
  const [dialog, setDialog] = useState<GitDialogRequest | null>(null);
  const write = useGitWrite({
    session,
    repo,
    refresh: () => ready?.refresh(),
    notice: setNotice,
    ask: setDialog,
  });
  const menu = useGitViewMenu({
    repo,
    groups,
    tree,
    setTree: (next) => {
      setTree(next);
      saveTree(next);
    },
    refresh: () => ready?.refresh(),
    review,
    notice: setNotice,
    write,
    ask: setDialog,
  });
  if (model.state === 'noTab')
    return (
      <div className="git-view">
        <Empty
          title="연 탭이 없습니다"
          text="SSH, 로컬, WSL 탭을 열면 그 폴더의 Git 상태를 보여 줍니다."
        />
      </div>
    );
  if (model.state === 'unsupported')
    return (
      <div className="git-view">
        <Empty
          title={
            model.ftp ? 'FTP 연결에서는 Git을 쓸 수 없습니다' : '이 탭에서는 Git을 쓸 수 없습니다'
          }
          text="SSH, 로컬, WSL 탭에서 사용할 수 있습니다."
        />
      </div>
    );
  if (model.state === 'disconnected')
    return (
      <div className="git-view">
        <Empty title="연결되면 Git 상태를 표시합니다" />
      </div>
    );
  if (model.state === 'noFolder')
    return (
      <div className="git-view">
        <Empty
          title="폴더를 아직 모릅니다"
          text="터미널이 현재 폴더를 알리거나 파일 보기에서 폴더를 열면 표시합니다."
        />
      </div>
    );
  // The scheduler also reports "not a repository", which the body already says.
  const error = notice || (!model.result || repo ? model.error : '');
  const stagedCount = groups.find((group) => group.id === 'staged')?.rows.length ?? 0;
  const commit = async () => {
    if (await write.apply({ kind: 'commit', message: write.draft, amend: false }))
      write.setDraft('');
  };
  return (
    <div className="git-view">
      <GitViewHeader repo={repo} refresh={model.refresh} more={menu.more} />
      {repo && (
        <GitCommitBox
          draft={write.draft}
          setDraft={write.setDraft}
          stagedCount={stagedCount}
          busy={write.busy}
          commit={() => void commit()}
          more={menu.commitMore}
        />
      )}
      {error && (
        <p className="git-view-note git-view-error" role="status">
          {error}
        </p>
      )}
      <div className="git-view-body">
        {model.result ? (
          <ResultBody result={model.result} remote={model.remote} retry={model.refresh}>
            {groups.length ? (
              <GitViewList groups={groups} tree={tree} menu={menu.row} groupMenu={menu.group} />
            ) : (
              <Empty title="변경 사항이 없습니다" />
            )}
            {repo?.truncated && (
              <p className="git-view-note">변경이 많아 앞 5,000개만 표시합니다.</p>
            )}
          </ResultBody>
        ) : (
          !error && <Empty title="조회 중…" />
        )}
      </div>
      <GitOutput log={write.log} />
      {menu.menu}
      {dialog && repo && (
        <GitWriteDialog request={dialog} repo={repo} close={() => setDialog(null)} write={write} />
      )}
    </div>
  );
}
