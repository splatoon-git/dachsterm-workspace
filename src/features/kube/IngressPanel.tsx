import { useMemo } from 'react';
import { hostGroups, ingressProblems, type IngressData } from './ingressModel';
import { stateNote } from './polling';
import { statusMark } from './treeFormat';

/** The dashboard's ingress area: only what is wrong. A row opens the ingress screen on that host. */
export function IngressPanel({ data, open }: { data: IngressData; open: (host: string) => void }) {
  const problems = useMemo(() => ingressProblems(hostGroups(data)), [data]);
  const waiting = data.ingresses === null;
  return (
    <section className="kube-dash-panel" aria-label="인그레스">
      <h3>인그레스</h3>
      {waiting ? (
        <p className="kube-dash-empty">
          {data.state && data.state.kind !== 'ready' ? stateNote(data.state) : '조회 중…'}
        </p>
      ) : problems.items.length === 0 ? (
        <p className="kube-dash-empty">문제 없음</p>
      ) : (
        <>
          <ul className="kube-dash-list">
            {problems.items.map((group) => (
              <li key={group.label}>
                <button className="kube-dash-row under" onClick={() => open(group.host)}>
                  <span className="kube-dash-name" title={group.label}>
                    <span className={`kube-health ${group.health}`} aria-hidden="true">
                      {statusMark[group.health]}
                    </span>{' '}
                    {group.label}
                  </span>
                  <span className="kube-dash-reason" title={group.problems.join(', ')}>
                    {group.problems.join(', ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {problems.more > 0 && <p className="kube-dash-more">외 {problems.more}개</p>}
        </>
      )}
    </section>
  );
}
