import {
  memo,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from 'react';
import { anchorBelow, isMenuKey, type MenuPoint } from '../../components/ContextMenu';
import type { PodRef } from './detailTypes';
import { KubeTreeRow } from './KubeTreeRow';
import { kindNotes, stateNote, type SnapshotStore } from './polling';
import {
  buildForest,
  groupings,
  nextGrouping,
  nextSort,
  nodeSection,
  sortForest,
  treeRows,
  type Grouping,
  type SortColumn,
  type TreeRow,
  type TreeView,
} from './tree';
import { visibleRange } from './treeFormat';
import { leavesFilter, treeKeyAction } from './treeKeys';
import { filterActive, matches, parseFilter, podViews, type PodView } from './treePods';
import { readTreePrefs, writeTreePrefs } from './treePrefs';
import { planReveal } from './treeReveal';

const ROW_HEIGHT = 26;

export type PodAction = 'logs' | 'shell' | 'events' | 'detail' | 'menu';

const parentIndex = (rows: TreeRow[], index: number) => {
  for (let at = index - 1; at >= 0; at--) if (rows[at].depth < rows[index].depth) return at;
  return -1;
};

const foldable = (row: TreeRow) => row.type === 'group' || row.type === 'nodes';

/** Written as a separate component so it is only re-rendered when new data arrives. */
export const KubeTree = memo(function KubeTree({
  store,
  session,
  focused,
  view,
  setView,
  onPod,
  panelOpen,
  closePanel,
  focusPod,
  focusSignal,
}: {
  store: SnapshotStore;
  /** Which session this tree's folding and grouping are saved under. */
  session: string;
  focused: boolean;
  /** Held by the workspace, so coming back from another screen keeps the filter and selection. */
  view: TreeView;
  setView: Dispatch<SetStateAction<TreeView>>;
  onPod: (action: PodAction, view: PodView, at?: MenuPoint) => void;
  panelOpen: boolean;
  closePanel: () => void;
  /** A pod shell ended: put the cursor back on its pod. A new object asks again. */
  focusPod: PodRef | null;
  /** Bumped when something beside the tree closes and focus should come back. */
  focusSignal: number;
}) {
  const [{ grouping, collapsed }, setPrefs] = useState(() => {
    const saved = readTreePrefs(session);
    return { grouping: saved.grouping, collapsed: new Set(saved.collapsed) };
  });
  const [scroll, setScroll] = useState({ top: 0, height: 480 });
  const [openedAt] = useState(view.activeIndex);
  const body = useRef<HTMLDivElement>(null);
  const filterBox = useRef<HTMLInputElement>(null);
  const domId = useId();
  const scrollToActive = useRef(false);
  const { query, problemsOnly, sort } = view;

  useEffect(() => {
    writeTreePrefs(session, { grouping, collapsed: [...collapsed] });
  }, [session, grouping, collapsed]);

  // The keys work only with focus on the tree, so an opened or newly focused pane gives it focus.
  useEffect(() => {
    if (focused) body.current?.focus({ preventScroll: true });
  }, [focused, focusSignal]);

  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setScroll((now) => ({ ...now, height: element.clientHeight }));
    measure();
    element.scrollTop = Math.max(0, (openedAt + 2) * ROW_HEIGHT - element.clientHeight / 2);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [openedAt]);

  const { pods, podUsage, services, workloads, nodes, nodeUsage, events } = store;
  const metrics = podUsage.data !== null;
  const views = useMemo(
    () =>
      podViews(pods.data ?? [], podUsage.data ?? [], services.data ?? [], pods.collectedAt ?? 0),
    [pods.data, pods.collectedAt, podUsage.data, services.data],
  );
  const filter = useMemo(() => parseFilter(query, problemsOnly), [query, problemsOnly]);
  const matching = useMemo(() => views.filter((item) => matches(item, filter)), [views, filter]);
  const forest = useMemo(
    () => sortForest(buildForest(matching, grouping, workloads.data ?? [], nodes.data ?? []), sort),
    [matching, grouping, workloads.data, nodes.data, sort],
  );
  const section = useMemo(
    () => nodeSection(nodes.data, nodeUsage.data ?? [], views),
    [nodes.data, nodeUsage.data, views],
  );
  const searching = filter.include.length > 0 || filter.exclude.length > 0;
  // Grouped by node, the nodes are already the top level. A search is about pods.
  const shownSection =
    grouping === 'node' ||
    searching ||
    (filter.problemsOnly && section !== null && section.ready === section.total)
      ? null
      : section;
  const showAll = filterActive(filter);
  const rows = useMemo(
    () => treeRows(shownSection, forest, collapsed, showAll),
    [shownSection, forest, collapsed, showAll],
  );
  const found = rows.findIndex((row) => row.id === view.activeId);

  // Another screen sent the user to a row: open what hides it, select it, then bring it into view.
  useLayoutEffect(() => {
    if (!view.reveal) return;
    const plan = planReveal(view.reveal, {
      views,
      workloads: workloads.data ?? [],
      nodes: nodes.data ?? [],
      section,
      grouping,
      collapsed,
      filter,
    });
    if (plan) {
      setPrefs({ grouping: plan.grouping, collapsed: plan.collapsed });
      scrollToActive.current = true;
    }
    setView((now) => ({
      ...now,
      reveal: null,
      ...(plan && { activeId: plan.rowId }),
      ...(plan?.clearFilter && { query: '', problemsOnly: false }),
    }));
  }, [
    view.reveal,
    views,
    workloads.data,
    nodes.data,
    section,
    grouping,
    collapsed,
    filter,
    setView,
  ]);

  useLayoutEffect(() => {
    const element = body.current;
    if (!scrollToActive.current || found < 0 || !element) return;
    scrollToActive.current = false;
    element.scrollTop = Math.max(0, (found + 2) * ROW_HEIGHT - element.clientHeight / 2);
  }, [found, rows]);

  const activeIndex = Math.max(0, found >= 0 ? found : Math.min(view.activeIndex, rows.length - 1));
  const active = rows[activeIndex];
  const range = visibleRange(scroll.top, scroll.height, ROW_HEIGHT, rows.length);
  const rowDom = (index: number) => `${domId}-row-${index}`;

  const select = (index: number) => {
    const row = rows[index];
    if (row) setView((now) => ({ ...now, activeId: row.id, activeIndex: index }));
  };

  const goTo = (index: number) => {
    const target = Math.min(rows.length - 1, Math.max(0, index));
    if (!rows[target]) return;
    select(target);
    const element = body.current;
    if (!element) return;
    const top = (target + 1) * ROW_HEIGHT;
    if (top - ROW_HEIGHT < element.scrollTop) element.scrollTop = top - ROW_HEIGHT;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
  };

  const fold = (row: TreeRow) => {
    if (row.type !== 'group' && row.type !== 'nodes') return;
    // While a filter shows everything a folded group is open anyway, so a fold would do nothing.
    if (row.type === 'group' && showAll) return;
    setPrefs((now) => {
      const next = new Set(now.collapsed);
      if (!next.delete(row.toggle)) next.add(row.toggle);
      return { ...now, collapsed: next };
    });
  };

  const setGrouping = (next: Grouping) => setPrefs((now) => ({ ...now, grouping: next }));

  /** The selected pod if the filter kept it, otherwise the first result. */
  const toResults = () => {
    const firstPod = rows.findIndex((row) => row.type === 'pod');
    goTo(active?.type === 'pod' ? activeIndex : Math.max(0, firstPod));
    body.current?.focus({ preventScroll: true });
  };

  const jumpTo = useEffectEvent((pod: PodRef) => {
    const index = rows.findIndex(
      (row) =>
        row.type === 'pod' &&
        row.view.pod.namespace === pod.namespace &&
        row.view.pod.name === pod.name,
    );
    if (index >= 0) goTo(index);
    body.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (focusPod) jumpTo(focusPod);
  }, [focusPod]);

  const rowAnchor = () => {
    const element = document.getElementById(rowDom(activeIndex));
    return element ? anchorBelow(element) : undefined;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isMenuKey(event)) {
      if (active?.type !== 'pod') return;
      event.preventDefault();
      onPod('menu', active.view, rowAnchor());
      return;
    }
    const action = treeKeyAction(event);
    if (!action) return;
    event.preventDefault();
    if (action === 'close') {
      if (panelOpen) closePanel();
      return;
    }
    if (action === 'filter') {
      filterBox.current?.focus();
      filterBox.current?.select();
      return;
    }
    if (action === 'grouping') {
      setGrouping(nextGrouping(grouping));
      return;
    }
    if (!active) return;
    const page = Math.max(1, Math.floor(scroll.height / ROW_HEIGHT) - 1);
    const open = (active.type === 'group' || active.type === 'nodes') && active.expanded;
    const canFold = foldable(active) && !(active.type === 'group' && showAll);
    switch (action) {
      case 'down':
        return goTo(activeIndex + 1);
      case 'up':
        return goTo(activeIndex - 1);
      case 'home':
        return goTo(0);
      case 'end':
        return goTo(rows.length - 1);
      case 'pageDown':
        return goTo(activeIndex + page);
      case 'pageUp':
        return goTo(activeIndex - page);
      case 'expand':
        if (open) goTo(activeIndex + 1);
        else fold(active);
        return;
      case 'collapse':
        if (open && canFold) fold(active);
        else if (parentIndex(rows, activeIndex) >= 0) goTo(parentIndex(rows, activeIndex));
        return;
      case 'activate':
        if (active.type === 'pod') onPod('logs', active.view);
        else fold(active);
        return;
      case 'shell':
        if (active.type === 'pod') onPod('shell', active.view, rowAnchor());
        return;
      case 'events':
        if (active.type === 'pod') onPod('events', active.view);
        return;
    }
  };

  const notes = kindNotes(store);
  const failing = pods.state && pods.state.kind !== 'ready' ? stateNote(pods.state) : '';
  const empty =
    pods.data === null
      ? failing || '조회 중…'
      : pods.data.length === 0
        ? '파드가 없습니다.'
        : forest.length === 0
          ? '조건에 맞는 파드가 없습니다.'
          : '';

  const column = (id: SortColumn, title: string) => (
    <span
      className="kube-tree-sort"
      onClick={() => setView((now) => ({ ...now, sort: nextSort(now.sort, id) }))}
    >
      {title}
      {sort.column === id && (sort.descending ? ' ↓' : ' ↑')}
    </span>
  );

  return (
    <div className="kube-tree" role="tabpanel" aria-label="트리">
      <div className="kube-tree-tools">
        <select
          aria-label="묶기"
          value={grouping}
          onChange={(event) => setGrouping(event.target.value as Grouping)}
        >
          {groupings.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <input
          ref={filterBox}
          type="search"
          aria-label="파드 필터"
          placeholder="/ 필터: 공백은 AND, !단어는 제외"
          value={query}
          onChange={(event) => {
            const value = event.target.value;
            setView((now) => ({ ...now, query: value }));
          }}
          onKeyDown={(event) => {
            if (!leavesFilter({ code: event.code, isComposing: event.nativeEvent.isComposing }))
              return;
            event.preventDefault();
            toResults();
          }}
        />
        <label className="kube-tree-problems">
          <input
            type="checkbox"
            checked={problemsOnly}
            onChange={(event) => {
              const checked = event.target.checked;
              setView((now) => ({ ...now, problemsOnly: checked }));
            }}
          />
          문제만
        </label>
        <span className="kube-tree-summary">
          {pods.data && `${matching.length} / ${pods.data.length}개`}
          {events.data && ` · 경고 ${events.data.length}`}
        </span>
      </div>
      {(failing || notes.length > 0) && pods.data !== null && (
        <div className="kube-tree-notes" role="status">
          {failing && (
            <span className="kube-tree-stale">마지막으로 받은 데이터입니다. {failing}</span>
          )}
          {notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </div>
      )}
      <div
        ref={body}
        className={`kube-tree-body ${failing ? 'stale' : ''}`}
        role="tree"
        aria-label="클러스터 트리"
        aria-activedescendant={active ? rowDom(activeIndex) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          setScroll((now) => (now.top === top ? now : { ...now, top }));
        }}
      >
        <div className="kube-tree-row kube-tree-head" aria-hidden="true">
          {column('name', '이름')}
          {column('status', '상태')}
          {column('ready', '준비')}
          {column('restarts', '재시작')}
          {column('cpu', metrics ? 'CPU' : 'CPU 요청/제한')}
          {column('memory', metrics ? '메모리' : '메모리 요청/제한')}
          {column('node', '노드')}
          <span>워커</span>
          {column('age', '나이')}
        </div>
        {empty && <p className="kube-tree-empty">{empty}</p>}
        {!empty && (
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            {rows.slice(range.first, range.last).map((row, offset) => {
              const index = range.first + offset;
              return (
                <KubeTreeRow
                  key={row.id}
                  row={row}
                  domId={rowDom(index)}
                  index={index}
                  top={index * ROW_HEIGHT}
                  count={rows.length}
                  active={row.id === active?.id}
                  metrics={metrics}
                  now={pods.collectedAt ?? 0}
                  select={() => select(index)}
                  fold={() => fold(row)}
                  open={row.type === 'pod' ? () => onPod('logs', row.view) : undefined}
                  menu={
                    row.type === 'pod'
                      ? (at) => {
                          select(index);
                          onPod('menu', row.view, at);
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
