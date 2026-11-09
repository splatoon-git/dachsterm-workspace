import { ItemRow } from './DashboardRows';
import { staleNote } from './dashboard';
import { Mark, Panel, Rows } from './KubeDashboard';
import { problemKinds, type SnapshotStore } from './polling';
import type { ProblemSection } from './problems';
import type { TreeTarget } from './treeReveal';
import './kubeIssues.css';

/** Everything wrong right now, one section for each kind of problem. */
export function KubeProblems({
  sections,
  store,
  reveal,
  alerts,
  setAlerts,
  alertError,
}: {
  sections: ProblemSection[];
  store: SnapshotStore;
  reveal: (target: TreeTarget) => void;
  alerts: boolean;
  setAlerts: (on: boolean) => void;
  alertError: string;
}) {
  const stale = staleNote(store, problemKinds);
  return (
    <div className="kube-dash">
      <div className="kube-issues-bar">
        <label>
          <input
            type="checkbox"
            checked={alerts}
            onChange={(event) => setAlerts(event.target.checked)}
          />
          이 세션의 새 문제를 OS 알림으로 받기
        </label>
        <span>앱이 켜져 있는 동안만 동작합니다. 켜 두면 탭이 가려져도 문제 조회를 계속합니다.</span>
        {alertError && <em role="alert">{alertError}</em>}
      </div>
      {stale && <p className="kube-dash-stale">마지막으로 받은 데이터입니다: {stale}</p>}
      <div className="kube-dash-grid">
        {sections.map((section) => (
          <Panel key={section.kind} title={section.title} part={section.part}>
            {(list) => (
              <Rows list={list} empty="문제 없음">
                {(problem) => (
                  <li key={problem.key}>
                    <ItemRow target={problem.target} reveal={reveal} className="problem">
                      <Mark health={problem.health} />
                      <span title={problem.object}>{problem.object}</span>
                      <span className="kube-dash-reason" title={problem.detail}>
                        {problem.detail}
                      </span>
                    </ItemRow>
                  </li>
                )}
              </Rows>
            )}
          </Panel>
        ))}
      </div>
    </div>
  );
}
