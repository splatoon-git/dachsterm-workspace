import { ItemRow } from './DashboardRows';
import type { Change } from './history';
import { MAX_CHANGES } from './history';
import { Mark } from './KubeDashboard';
import type { TreeTarget } from './treeReveal';
import './kubeIssues.css';

const kindLabels: Record<Change['kind'], string> = {
  node: '노드',
  restart: '재시작',
  broke: '고장',
  recovered: '회복',
  gone: '사라짐',
};

const clock = (at: number) =>
  new Date(at).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

/** What changed between snapshots, newest first. */
export function KubeChanges({
  changes,
  reveal,
}: {
  changes: Change[];
  reveal: (target: TreeTarget) => void;
}) {
  return (
    <div className="kube-dash">
      <p className="kube-dash-note">
        이 탭이 열린 뒤의 변화를 최대 {MAX_CHANGES}건 보관하며, 앱을 닫으면 사라집니다.
      </p>
      {changes.length === 0 ? (
        <p className="kube-dash-empty">아직 변화가 없습니다.</p>
      ) : (
        <ul className="kube-dash-list">
          {changes.map((change) => (
            <li key={change.id}>
              <ItemRow target={change.target} reveal={reveal} className="change">
                <time>{clock(change.at)}</time>
                <Mark health={change.health} />
                <span>{kindLabels[change.kind]}</span>
                <span title={change.object}>{change.object}</span>
                <span className="kube-dash-reason" title={change.detail}>
                  {change.detail}
                </span>
              </ItemRow>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
