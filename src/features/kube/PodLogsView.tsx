import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { call, type KubeSettings } from '../../lib/ipc';
import type { PodLogs, PodOverview, PodRef } from './detailTypes';
import { chooseContainer, filterLines, rememberContainer } from './podPanel';
import type { PodTerminalRequest } from './podShell';
import { shellTitle } from './podShell';
import { stateNote } from './polling';
import { useKubeRead } from './useKubeRead';

const PANEL_TAIL = 500;
const FOLLOW_TAIL = 500;

/** Plain text, read on demand: following a log as it grows is the terminal tab's job. */
export function PodLogsView({
  connectionId,
  kube,
  target,
  overview,
  session,
  tick,
  openTerminal,
}: {
  connectionId: string;
  kube: KubeSettings;
  target: PodRef;
  overview: PodOverview | null;
  session: string;
  tick: number;
  openTerminal: (request: PodTerminalRequest) => void;
}) {
  const names = overview?.containers.map((c) => c.name) ?? [];
  const [picked, setPicked] = useState('');
  const [previous, setPrevious] = useState(false);
  const [query, setQuery] = useState('');
  const body = useRef<HTMLPreElement>(null);
  const container =
    picked && names.includes(picked)
      ? picked
      : overview
        ? (chooseContainer(overview, session) ?? names[0] ?? '')
        : '';
  const key = `${target.namespace}/${target.name}/${container}/${previous}/${tick}`;
  const logs = useKubeRead(
    () =>
      container
        ? call<PodLogs>('kube_logs', {
            id: connectionId,
            kube,
            target: { namespace: target.namespace, pod: target.name },
            container,
            tail: PANEL_TAIL,
            previous,
          })
        : Promise.resolve(null),
    key,
  );
  const text = logs.data?.text ?? '';
  const lines = useMemo(() => filterLines(text, query), [text, query]);
  const total = useMemo(() => filterLines(text, '').length, [text]);
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text, query]);
  const failed =
    logs.error || (logs.data && logs.data.state.kind !== 'ready' ? stateNote(logs.data.state) : '');
  const empty = !failed && !logs.loading && lines.length === 0;
  return (
    <div className="kube-log-view">
      <div className="kube-panel-tools">
        {names.length > 1 && (
          <select
            aria-label="컨테이너"
            value={container}
            onChange={(event) => {
              const name = event.target.value;
              setPicked(name);
              if (overview) rememberContainer(session, overview, name);
            }}
          >
            {names.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        )}
        <label className="kube-tree-problems">
          <input
            type="checkbox"
            checked={previous}
            onChange={(event) => setPrevious(event.target.checked)}
          />
          직전 인스턴스
        </label>
        <input
          type="search"
          aria-label="로그 필터"
          placeholder="키워드 필터: 공백은 AND, !단어는 제외"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          disabled={!container}
          title="터미널 탭에서 실시간으로 따라갑니다"
          onClick={() =>
            openTerminal({
              launch: {
                kind: 'podLogs',
                connection: connectionId,
                kube,
                namespace: target.namespace,
                pod: target.name,
                container,
                tail: FOLLOW_TAIL,
              },
              title: `${shellTitle(kube.context, target.name)} 로그`,
              pod: target,
              overview,
            })
          }
        >
          따라가기
        </button>
      </div>
      <div className="kube-panel-note" role="status">
        {logs.loading && '로그를 읽는 중…'}
        {failed}
        {logs.data?.previousMissing && '직전 인스턴스가 없어 현재 로그를 표시합니다.'}
        {logs.data?.truncated && ' 로그가 커서 일부만 표시합니다.'}
        {!logs.loading && !failed && query && ` ${lines.length} / ${total}줄`}
      </div>
      {empty && (
        <p className="kube-tree-empty">
          {query ? '조건에 맞는 줄이 없습니다.' : '로그가 없습니다.'}
        </p>
      )}
      {!empty && (
        <pre ref={body} className="kube-log" tabIndex={0} aria-label="로그">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}
