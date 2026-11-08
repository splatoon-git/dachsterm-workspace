import { useEffect, useMemo, useRef, useState } from 'react';
import { ResizeHandle } from '../../components/ResizeHandle';
import { editExternally } from '../../lib/externalEdit';
import { subscribeGitChanges } from '../../lib/gitChanges';
import { errorText } from '../../lib/ipc';
import { requestSettings } from '../../lib/settingsRequest';
import { sameSource } from '../../lib/source';
import type { TerminalSession } from '../terminal/session';
import { sessionSource } from '../terminal/sessionKind';
import { CommitGraph } from './CommitGraph';
import type { CommitFileOrigin } from './commitGraphModel';
import type { DiffFile } from './gitDiff';
import { GitCommitBox } from './GitCommitBox';
import { GitOutput } from './GitOutput';
import { GitViewHeader } from './GitViewHeader';
import { GitViewList } from './GitViewList';
import { useGitViewMenu } from './GitViewMenu';
import { GitWriteDialog } from './GitWriteDialogs';
import { networkCommands } from './gitWrite';
import {
  groupEntries,
  repoFilePath,
  stoppedReason,
  type GitRow,
  type GitViewRepo,
  type GitViewResult,
} from './gitViewModel';
import type { GitDialogRequest } from './gitWrite';
import { useGitPanes } from './useGitPanes';
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

function Empty({
  title,
  text,
  action,
  settings,
}: {
  title: string;
  text?: string;
  action?: () => void;
  settings?: boolean;
}) {
  return (
    <div className="file-empty">
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {settings && (
        <button
          type="button"
          className="link-button"
          onClick={() => requestSettings({ section: 'git' })}
        >
          설정 → Git
        </button>
      )}
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
      settings
      action={retry}
    />
  );
}

/** The sidebar's Git view (GE.7): the selected tab's repository, and what changed in it. */
export function GitView({
  session,
  review,
  openFile,
  openDiff,
  openCommitFile,
}: {
  session: TerminalSession | undefined;
  /** Opens the change review for this tab, where it can have one. */
  review?: () => void;
  openFile: (path: string, pinned: boolean) => void;
  openDiff: (row: GitRow, root: string, pinned: boolean) => void;
  openCommitFile: (file: DiffFile, origin: CommitFileOrigin, root: string, pinned: boolean) => void;
}) {
  const model = useGitView(session);
  const { measure, ...panes } = useGitPanes();
  const [tree, setTree] = useState(readTree);
  const [notice, setNotice] = useState('');
  const [graphRefresh, setGraphRefresh] = useState(0);
  const ready = model.state === 'ready' ? model : null;
  const repo: GitViewRepo | null = ready?.result?.kind === 'repo' ? ready.result : null;
  const groups = useMemo(() => (repo ? groupEntries(repo.entries) : []), [repo]);
  const source = session && sessionSource(session);
  const refresh = () => {
    ready?.refresh();
    setGraphRefresh((n) => n + 1);
  };
  // A file saved from a tab shows up here without waiting for the next prompt.
  const refreshSaved = useRef({ source, refresh });
  useEffect(() => {
    refreshSaved.current = { source, refresh };
  });
  useEffect(
    () =>
      subscribeGitChanges((change) => {
        const { source: mine, refresh: again } = refreshSaved.current;
        if (change.kind === 'saved' && mine && sameSource(change.source, mine)) again();
      }),
    [],
  );
  const [dialog, setDialog] = useState<GitDialogRequest | null>(null);
  const write = useGitWrite({
    session,
    repo,
    refresh,
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
    refresh,
    review,
    configure:
      repo && source
        ? () => requestSettings({ section: 'git', repo: { source, folder: repo.root } })
        : undefined,
    notice: setNotice,
    write,
    ask: setDialog,
    source,
    openers: {
      file: (path) => openFile(path, true),
      diff: (row) => repo && openDiff(row, repo.root, true),
      external: (path) => {
        if (source && session)
          editExternally(source, session.profile.id, path).catch((e) => setNotice(errorText(e)));
      },
    },
  });
  const openRow = (row: GitRow, pinned: boolean) => {
    if (!repo || !row.readable) return;
    if (row.group === 'conflict') openFile(repoFilePath(repo.root, row.path), pinned);
    else openDiff(row, repo.root, pinned);
  };
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
      <GitViewHeader
        repo={repo}
        refresh={refresh}
        more={menu.more}
        switchBranch={() => setDialog({ kind: 'checkout' })}
        busy={write.busy}
      />
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
          {write.identityMissing && (
            <button
              type="button"
              className="link-button"
              onClick={() => requestSettings({ section: 'git' })}
            >
              설정 → Git
            </button>
          )}
        </p>
      )}
      <div className="git-view-panes" ref={measure}>
        <div className="git-view-body" style={repo ? panes.bodyStyle : undefined}>
          {model.result ? (
            <ResultBody result={model.result} remote={model.remote} retry={model.refresh}>
              {groups.length ? (
                <GitViewList
                  groups={groups}
                  tree={tree}
                  open={openRow}
                  menu={menu.row}
                  groupMenu={menu.group}
                  rowButtons={menu.rowButtons}
                  groupButtons={menu.groupButtons}
                />
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
        {repo && session && panes.open && (
          <ResizeHandle
            horizontal
            className="git-view-split"
            label="변경 목록과 그래프 크기"
            value={panes.height}
            min={panes.min}
            max={panes.max}
            onChange={panes.setHeight}
            onReset={panes.reset}
          />
        )}
        {repo && session && (
          <CommitGraph
            key={`${session.connectionId}\n${repo.root}`}
            session={session}
            folder={repo.root}
            version={`${repo.oid}\n${repo.upstream}\n${repo.ahead}\n${repo.behind}\n${graphRefresh}`}
            notice={setNotice}
            open={panes.open}
            setOpen={panes.setOpen}
            actions={{
              fetch: () => void write.runInTerminal(networkCommands.fetch),
              pull: () => void write.runInTerminal(networkCommands.pull),
              push: () => void write.runInTerminal(networkCommands.push),
              refresh,
            }}
            openFile={(file, origin, pinned) => openCommitFile(file, origin, repo.root, pinned)}
          />
        )}
      </div>
      <GitOutput log={write.log} />
      {menu.menu}
      {dialog && repo && (
        <GitWriteDialog
          request={dialog}
          repo={repo}
          close={() => setDialog(null)}
          write={write}
          ask={setDialog}
        />
      )}
    </div>
  );
}
