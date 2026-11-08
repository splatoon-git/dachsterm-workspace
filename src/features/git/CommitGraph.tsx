import { useMemo, useState, type MouseEvent } from 'react';
import { ContextMenu, isMenuKey, anchorBelow, type MenuPoint } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { call, errorText } from '../../lib/ipc';
import type { Source } from '../../lib/source';
import { sessionSource } from '../terminal/sessionKind';
import type { TerminalSession } from '../terminal/session';
import { CommitGraphDetail, CommitGraphLanes } from './CommitGraphParts';
import {
  graphMax,
  graphStep,
  graphStopped,
  layoutGraph,
  type GraphCommit,
  type GraphRef,
  type GraphRow,
} from './commitGraphModel';
import { moveFocus } from './GitViewList';
import { useCommitDetail, useCommitGraph, type DetailState } from './useCommitGraph';
import './commitGraph.css';

const openKey = 'dachsterm.gitView.graph';
function readOpen() {
  try {
    return localStorage.getItem(openKey) !== 'false';
  } catch {
    // Storage can be blocked; the section is open by default.
    return true;
  }
}
function saveOpen(open: boolean) {
  try {
    localStorage.setItem(openKey, String(open));
  } catch {
    // Storage can be blocked; the section simply is not remembered.
  }
}

const refLabel: Record<GraphRef['kind'], string> = {
  head: '분리된 HEAD',
  branch: '브랜치',
  remote: '원격 브랜치',
  tag: '태그',
};
const maxBadges = 3;

function RefBadges({ refs }: { refs: GraphRef[] }) {
  if (!refs.length) return null;
  const rest = refs.slice(maxBadges);
  return (
    <span className="git-graph-refs">
      {refs.slice(0, maxBadges).map((item) => (
        <span
          key={`${item.kind}:${item.name}`}
          className="git-graph-ref"
          data-kind={item.kind}
          data-current={item.current || undefined}
          title={`${refLabel[item.kind]} ${item.name}`}
        >
          {item.name}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="git-graph-ref" title={rest.map((item) => item.name).join(', ')}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

const time = (seconds: number) => new Date(seconds * 1000).toLocaleString();

function Row({
  commit,
  row,
  columns,
  step,
  first,
  opened,
  detail,
  toggle,
  menu,
}: {
  commit: GraphCommit;
  row: GraphRow;
  columns: number;
  step: number;
  first: boolean;
  opened: boolean;
  detail: DetailState | undefined;
  toggle: (hash: string) => void;
  menu: (commit: GraphCommit, at: MenuPoint | HTMLElement) => void;
}) {
  return (
    <li>
      <div
        className="git-graph-row"
        data-git-row=""
        role="button"
        aria-expanded={opened}
        tabIndex={first ? 0 : -1}
        title={`${commit.hash.slice(0, 7)} · ${commit.author} · ${time(commit.time)}\n${commit.subject}`}
        onClick={() => toggle(commit.hash)}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          menu(commit, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (isMenuKey(event)) {
            event.preventDefault();
            menu(commit, event.currentTarget);
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle(commit.hash);
          }
        }}
      >
        <CommitGraphLanes
          row={row}
          columns={columns}
          step={step}
          current={commit.refs.some((item) => item.current)}
        />
        <span className="git-graph-subject">{commit.subject}</span>
        <RefBadges refs={commit.refs} />
      </div>
      {opened && <CommitGraphDetail row={row} columns={columns} step={step} state={detail} />}
    </li>
  );
}

function CommitList({
  commits,
  source,
  folder,
  notice,
}: {
  commits: GraphCommit[];
  source: Source;
  folder: string;
  notice: (text: string) => void;
}) {
  const { rows, columns } = useMemo(() => layoutGraph(commits), [commits]);
  const step = graphStep(columns);
  const { opened, details, toggle } = useCommitDetail(source, folder);
  const [menuAt, setMenuAt] = useState<{ at: MenuPoint; commit: GraphCommit } | null>(null);
  const copy = (text: string) =>
    void call('clipboard_write_text', { text }).catch((e) => notice(errorText(e)));
  return (
    <>
      <ul className="git-list">
        {commits.map((commit, index) => (
          <Row
            key={commit.hash}
            commit={commit}
            row={rows[index]!}
            columns={columns}
            step={step}
            first={index === 0}
            opened={opened === commit.hash}
            detail={details.get(commit.hash)}
            toggle={toggle}
            menu={(target, at) =>
              setMenuAt({
                at: at instanceof HTMLElement ? anchorBelow(at) : at,
                commit: target,
              })
            }
          />
        ))}
      </ul>
      {menuAt && (
        <ContextMenu
          at={menuAt.at}
          label={`${menuAt.commit.subject} 작업`}
          close={() => setMenuAt(null)}
          items={[
            { label: '해시 복사', run: () => copy(menuAt.commit.hash) },
            { label: '제목 복사', run: () => copy(menuAt.commit.subject) },
          ]}
        />
      )}
    </>
  );
}

function Body({
  source,
  folder,
  version,
  notice,
}: {
  source: Source;
  folder: string;
  version: string;
  notice: (text: string) => void;
}) {
  const graph = useCommitGraph({ source, folder, version });
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
      <CommitList commits={result.commits} source={source} folder={folder} notice={notice} />
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

/** The Git view's history (GE.14): read-only, and only asked for while it is open. */
export function CommitGraph({
  session,
  folder,
  version,
  notice,
}: {
  /** The parent remounts this per connection, so the source read here stays the right one. */
  session: TerminalSession;
  folder: string;
  version: string;
  notice: (text: string) => void;
}) {
  const [open, setOpen] = useState(readOpen);
  const [source] = useState(() => sessionSource(session));
  if (!source) return null;
  return (
    <section className="git-graph" data-open={open || undefined} aria-label="그래프">
      <button
        type="button"
        className="git-group-head"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          saveOpen(!open);
        }}
      >
        <span className="git-row-chevron" data-folded={!open || undefined}>
          <Icon name="chevron" size={12} />
        </span>
        <span className="git-graph-title">그래프</span>
      </button>
      {open && (
        <div className="git-graph-body" onKeyDown={moveFocus}>
          <Body source={source} folder={folder} version={version} notice={notice} />
        </div>
      )}
    </section>
  );
}
