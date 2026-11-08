import { useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, type MenuPoint, type MenuRequest } from '../../components/ContextMenu';
import { ResizeHandle } from '../../components/ResizeHandle';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import { KubePodPanel } from './KubePodPanel';
import { LogAround } from './LogAround';
import { LogSearchForm } from './LogSearchForm';
import { LogSearchResults } from './LogSearchResults';
import {
  failureText,
  includedWords,
  podsInScope,
  rowText,
  scopeOptions,
  searchTargets,
  statusText,
  truncationNotes,
  type SearchRow,
} from './logSearchModel';
import type { PodPanelTab } from './podPanel';
import { shellTitle, type PodTerminalRequest } from './podShell';
import type { SnapshotStore } from './polling';
import { podViews } from './treePods';
import type { LogSearchHandle } from './useLogSearch';
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, usePanelWidth } from './usePanelWidth';
import { usePodShell } from './usePodShell';
import './logSearch.css';

const FOLLOW_TAIL = 500;

type Side =
  | { kind: 'around'; row: SearchRow }
  | { kind: 'pod'; namespace: string; name: string; problem: boolean; tab: PodPanelTab }
  | null;

/** Keywords across many pods, read on the server. The results live in the workspace's hook. */
export function LogSearch({
  search,
  store,
  connectionId,
  kube,
  session,
  focusRequest,
  openTerminal,
}: {
  search: LogSearchHandle;
  store: SnapshotStore;
  connectionId: string;
  kube: KubeSettings;
  session: string;
  /** Bumped when another screen sends a scope here, so the next thing to type is the keywords. */
  focusRequest: number;
  openTerminal: (request: PodTerminalRequest) => void;
}) {
  const { form, setForm, result, error, starting, start, cancel } = search;
  const [side, setSide] = useState<Side>(null);
  const [menu, setMenu] = useState<(MenuRequest & { label?: string }) | null>(null);
  const [notice, setNotice] = useState('');
  const { width, change } = usePanelWidth();
  const keywordBox = useRef<HTMLInputElement>(null);
  const openShell = usePodShell({
    connectionId,
    kube,
    session,
    openTerminal,
    notify: setNotice,
    openMenu: (request) => setMenu({ ...request, label: '파드 메뉴' }),
  });

  useEffect(() => {
    if (focusRequest) keywordBox.current?.focus();
  }, [focusRequest]);

  const pods = store.pods.data;
  const services = store.services.data;
  const options = useMemo(
    () => scopeOptions(form.scope.kind, pods ?? [], services ?? []),
    [form.scope.kind, pods, services],
  );
  const targets = useMemo(
    () =>
      searchTargets(podsInScope(form.scope, pods ?? [], services ?? []), {
        allContainers: form.allContainers,
        previous: form.previous,
      }),
    [form.scope, form.allContainers, form.previous, pods, services],
  );
  const since = form.since === 'custom' ? form.customSince.trim() : form.since;
  const running = result.phase === 'running';
  const ready =
    !running && !starting && targets.length > 0 && form.query.trim() !== '' && since !== '';
  const words = useMemo(() => includedWords(form.query), [form.query]);
  const notes = truncationNotes(result);

  const run = () => {
    if (!ready) return;
    setSide(null);
    setNotice('');
    void start(kube, targets, since, form.query);
  };

  const followKeywords = form.query.trim();
  const showPod = (row: SearchRow, tab: PodPanelTab) => {
    const view = podViews(
      store.pods.data ?? [],
      store.podUsage.data ?? [],
      store.services.data ?? [],
      store.pods.collectedAt ?? 0,
    ).find((item) => item.pod.namespace === row.namespace && item.pod.name === row.pod);
    setSide({
      kind: 'pod',
      namespace: row.namespace,
      name: row.pod,
      problem: view?.problem ?? false,
      tab,
    });
  };
  const rowMenu = (row: SearchRow, at: MenuPoint) =>
    setMenu({
      at,
      label: '결과 메뉴',
      items: [
        { label: '로그', run: () => showPod(row, 'logs') },
        {
          label: '셸',
          run: () => void openShell({ namespace: row.namespace, name: row.pod }, at, row.container),
        },
        {
          label: '이 키워드로 실시간 따라가기',
          disabled: !followKeywords,
          run: () =>
            openTerminal({
              launch: {
                kind: 'podLogs',
                connection: connectionId,
                kube,
                namespace: row.namespace,
                pod: row.pod,
                container: row.container,
                tail: FOLLOW_TAIL,
                keywords: followKeywords,
              },
              title: `${shellTitle(kube.context, row.pod)} 로그`,
              pod: { namespace: row.namespace, name: row.pod },
              overview: null,
            }),
        },
        {
          label: '이 줄 복사',
          separated: true,
          run: () => copy(rowText(row)),
        },
        {
          label: '결과 전체 복사',
          run: () => copy(result.rows.map(rowText).join('\n')),
        },
      ],
    });
  const copy = (text: string) =>
    void call('clipboard_write_text', { text }).catch((e: unknown) => setNotice(errorText(e)));

  const activeRow = side?.kind === 'around' ? side.row.id : null;
  const closeSide = () => setSide(null);
  return (
    <div className="kube-search" role="tabpanel" aria-label="로그 검색">
      <LogSearchForm
        form={form}
        setForm={setForm}
        session={session}
        options={options}
        targetCount={targets.length}
        running={running}
        ready={ready}
        run={run}
        cancel={cancel}
        keywordBox={keywordBox}
      />
      {notice && (
        <div className="kube-notice" role="alert">
          <span>{notice}</span>
          <button aria-label="안내 닫기" onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      <div className="kube-search-status" role="status">
        <span>{starting ? '검색을 시작하는 중…' : statusText(result)}</span>
        {result.concurrency !== null && (
          <span className="kube-search-narrowed">
            서버의 동시 세션 한도로 동시 검색을 {result.concurrency}개로 줄였습니다.
          </span>
        )}
        {error && <span className="kube-search-error">{error}</span>}
      </div>
      {notes.length > 0 && (
        <div className="kube-search-truncated" role="alert">
          <strong>결과가 잘렸습니다.</strong> {notes.join(' ')}
        </div>
      )}
      {result.failures.length > 0 && (
        <details className="kube-search-failures">
          <summary>검색하지 못한 대상 {result.failures.length}개</summary>
          <ul>
            {result.failures.map((failure, at) => (
              <li key={at}>{failureText(failure)}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="kube-split">
        <div className="kube-search-main">
          {result.rows.length === 0 && !running && !starting && (
            <p className="kube-tree-empty">
              {result.phase === 'finished'
                ? '검색 결과가 없습니다.'
                : '범위와 키워드를 입력한 뒤 검색하세요.'}
            </p>
          )}
          {(result.rows.length > 0 || running) && (
            <LogSearchResults
              rows={result.rows}
              words={words}
              descending={form.descending}
              byPod={form.byPod}
              activeId={activeRow}
              select={(row) => setSide({ kind: 'around', row })}
              menu={rowMenu}
              toggleOrder={() => setForm((now) => ({ ...now, descending: !now.descending }))}
            />
          )}
        </div>
        {side && (
          <>
            <ResizeHandle
              value={width}
              min={PANEL_MIN_WIDTH}
              max={PANEL_MAX_WIDTH}
              reverse
              onChange={change}
              label="패널 크기"
            />
            {side.kind === 'around' && (
              <LogAround
                key={side.row.id}
                connectionId={connectionId}
                kube={kube}
                row={side.row}
                count={form.around}
                words={words}
                close={closeSide}
                style={{ width: `min(${width}px, 70%)` }}
              />
            )}
            {side.kind === 'pod' && (
              <KubePodPanel
                key={`${side.namespace}/${side.name}`}
                connectionId={connectionId}
                kube={kube}
                session={session}
                target={side}
                store={store}
                style={{ width: `min(${width}px, 70%)` }}
                setTab={(tab) => setSide((now) => (now?.kind === 'pod' ? { ...now, tab } : now))}
                close={closeSide}
                openTerminal={openTerminal}
              />
            )}
          </>
        )}
      </div>
      {menu && (
        <ContextMenu
          label={menu.label ?? '결과 메뉴'}
          at={menu.at}
          items={menu.items}
          close={() => setMenu(null)}
        />
      )}
    </div>
  );
}
