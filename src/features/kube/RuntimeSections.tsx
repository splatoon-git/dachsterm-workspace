import type { ReactNode } from 'react';
import { stateNote } from './polling';
import {
  formatAgeSeconds,
  groupProcesses,
  isNearLimit,
  percentOf,
  processStateLabel,
  runtimeGrowth,
  tcpRows,
} from './runtimeModel';
import type { MetricsRead, Runtime } from './runtimeTypes';

/** One titled block of the runtime tab; `tools` sits at the right of the title. */
export function RuntimePanel({
  label,
  tools,
  children,
}: {
  label: string;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="kube-rt-panel" aria-label={label}>
      <div className="kube-rt-head">
        <h3>{label}</h3>
        {tools && <div className="kube-rt-tools">{tools}</div>}
      </div>
      {children}
    </section>
  );
}

/** A count that is quiet at zero and warns when it rose since the last collection. */
function Stat({
  label,
  value,
  growth = 0,
}: {
  label: string;
  value: number | null;
  growth?: number;
}) {
  const tone = growth > 0 ? 'rising' : value === null || value === 0 ? 'idle' : '';
  return (
    <div className={`kube-rt-stat ${tone}`}>
      <dt>{label}</dt>
      <dd>
        {value ?? '-'}
        {growth > 0 && <small title="직전 수집보다 늘었습니다">+{growth}</small>}
      </dd>
    </div>
  );
}

export function ThreadsSection({ read, loading }: { read: MetricsRead | null; loading: boolean }) {
  const forbidden = read?.state.kind === 'forbidden';
  const containers = read?.data?.kind === 'threads' ? read.data.containers : null;
  return (
    <RuntimePanel label="컨테이너 스레드">
      {loading && <p className="kube-rt-note">노드 메트릭을 읽는 중…</p>}
      {forbidden && (
        <p className="kube-rt-note" role="status">
          nodes/proxy 권한이 없어 노드 메트릭을 읽을 수 없습니다. 아래 수집으로 프로세스별 스레드를
          읽습니다.
        </p>
      )}
      {read && !forbidden && read.state.kind !== 'ready' && (
        <p className="kube-rt-note">{stateNote(read.state)}</p>
      )}
      {containers?.length === 0 && (
        <p className="kube-rt-note">노드 메트릭에 이 파드의 스레드 수가 없습니다.</p>
      )}
      {containers && containers.length > 0 && (
        <dl className="kube-rt-stats">
          {containers.map((item) => (
            <Stat key={item.container} label={item.container} value={item.threads} />
          ))}
        </dl>
      )}
    </RuntimePanel>
  );
}

export function ProcessesSection({ runtime }: { runtime: Runtime }) {
  const groups = groupProcesses(runtime.processes);
  return (
    <div>
      <h4>프로세스·워커</h4>
      <table className="kube-table">
        <thead>
          <tr>
            <th>이름</th>
            <th className="num">수</th>
            <th className="num">스레드</th>
            <th className="num">FD</th>
            <th className="num" title="프로세스 하나가 FD 한도를 가장 많이 쓴 비율">
              한도
            </th>
            <th className="num">실행 시간</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const { fullest } = group;
            const near = fullest !== null && isNearLimit(fullest.fds, fullest.limit);
            return (
              <tr key={group.name} className={near ? 'warn' : undefined}>
                <td className="kube-wrap">{group.name}</td>
                <td className="num">{group.count}</td>
                <td className="num">{group.threads}</td>
                <td className="num">{group.fds ?? '-'}</td>
                <td
                  className="num"
                  title={fullest ? `프로세스당 최대 ${fullest.fds} / ${fullest.limit}` : undefined}
                >
                  {fullest ? percentOf(fullest.fds, fullest.limit) : '-'}
                </td>
                <td className="num">{formatAgeSeconds(group.oldestSeconds)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {runtime.truncated && <p className="kube-rt-note">프로세스가 많아 일부만 읽었습니다.</p>}
      <details className="kube-rt-each">
        <summary>프로세스별 보기 {runtime.processes.length}개</summary>
        <div className="kube-rt-scroll">
          <table className="kube-table">
            <thead>
              <tr>
                <th className="num">PID</th>
                <th>이름</th>
                <th>상태</th>
                <th className="num">스레드</th>
                <th className="num">FD</th>
              </tr>
            </thead>
            <tbody>
              {runtime.processes.map((item) => {
                const near =
                  item.fds !== null && item.fdLimit !== null && isNearLimit(item.fds, item.fdLimit);
                return (
                  <tr key={item.pid} className={near || item.state === 'Z' ? 'warn' : undefined}>
                    <td className="num">{item.pid}</td>
                    <td className="kube-wrap">{item.name}</td>
                    <td>{processStateLabel(item.state)}</td>
                    <td className="num">{item.threads}</td>
                    <td className="num">
                      {item.fds ?? '-'}
                      {item.fdLimit !== null && ` / ${item.fdLimit}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export function ConnectionsSection({
  current,
  previous,
}: {
  current: Runtime;
  previous: Runtime | null;
}) {
  const growth = runtimeGrowth(current, previous);
  const { listen, counters } = current;
  return (
    <div>
      <h4>TCP 연결</h4>
      <dl className="kube-rt-stats">
        {tcpRows(current.tcp).map(([name, value]) => (
          <Stat
            key={name}
            label={name}
            value={value}
            growth={name === 'CLOSE_WAIT' ? growth.closeWait : 0}
          />
        ))}
      </dl>
      <h4>LISTEN 포트</h4>
      {listen.length === 0 && <p className="kube-rt-note">열린 포트가 없습니다.</p>}
      {listen.length > 0 && (
        <table className="kube-table">
          <thead>
            <tr>
              <th>포트</th>
              <th className="num">대기 큐</th>
            </tr>
          </thead>
          <tbody>
            {listen.map((item) => (
              <tr
                key={item.port}
                className={isNearLimit(item.queued, item.backlog) ? 'warn' : undefined}
              >
                <td>{item.port}</td>
                <td className="num">
                  {item.queued} / {item.backlog}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>누적</h4>
      <dl className="kube-rt-stats">
        <Stat
          label="SYN 큐 넘침"
          value={counters.listenOverflows}
          growth={growth.listenOverflows}
        />
        <Stat label="드롭" value={counters.listenDrops} growth={growth.listenDrops} />
        <Stat label="재전송" value={counters.retransmitted} />
      </dl>
    </div>
  );
}
