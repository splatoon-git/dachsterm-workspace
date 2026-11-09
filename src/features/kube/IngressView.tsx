import { useMemo, useState, type Dispatch, type MouseEvent, type SetStateAction } from 'react';
import { ContextMenu, type MenuItem, type MenuRequest } from '../../components/ContextMenu';
import {
  backendPods,
  backendTarget,
  checkNotes,
  filterHostGroups,
  formatLatency,
  formatRate,
  formatShare,
  hostGroups,
  hostKeyword,
  trafficNote,
  upstreamKeyword,
  type HostGroup,
  type HostRate,
  type IngressData,
  type PathRow,
} from './ingressModel';
import { stateNote, type SnapshotStore } from './polling';
import { statusMark } from './treeFormat';
import type { TreeTarget } from './treeReveal';
import './ingress.css';

const MAX_POD_ITEMS = 8;

const BACKEND_TEXT: Record<PathRow['rule']['backend'], string> = {
  ok: '',
  noService: '서비스 없음',
  noReady: '준비 0',
  external: '외부',
  unchecked: '미확인',
};

const basisTitle = (rate: HostRate | null) =>
  rate?.basis === 'recent'
    ? '지난 조회 이후'
    : rate?.basis === 'total'
      ? '컨트롤러 시작 이후 누적'
      : '';

function HostRow({
  group,
  onClick,
  onMenu,
}: {
  group: HostGroup;
  onClick: () => void;
  onMenu: (event: MouseEvent) => void;
}) {
  const { rate } = group;
  const title = basisTitle(rate);
  return (
    <button className="kube-ingress-row host" onClick={onClick} onContextMenu={onMenu}>
      <span className="kube-ingress-name">
        <span className={`kube-health ${group.health}`} aria-hidden="true">
          {statusMark[group.health]}
        </span>{' '}
        {group.label}
      </span>
      <span>{formatRate(rate?.perSecond ?? null)}</span>
      <span title={title}>{formatShare(rate?.ok ?? null)}</span>
      <span title={title}>{formatShare(rate?.clientError ?? null)}</span>
      <span title={title} className={rate?.serverError ? 'kube-ingress-bad' : ''}>
        {formatShare(rate?.serverError ?? null)}
      </span>
      <span title={title}>{formatLatency(rate?.latencyMs ?? null)}</span>
      <span className="kube-ingress-problem" title={group.problems.join(', ')}>
        {group.problems.join(', ')}
      </span>
    </button>
  );
}

function PathLine({
  row,
  onClick,
  onMenu,
}: {
  row: PathRow;
  onClick: () => void;
  onMenu: (event: MouseEvent) => void;
}) {
  const { rule } = row;
  const backend = rule.service ? `${rule.service}:${rule.port}` : '리소스 백엔드';
  const readiness =
    rule.backend === 'ok'
      ? `준비 ${rule.readyEndpoints}${rule.notReadyEndpoints ? ` (대기 ${rule.notReadyEndpoints})` : ''}`
      : BACKEND_TEXT[rule.backend];
  return (
    <button className="kube-ingress-row path" onClick={onClick} onContextMenu={onMenu}>
      <span className="kube-ingress-name" title={rule.pathType}>
        {rule.isDefault ? '(기본 백엔드)' : rule.path || '/'}
      </span>
      <span className="kube-ingress-name" title={backend}>
        → {backend}
      </span>
      <span className={rule.backend === 'ok' ? '' : 'kube-ingress-bad'}>{readiness}</span>
      <span className="kube-ingress-name" title={`${row.namespace}/${row.ingress}`}>
        {row.namespace}/{row.ingress}
      </span>
      <span>{row.className || '클래스 없음'}</span>
      <span className="kube-ingress-name" title={row.addresses.join(', ')}>
        {row.addresses.join(', ') || '주소 없음'}
      </span>
      <span>{row.tls ? 'TLS' : ''}</span>
    </button>
  );
}

/** Configuration of every Ingress, and per-host traffic when ingress-nginx's metrics can be read. */
export function IngressView({
  data,
  store,
  filter,
  setFilter,
  reveal,
  searchController,
  openFlow,
}: {
  data: IngressData;
  store: SnapshotStore;
  filter: string;
  setFilter: Dispatch<SetStateAction<string>>;
  reveal: (target: TreeTarget) => void;
  searchController: (keyword: string) => void;
  openFlow: (rows: PathRow[]) => void;
}) {
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const groups = useMemo(() => hostGroups(data), [data]);
  const shown = useMemo(
    () => filterHostGroups(groups, filter, problemsOnly),
    [groups, filter, problemsOnly],
  );

  const hasController = data.controllers.length > 0;
  // The default access log has no host in it, only the upstream name, so both are offered.
  const searchItems = (host: string, rows: PathRow[]): MenuItem[] => [
    {
      label: `컨트롤러 로그 검색: ${host || '호스트 없음'}`,
      separated: true,
      disabled: !hasController || !host,
      run: () => searchController(hostKeyword(host)),
    },
    ...[...new Set(rows.filter((row) => row.rule.service).map(upstreamKeyword))]
      .slice(0, MAX_POD_ITEMS)
      .map((keyword) => ({
        label: `컨트롤러 로그 검색: ${keyword}`,
        disabled: !hasController,
        run: () => searchController(keyword),
      })),
  ];

  const flowItem = (rows: PathRow[]): MenuItem => ({
    label: '요청 흐름 실시간 보기',
    disabled: !rows.some((row) => row.rule.service),
    run: () => openFlow(rows),
  });

  const podItems = (row: PathRow): MenuItem[] =>
    backendPods(row, store)
      .slice(0, MAX_POD_ITEMS)
      .map((pod) => ({
        label: `파드로 이동: ${pod.name}`,
        run: () => reveal({ type: 'pod', namespace: pod.namespace, name: pod.name }),
      }));

  const openMenu = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    setMenu({ at: { x: event.clientX, y: event.clientY }, items });
  };

  const troubled = (group: HostGroup) =>
    group.paths.find((row) => row.problems.length) ?? group.paths[0];
  const notes = checkNotes(data);
  const note = trafficNote(data);
  const failure = data.state && data.state.kind !== 'ready' ? stateNote(data.state) : '';

  if (data.ingresses === null)
    return (
      <div className="kube-ingress" role="tabpanel" aria-label="인그레스">
        <p className="kube-tree-empty">{failure || '조회 중…'}</p>
      </div>
    );
  return (
    <div className="kube-ingress" role="tabpanel" aria-label="인그레스">
      <div className="kube-ingress-tools">
        <input
          type="search"
          aria-label="인그레스 필터"
          placeholder="호스트, 경로, 백엔드 필터"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={problemsOnly}
            onChange={(event) => setProblemsOnly(event.target.checked)}
          />
          문제만
        </label>
        {failure && (
          <span className="kube-ingress-stale">마지막으로 받은 데이터입니다. {failure}</span>
        )}
      </div>
      {note && (
        <p className="kube-ingress-note" role="status">
          {note}
        </p>
      )}
      {notes.map((text) => (
        <p key={text} className="kube-ingress-note">
          {text}
        </p>
      ))}
      {shown.length === 0 ? (
        <p className="kube-tree-empty">
          {groups.length ? '조건에 맞는 항목이 없습니다.' : '인그레스가 없습니다.'}
        </p>
      ) : (
        <div className="kube-ingress-table">
          <div className="kube-ingress-row host head" aria-hidden="true">
            <span>호스트</span>
            <span>요청/s</span>
            <span>2xx</span>
            <span>4xx</span>
            <span>5xx</span>
            <span>평균 지연</span>
            <span>문제</span>
          </div>
          <ul className="kube-ingress-list" aria-label="호스트">
            {shown.map((group) => (
              <li key={group.label}>
                <HostRow
                  group={group}
                  onClick={() => reveal(backendTarget(troubled(group), store))}
                  onMenu={(event) =>
                    openMenu(event, [
                      flowItem(group.paths),
                      ...podItems(troubled(group)),
                      ...searchItems(group.host, group.paths),
                    ])
                  }
                />
                {group.paths.some((row) => row.rule.service) && (
                  <button
                    className="kube-ingress-flow"
                    title="컨트롤러 로그와 뒤쪽 파드 로그를 함께 봅니다"
                    onClick={() => openFlow(group.paths)}
                  >
                    요청 흐름
                  </button>
                )}
                <ul>
                  {group.paths.map((row) => (
                    <li key={row.key}>
                      <PathLine
                        row={row}
                        onClick={() => reveal(backendTarget(row, store))}
                        onMenu={(event) =>
                          openMenu(event, [
                            flowItem([row]),
                            ...podItems(row),
                            ...searchItems(group.host, [row]),
                          ])
                        }
                      />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
      {menu && (
        <ContextMenu
          label="인그레스 메뉴"
          at={menu.at}
          items={menu.items}
          close={() => setMenu(null)}
        />
      )}
    </div>
  );
}
