import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  anchorBelow,
  ContextMenu,
  isMenuKey,
  type MenuItem,
  type MenuPoint,
} from '../../components/ContextMenu';
import { call, errorText } from '../../lib/ipc';
import type { Source } from '../../lib/source';
import { CommitGraphDetail, CommitGraphLanes, CommitRefPill } from './CommitGraphParts';
import { CommitHoverCard } from './CommitHoverCard';
import {
  graphStep,
  layoutGraph,
  rowRefs,
  type CommitFileOrigin,
  type GraphCommit,
  type GraphRef,
  type GraphRow,
} from './commitGraphModel';
import type { DiffFile } from './gitDiff';
import { repoFilePath } from './gitViewModel';
import { useCommitDetail, type DetailState } from './useCommitGraph';
import { useCommitHover } from './useCommitHover';

const maxPills = 3;

function RefPills({ refs }: { refs: GraphRef[] }) {
  if (!refs.length) return null;
  const pills = rowRefs(refs);
  const rest = pills.slice(maxPills);
  return (
    <span className="git-graph-refs">
      {pills.slice(0, maxPills).map((pill) => (
        <CommitRefPill
          key={`${pill.item.kind}:${pill.item.name}`}
          item={pill.item}
          remote={pill.remote}
          named={pill.named}
        />
      ))}
      {rest.length > 0 && (
        <span className="git-graph-ref" title={rest.map((pill) => pill.item.name).join(', ')}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

type RowHandlers = {
  toggle: (hash: string) => void;
  commitMenu: (commit: GraphCommit, at: MenuPoint | HTMLElement) => void;
  hoverStart: (commit: GraphCommit, element: HTMLElement) => void;
  hoverEnd: () => void;
  hoverClose: () => void;
  openFile: (file: DiffFile, commit: GraphCommit, pinned: boolean) => void;
  fileMenu: (file: DiffFile, at: MenuPoint | HTMLElement) => void;
};

function Row({
  commit,
  row,
  columns,
  step,
  first,
  opened,
  detail,
  on,
}: {
  commit: GraphCommit;
  row: GraphRow;
  columns: number;
  step: number;
  first: boolean;
  opened: boolean;
  detail: DetailState | undefined;
  on: RowHandlers;
}) {
  const current = commit.refs.some((item) => item.current);
  return (
    <li>
      <div
        className="git-graph-row"
        data-git-row=""
        data-git-head={current || undefined}
        role="button"
        aria-expanded={opened}
        tabIndex={first ? 0 : -1}
        onClick={() => {
          on.hoverClose();
          on.toggle(commit.hash);
        }}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          on.hoverClose();
          on.commitMenu(commit, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (isMenuKey(event)) {
            event.preventDefault();
            on.hoverClose();
            on.commitMenu(commit, event.currentTarget);
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            on.hoverClose();
            on.toggle(commit.hash);
          }
        }}
        onPointerEnter={(event) => on.hoverStart(commit, event.currentTarget)}
        onPointerLeave={on.hoverEnd}
        onFocus={(event) => {
          // A mouse has already asked by hovering; this is for the arrow keys.
          if (event.currentTarget.matches(':focus-visible'))
            on.hoverStart(commit, event.currentTarget);
        }}
        onBlur={on.hoverEnd}
      >
        <CommitGraphLanes row={row} columns={columns} step={step} current={current} />
        <span className="git-graph-subject">{commit.subject}</span>
        <RefPills refs={commit.refs} />
      </div>
      {opened && (
        <CommitGraphDetail
          row={row}
          columns={columns}
          step={step}
          state={detail}
          open={(file, pinned) => on.openFile(file, commit, pinned)}
          menu={on.fileMenu}
        />
      )}
    </li>
  );
}

type OpenMenu = { at: MenuPoint; label: string; items: MenuItem[] };

/** The commits, each opening to the files it changed. A file opens the commit's diff in a tab. */
export function CommitList({
  commits,
  source,
  folder,
  notice,
  openFile,
}: {
  commits: GraphCommit[];
  source: Source;
  folder: string;
  notice: (text: string) => void;
  openFile: (file: DiffFile, origin: CommitFileOrigin, pinned: boolean) => void;
}) {
  const { rows, columns } = useMemo(() => layoutGraph(commits), [commits]);
  const step = graphStep(columns);
  const { opened, details, toggle, load } = useCommitDetail(source, folder);
  const { hover, show, keep, hide, close } = useCommitHover<GraphCommit>();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const hovered = hover?.item.hash;
  useEffect(() => {
    if (hovered) load(hovered);
  }, [hovered, load]);
  // A listener and not a prop: a re-render per scroll event is too much for a thousand rows.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const scroller = list.current?.closest('.git-graph-body');
    scroller?.addEventListener('scroll', close, { passive: true });
    return () => scroller?.removeEventListener('scroll', close);
  }, [close]);

  const copy = (text: string) =>
    void call('clipboard_write_text', { text }).catch((e) => notice(errorText(e)));
  const point = (at: MenuPoint | HTMLElement) => (at instanceof HTMLElement ? anchorBelow(at) : at);
  const originOf = (commit: GraphCommit): CommitFileOrigin => ({
    hash: commit.hash,
    parent: commit.parents[0] ?? null,
  });
  const openedCommit = commits.find((commit) => commit.hash === opened);
  const on: RowHandlers = {
    toggle,
    commitMenu: (commit, at) =>
      setMenu({
        at: point(at),
        label: `${commit.subject} 작업`,
        items: [
          { label: '해시 복사', run: () => copy(commit.hash) },
          { label: '제목 복사', run: () => copy(commit.subject) },
        ],
      }),
    hoverStart: show,
    hoverEnd: hide,
    hoverClose: close,
    openFile: (file, commit, pinned) => openFile(file, originOf(commit), pinned),
    fileMenu: (file, at) =>
      setMenu({
        at: point(at),
        label: `${file.path} 작업`,
        items: [
          {
            label: 'diff 고정해서 열기',
            disabled: !file.readable || !openedCommit,
            run: () => openedCommit && openFile(file, originOf(openedCommit), true),
          },
          {
            label: '경로 복사',
            disabled: !file.readable,
            run: () => copy(repoFilePath(folder, file.path)),
          },
        ],
      }),
  };
  return (
    <>
      <ul className="git-list" ref={list}>
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
            on={on}
          />
        ))}
      </ul>
      {menu && (
        <ContextMenu
          at={menu.at}
          label={menu.label}
          close={() => setMenu(null)}
          items={menu.items}
        />
      )}
      {hover && (
        <CommitHoverCard
          key={hover.item.hash}
          commit={hover.item}
          rect={hover.rect}
          state={details.get(hover.item.hash)}
          copy={copy}
          keep={keep}
          hide={hide}
          close={close}
        />
      )}
    </>
  );
}
