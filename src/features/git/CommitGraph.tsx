import { useRef, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import type { Source } from '../../lib/source';
import { sessionSource } from '../terminal/sessionKind';
import type { TerminalSession } from '../terminal/session';
import { CommitList } from './CommitGraphList';
import { graphMax, graphStopped, type CommitFileOrigin, type GraphScope } from './commitGraphModel';
import type { DiffFile } from './gitDiff';
import { moveFocus } from './GitViewList';
import { useCommitGraph } from './useCommitGraph';
import './commitGraph.css';

const scopeKey = 'dachsterm.gitView.graphScope';
function readScope(): GraphScope {
  try {
    return localStorage.getItem(scopeKey) === 'all' ? 'all' : 'auto';
  } catch {
    // Storage can be blocked; the current branch is the default.
    return 'auto';
  }
}
function saveScope(scope: GraphScope) {
  try {
    localStorage.setItem(scopeKey, scope);
  } catch {
    // Storage can be blocked; the choice simply is not remembered.
  }
}

const scopeText: Record<GraphScope, { label: string; title: string }> = {
  auto: { label: '자동', title: '현재 브랜치와 업스트림만 표시 중. 누르면 모든 브랜치를 봅니다' },
  all: { label: '모두', title: '모든 브랜치와 태그를 표시 중. 누르면 현재 브랜치만 봅니다' },
};

export type GitGraphActions = {
  fetch: () => void;
  pull: () => void;
  push: () => void;
  refresh: () => void;
};

type OpenCommitFile = (file: DiffFile, origin: CommitFileOrigin, pinned: boolean) => void;

function Body({
  source,
  folder,
  version,
  scope,
  notice,
  openFile,
}: {
  source: Source;
  folder: string;
  version: string;
  scope: GraphScope;
  notice: (text: string) => void;
  openFile: OpenCommitFile;
}) {
  const graph = useCommitGraph({ source, folder, version, scope });
  const { result, error } = graph;
  if (error && !result) return <p className="git-view-note git-view-error">{error}</p>;
  if (!result) return <p className="git-view-note">조회 중…</p>;
  if (result.kind === 'empty') return <p className="git-view-note">아직 커밋이 없습니다.</p>;
  if (result.kind === 'notRepo' || result.kind === 'noGit')
    return <p className="git-view-note">{result.detail || 'Git 이력을 읽을 수 없습니다.'}</p>;
  if (result.kind === 'stopped')
    return (
      <p className="git-view-note">
        {graphStopped[result.reason]}{' '}
        <button type="button" className="git-graph-more" onClick={graph.retry}>
          다시 조회
        </button>
      </p>
    );
  return (
    <>
      <CommitList
        commits={result.commits}
        source={source}
        folder={folder}
        notice={notice}
        openFile={openFile}
      />
      {result.hasMore &&
        (graph.canLoadMore ? (
          <button type="button" className="git-graph-more" onClick={graph.loadMore}>
            더 불러오기
          </button>
        ) : (
          <p className="git-view-note">최근 {graphMax.toLocaleString()}개까지만 표시합니다.</p>
        ))}
      {error && <p className="git-view-note git-view-error">{error}</p>}
    </>
  );
}

function Tool({ icon, label, run }: { icon: IconName; label: string; run: () => void }) {
  return (
    <button type="button" className="git-view-tool" aria-label={label} title={label} onClick={run}>
      <Icon name={icon} size={14} />
    </button>
  );
}

/** The Git view's history (GE.14): read-only, and only asked for while it is open. */
export function CommitGraph({
  session,
  folder,
  version,
  notice,
  open,
  setOpen,
  actions,
  openFile,
}: {
  /** The parent remounts this per connection, so the source read here stays the right one. */
  session: TerminalSession;
  folder: string;
  version: string;
  notice: (text: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  actions: GitGraphActions;
  openFile: OpenCommitFile;
}) {
  const [source] = useState(() => sessionSource(session));
  const [scope, setScope] = useState(readScope);
  const body = useRef<HTMLDivElement>(null);
  if (!source) return null;
  const text = scopeText[scope];
  const toHead = () => {
    const head = body.current?.querySelector<HTMLElement>('[data-git-head]');
    head?.scrollIntoView({ block: 'center' });
    head?.focus({ preventScroll: true });
  };
  return (
    <section className="git-graph" data-open={open || undefined} aria-label="그래프">
      <div className="git-graph-head">
        <button
          type="button"
          className="git-group-head"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="git-row-chevron" data-folded={!open || undefined}>
            <Icon name="chevron" size={12} />
          </span>
          <span className="git-graph-title">그래프</span>
        </button>
        {open && (
          <div className="git-graph-tools" role="toolbar" aria-label="이력 작업">
            <button
              type="button"
              className="git-graph-scope"
              aria-label={`표시 범위 ${text.label}`}
              aria-pressed={scope === 'all'}
              title={text.title}
              onClick={() => {
                const next = scope === 'all' ? 'auto' : 'all';
                setScope(next);
                saveScope(next);
              }}
            >
              <Icon name="branch" size={13} />
              {text.label}
            </button>
            <Tool icon="target" label="현재 커밋으로 이동" run={toHead} />
            <Tool icon="gitFetch" label="fetch" run={actions.fetch} />
            <Tool icon="gitPull" label="pull" run={actions.pull} />
            <Tool icon="gitPush" label="push" run={actions.push} />
            <Tool icon="refresh" label="이력 새로 고침" run={actions.refresh} />
          </div>
        )}
      </div>
      {open && (
        <div ref={body} className="git-graph-body" onKeyDown={moveFocus}>
          <Body
            source={source}
            folder={folder}
            version={version}
            scope={scope}
            notice={notice}
            openFile={openFile}
          />
        </div>
      )}
    </section>
  );
}
