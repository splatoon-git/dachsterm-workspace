import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { ContextMenu, type MenuPoint, type MenuRequest } from '../../components/ContextMenu';
import { MetricChart } from '../../components/MetricChart';
import { ItemRow, TargetMenu } from './DashboardRows';
import type { PodRef } from './detailTypes';
import { WorkerPanel } from './WorkerPanel';
import { IngressPanel } from './IngressPanel';
import {
  buildDashboard,
  share,
  type Amount,
  type Capped,
  type NodeBar,
  type Part,
  type Resources,
  type TopRow,
} from './dashboard';
import type { DashboardHistory } from './dashboardHistory';
import type { IngressData } from './ingressModel';
import { scopeOfTarget, type SearchScope } from './logSearchModel';
import { ageAgo, type SnapshotStore } from './polling';
import { formatCpu, formatMemory, statusMark } from './treeFormat';
import type { Health } from './treePods';
import type { TreeTarget } from './treeReveal';
import './kubeDashboard.css';

const NO_PROBLEM = '문제 없음';

type Format = (value: number) => string;

const Mark = ({ health }: { health: Health }) => (
  <span className={`kube-health ${health}`} aria-hidden="true">
    {statusMark[health]}
  </span>
);

function Panel<T>({
  title,
  part,
  wide,
  children,
}: {
  title: string;
  part: Part<T>;
  wide?: boolean;
  children: (value: T) => ReactNode;
}) {
  return (
    <section className={`kube-dash-panel ${wide ? 'wide' : ''}`} aria-label={title}>
      <h3>{title}</h3>
      {part.state === 'ready' ? (
        children(part.value)
      ) : (
        <p className="kube-dash-empty">{part.state === 'waiting' ? '조회 중…' : part.reason}</p>
      )}
    </section>
  );
}

function Rows<T>({
  list,
  empty,
  children,
}: {
  list: Capped<T>;
  empty: string;
  children: (item: T) => ReactNode;
}) {
  if (!list.items.length) return <p className="kube-dash-empty">{empty}</p>;
  return (
    <>
      <ul className="kube-dash-list">{list.items.map(children)}</ul>
      {list.more > 0 && <p className="kube-dash-more">외 {list.more}개</p>}
    </>
  );
}

function Meter({ amount }: { amount: Amount }) {
  const fill = share(amount.used ?? amount.requested, amount.allocatable) ?? 0;
  const mark = amount.used === null ? null : share(amount.requested, amount.allocatable);
  return (
    <span className="kube-dash-meter" aria-hidden="true">
      <span className="kube-dash-meter-fill" style={{ width: `${Math.min(100, fill)}%` }} />
      {mark !== null && (
        <span className="kube-dash-meter-mark" style={{ left: `${Math.min(100, mark)}%` }} />
      )}
    </span>
  );
}

function amountText(amount: Amount, format: Format) {
  const text = (value: number | null) => (value === null ? '-' : format(value));
  const percent = (value: number | null) => {
    const ratio = share(value, amount.allocatable);
    return ratio === null ? '' : ` (${ratio}%)`;
  };
  return [
    amount.used !== null && `사용 ${text(amount.used)}${percent(amount.used)}`,
    `요청 ${text(amount.requested)}${percent(amount.requested)}`,
    `할당 ${text(amount.allocatable)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function Total({ label, amount, format }: { label: string; amount: Amount; format: Format }) {
  return (
    <div className="kube-dash-total">
      <strong>{label}</strong>
      <Meter amount={amount} />
      <span>{amountText(amount, format)}</span>
    </div>
  );
}

function NodeRow({ bar, reveal }: { bar: NodeBar; reveal: (target: TreeTarget) => void }) {
  return (
    <li>
      <ItemRow target={{ type: 'node', name: bar.name }} reveal={reveal} className="node">
        <span className="kube-dash-name">
          <Mark health={bar.health} /> {bar.name}
          {bar.health !== 'ok' && <small> {bar.status}</small>}
        </span>
        <Meter amount={bar.cpu} />
        <span title={amountText(bar.cpu, formatCpu)}>
          CPU {share(bar.cpu.used ?? bar.cpu.requested, bar.cpu.allocatable) ?? '-'}%
        </span>
        <Meter amount={bar.memory} />
        <span title={amountText(bar.memory, formatMemory)}>
          메모리 {share(bar.memory.used ?? bar.memory.requested, bar.memory.allocatable) ?? '-'}%
        </span>
      </ItemRow>
    </li>
  );
}

function ResourcesBody({
  value,
  scope,
  usageNote,
  cpu,
  memory,
  reveal,
}: {
  value: Resources;
  scope: string;
  usageNote: string;
  cpu: (number | null)[];
  memory: (number | null)[];
  reveal: (target: TreeTarget) => void;
}) {
  return (
    <>
      <Total label="CPU" amount={value.cpu} format={formatCpu} />
      <Total label="메모리" amount={value.memory} format={formatMemory} />
      {scope && <p className="kube-dash-note">요청량은 {scope} namespace만 합산합니다.</p>}
      {usageNote && <p className="kube-dash-note">{usageNote}</p>}
      {!usageNote && (
        <div className="kube-dash-trend">
          <MetricChart label="CPU 추세" values={cpu} unit="%" max={100} color={1} />
          <MetricChart label="메모리 추세" values={memory} unit="%" max={100} color={2} />
        </div>
      )}
      <Rows list={value.nodes} empty="노드가 없습니다.">
        {(bar) => <NodeRow key={bar.name} bar={bar} reveal={reveal} />}
      </Rows>
    </>
  );
}

function TopColumn({
  title,
  rows,
  format,
  reveal,
}: {
  title: string;
  rows: TopRow[];
  format: Format;
  reveal: (target: TreeTarget) => void;
}) {
  return (
    <div>
      <h4>{title}</h4>
      <Rows list={{ items: rows, more: 0 }} empty="해당 파드 없음">
        {(row) => (
          <li key={row.key}>
            <ItemRow target={row.target} reveal={reveal} className="top">
              <span className="kube-dash-name" title={`${row.namespace}/${row.name}`}>
                {row.name}
              </span>
              <span>{format(row.value)}</span>
              <span title="제한 대비">
                {row.ofLimit === null ? '제한 없음' : `${row.ofLimit}%`}
              </span>
            </ItemRow>
          </li>
        )}
      </Rows>
    </div>
  );
}

/** Reads only what the tree already polls, so opening this screen adds no query to the cluster. */
export const KubeDashboard = memo(function KubeDashboard({
  store,
  history,
  namespace,
  reveal,
  searchLogs,
  openRuntime,
  ingress,
  openIngress,
}: {
  store: SnapshotStore;
  history: DashboardHistory;
  ingress: IngressData;
  openIngress: (host: string) => void;
  /** The session's namespace, empty for all. Nodes are cluster-wide even when this is set. */
  namespace: string;
  reveal: (target: TreeTarget) => void;
  searchLogs: (scope: SearchScope) => void;
  openRuntime: (pod: PodRef) => void;
}) {
  const board = useMemo(() => buildDashboard(store, history), [store, history]);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const targetMenu = useCallback(
    (target: TreeTarget, at: MenuPoint) => {
      const scope = scopeOfTarget(target);
      setMenu({
        at,
        items: [
          { label: '트리에서 보기', run: () => reveal(target) },
          ...(scope ? [{ label: '로그 검색', run: () => searchLogs(scope) }] : []),
        ],
      });
    },
    [reveal, searchLogs],
  );
  return (
    <TargetMenu.Provider value={targetMenu}>
      <div className="kube-dash" role="tabpanel" aria-label="대시보드">
        {board.stale && (
          <p className="kube-dash-stale" role="status">
            마지막으로 받은 데이터입니다. {board.stale}
          </p>
        )}
        <div className="kube-dash-grid">
          <Panel title="전체 자원" part={board.resources} wide>
            {(value) => (
              <ResourcesBody
                value={value}
                scope={namespace}
                usageNote={board.usageNote}
                cpu={history.trend.map((sample) => sample.cpu)}
                memory={history.trend.map((sample) => sample.memory)}
                reveal={reveal}
              />
            )}
          </Panel>

          <section className="kube-dash-panel" aria-label="현황">
            <h3>현황</h3>
            <dl className="kube-dash-counts">
              <dt>노드</dt>
              <dd>{partText(board.nodes, (v) => `${v.ready}/${v.total} 준비`)}</dd>
              <dt>파드</dt>
              <dd>
                {partText(board.pods, (v) => (
                  <>
                    {v.total}개
                    {v.statuses.map((item) => (
                      <span key={item.status} className="kube-dash-chip">
                        <Mark health={item.health} /> {item.status} {item.count}
                      </span>
                    ))}
                  </>
                ))}
              </dd>
              <dt>워크로드</dt>
              <dd>
                {partText(board.workloads, (list) =>
                  list.length
                    ? list.map((item) => (
                        <span key={item.kind} className="kube-dash-chip">
                          {item.kind} {item.ready}/{item.total}
                        </span>
                      ))
                    : '없음',
                )}
              </dd>
            </dl>
          </section>

          <Panel title="재시작·에러" part={board.troubles}>
            {(list) => (
              <Rows list={list} empty={NO_PROBLEM}>
                {(row) => (
                  <li key={row.key}>
                    <ItemRow target={row.target} reveal={reveal} className="trouble">
                      <span className="kube-dash-name" title={`${row.namespace}/${row.name}`}>
                        <Mark health={row.health} /> {row.name}
                      </span>
                      <span className="kube-dash-reason" title={row.detail}>
                        {row.detail}
                      </span>
                      <span>
                        재시작 {row.restarts}
                        {row.increase > 0 && (
                          <b className="kube-restart-recent" title="이 화면을 연 뒤 증가">
                            {' '}
                            +{row.increase}
                          </b>
                        )}
                      </span>
                      <span>{row.lastAt === null ? '' : ageAgo(board.now - row.lastAt)}</span>
                    </ItemRow>
                  </li>
                )}
              </Rows>
            )}
          </Panel>

          <Panel title="자원 상위" part={board.top}>
            {(top) => (
              <>
                {top.basis === 'request' && <p className="kube-dash-note">요청량 기준입니다.</p>}
                <div className="kube-dash-top">
                  <TopColumn title="CPU" rows={top.cpu} format={formatCpu} reveal={reveal} />
                  <TopColumn
                    title="메모리"
                    rows={top.memory}
                    format={formatMemory}
                    reveal={reveal}
                  />
                </div>
              </>
            )}
          </Panel>

          <Panel title="미달 워크로드" part={board.under}>
            {(list) => (
              <Rows list={list} empty={NO_PROBLEM}>
                {(row) => (
                  <li key={row.key}>
                    <ItemRow target={row.target} reveal={reveal} className="under">
                      <span className="kube-dash-name" title={row.namespace}>
                        <Mark health="warn" /> {row.kind}/{row.name}
                      </span>
                      <span>
                        {row.ready}/{row.desired} 준비
                      </span>
                    </ItemRow>
                  </li>
                )}
              </Rows>
            )}
          </Panel>

          <IngressPanel data={ingress} open={openIngress} />

          <WorkerPanel now={board.now} reveal={reveal} openRuntime={openRuntime} />

          <Panel title="최근 경고" part={board.warnings} wide>
            {(list) => (
              <Rows list={list} empty={NO_PROBLEM}>
                {(row) => (
                  <li key={row.key}>
                    <ItemRow target={row.target} reveal={reveal} className="warning">
                      <span>{ageAgo(board.warningsNow - row.at)}</span>
                      <span>{row.reason}</span>
                      <span className="kube-dash-name">{row.object}</span>
                      <span className="kube-dash-reason" title={row.message}>
                        {row.message}
                      </span>
                    </ItemRow>
                  </li>
                )}
              </Rows>
            )}
          </Panel>
        </div>
        {menu && (
          <ContextMenu
            label="대시보드 메뉴"
            at={menu.at}
            items={menu.items}
            close={() => setMenu(null)}
          />
        )}
      </div>
    </TargetMenu.Provider>
  );
});

function partText<T>(part: Part<T>, ready: (value: T) => ReactNode) {
  if (part.state === 'ready') return ready(part.value);
  return part.state === 'waiting' ? '조회 중…' : part.reason;
}
