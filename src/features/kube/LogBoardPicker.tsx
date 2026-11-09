import { useMemo, useState } from 'react';
import type { IngressController } from './ingressTypes';
import { scopeEntry, type BoardEntry, type BoardScope } from './logBoardModel';
import { scopeOptions, type ScopeKind } from './logSearchModel';
import { lineMatcher } from './podPanel';
import type { KubePod, KubeService } from './snapshotTypes';

const LIST_LIMIT = 40;

type Group = { label: string; scopes: BoardScope[] };

const of = (kind: ScopeKind, pods: KubePod[], services: KubeService[]): BoardScope[] =>
  scopeOptions(kind, pods, services).map((value) => ({ kind, value }));

/** Everything a board can follow, in the order people look for it. */
function groupsOf(pods: KubePod[], services: KubeService[], controllers: IngressController[]) {
  const nodes = [...new Set(pods.map((pod) => pod.node).filter(Boolean))].sort();
  const groups: Group[] = [
    {
      label: '인그레스',
      scopes: controllers.length ? [{ kind: 'controller', value: '' }] : [],
    },
    { label: '서비스', scopes: of('service', pods, services) },
    { label: '워크로드', scopes: of('workload', pods, services) },
    { label: '노드', scopes: nodes.map((value) => ({ kind: 'node', value })) },
    { label: '파드', scopes: of('pod', pods, services) },
  ];
  return groups.filter((group) => group.scopes.length > 0);
}

export function LogBoardPicker({
  pods,
  services,
  controllers,
  chosen,
  add,
}: {
  pods: KubePod[];
  services: KubeService[];
  controllers: IngressController[];
  chosen: BoardEntry[];
  add: (entry: BoardEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () => groupsOf(pods, services, controllers),
    [pods, services, controllers],
  );
  const matches = lineMatcher(query);
  const visible = groups
    .map((group) => ({
      ...group,
      scopes: group.scopes
        .filter((scope) => !matches || matches(`${scope.kind} ${scope.value}`))
        .slice(0, LIST_LIMIT),
    }))
    .filter((group) => group.scopes.length > 0);
  return (
    <div className="kube-board-picker">
      <input
        type="search"
        autoFocus
        aria-label="따라갈 대상 찾기"
        placeholder="서비스, 노드, 파드 이름"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="kube-board-picker-list">
        {visible.length === 0 && <p className="kube-board-hint">맞는 대상이 없습니다.</p>}
        {visible.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h4>{group.label}</h4>
            {group.scopes.map((scope) => {
              const entry = scopeEntry(scope);
              const added = chosen.some((item) => item.id === entry.id);
              return (
                <button key={entry.id} disabled={added} onClick={() => add(entry)}>
                  <span>{scope.value || entry.label}</span>
                  {added && <small>추가됨</small>}
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
