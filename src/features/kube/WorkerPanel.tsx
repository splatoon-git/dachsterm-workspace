import { Fragment } from 'react';
import type { PodRef } from './detailTypes';
import { ItemRow } from './DashboardRows';
import type { TreeTarget } from './treeReveal';
import { useWorkers } from './workerContext';
import { verdictLine } from './workers';
import './kubeWorkers.css';

/** The dashboard's worker area: only what the user chose to watch, so it adds no query of its own. */
export function WorkerPanel({
  now,
  reveal,
  openRuntime,
}: {
  now: number;
  reveal: (target: TreeTarget) => void;
  openRuntime: (pod: PodRef) => void;
}) {
  const { summaries, capped } = useWorkers();
  return (
    <section className="kube-dash-panel" aria-label="워커">
      <h3>워커</h3>
      {summaries.length === 0 && (
        <p className="kube-dash-empty">
          감시 중인 워크로드가 없습니다. 파드 상세의 런타임 탭에서 켤 수 있습니다.
        </p>
      )}
      {summaries.length > 0 && (
        <ul className="kube-dash-list">
          {summaries.map((summary) => (
            <Fragment key={summary.key}>
              <li>
                <ItemRow
                  target={{
                    type: 'workload',
                    kind: summary.kind,
                    namespace: summary.namespace,
                    name: summary.name,
                  }}
                  reveal={reveal}
                  className="worker"
                >
                  <span className="kube-dash-name" title={summary.namespace}>
                    {summary.kind}/{summary.name}
                  </span>
                  <span>{summary.usage}</span>
                  <span className="kube-dash-reason" title={summary.note}>
                    {summary.verdicts.length === 0 && (summary.note || '이상 없음')}
                  </span>
                </ItemRow>
              </li>
              {summary.verdicts.map((verdict) => (
                <li key={`${verdict.pod}-${verdict.kind}`}>
                  <ItemRow
                    target={{ type: 'pod', namespace: summary.namespace, name: verdict.pod }}
                    reveal={() => openRuntime({ namespace: summary.namespace, name: verdict.pod })}
                    className="worker-verdict"
                  >
                    <span className="kube-health warn" aria-hidden="true">
                      ⚠
                    </span>
                    <span className="kube-dash-name">{verdict.pod}</span>
                    <span>{verdictLine(verdict, now)}</span>
                  </ItemRow>
                </li>
              ))}
            </Fragment>
          ))}
        </ul>
      )}
      {capped > 0 && (
        <p className="kube-dash-more">감시 대상 파드가 50개를 넘어 {capped}개는 읽지 않습니다.</p>
      )}
    </section>
  );
}
