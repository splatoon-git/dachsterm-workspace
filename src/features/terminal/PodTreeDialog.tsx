import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { call, errorText } from '../../lib/ipc';
import type { LocalTarget, PodTreeLaunch, TerminalSession } from './session';
type Inspection = { contexts: string[]; current: string; namespaces: string[]; warning: string };
export function PodTreeDialog({
  sessions,
  locals,
  close,
  open,
}: {
  sessions: TerminalSession[];
  locals: LocalTarget[];
  close: () => void;
  open: (launch: PodTreeLaunch, title: string) => void;
}) {
  const targets = [
    ...sessions
      .filter(
        (s) =>
          !s.podtree &&
          !s.localTarget &&
          s.profile.protocol === 'ssh' &&
          s.snapshot().status === 'connected',
      )
      .map((s) => ({
        value: `ssh:${s.connectionId}`,
        name: `SSH · ${s.profile.name}`,
        location: { kind: 'ssh' as const, id: s.connectionId },
      })),
    ...locals
      .filter((t) => t.kind === 'wsl' || t.id === 'default-shell')
      .map((t) => ({
        value: `local:${t.id}`,
        name: `로컬 · ${t.name}`,
        location: { kind: 'local' as const, id: t.id },
      })),
  ];
  const [target, setTarget] = useState(targets[0]?.value ?? '');
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [context, setContext] = useState('');
  const [namespace, setNamespace] = useState('');
  const [operational, setOperational] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = targets.find((t) => t.value === target);
  async function inspect(next = '') {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const result = await call<Inspection>('podtree_inspect', {
        location: selected.location,
        context: next || null,
      });
      setInspection(result);
      setContext(next || result.current || result.contexts[0] || '');
    } catch (e) {
      setError(errorText(e));
      setInspection(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="PodTree 열기" close={close}>
      <p>
        PodTree 2.4.0 · DachsTerm 조회 모드 보완판. 선택 위치의 Bash 4+와 kubectl 설정/RBAC를
        사용합니다. 도구·디버그 이미지를 설치하거나 전역 context를 변경하지 않습니다.
      </p>
      <div className="terminal-preferences">
        <label>
          실행 위치
          <select
            aria-label="실행 위치"
            value={target}
            disabled={busy}
            onChange={(e) => {
              setTarget(e.target.value);
              setInspection(null);
              setContext('');
              setNamespace('');
            }}
          >
            {targets.map((t) => (
              <option key={t.value} value={t.value}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!selected || busy} onClick={() => void inspect()}>
          의존성·context 확인
        </button>
        {inspection && (
          <>
            <label>
              context
              <select
                aria-label="context"
                value={context}
                disabled={busy}
                onChange={(e) => {
                  setContext(e.target.value);
                  setNamespace('');
                  void inspect(e.target.value);
                }}
              >
                {inspection.contexts.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <button disabled={busy || !context} onClick={() => void inspect(context)}>
              namespace 새로고침
            </button>
            <label>
              namespace (비우면 전체)
              <input
                aria-label="namespace (비우면 전체)"
                list="podtree-namespaces"
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
              />
              <datalist id="podtree-namespaces">
                {inspection.namespaces.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </datalist>
            </label>
            <p role="status">{inspection.warning}</p>
          </>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={operational}
            onChange={(e) => setOperational(e.target.checked)}
          />
          운영 모드 사용
        </label>
      </div>
      <p>
        {operational
          ? '운영 모드는 삭제·재시작·cordon, 셸 진입·디버그·캡처·포트 포워딩을 허용합니다. 실제 대상과 부작용을 확인한 뒤 실행하세요.'
          : '조회 모드는 쓰기·셸 진입·디버그·캡처·포트 포워딩·네트워크 실행 프로브를 차단합니다. proxy를 사용하는 GPU/vLLM 자동 수집도 꺼집니다. 클러스터 권한은 RBAC로 함께 제한하세요.'}
      </p>
      <p className="muted">
        앱에 포함된 스크립트를 실행 위치의 사용자 전용 임시 폴더에 배치합니다. 정상 종료 시 삭제하며
        강제 종료 시 남을 수 있습니다. context/namespace는 탭마다 고정됩니다. 이 탭은 멀티
        입력·스니펫·세션 로그에서 제외됩니다.
      </p>
      {error && <p role="alert">{error}</p>}
      {!targets.length && <p>SSH에 먼저 연결하거나 WSL/Bash 환경을 준비하세요.</p>}
      <div className="form-actions">
        <button onClick={close}>취소</button>
        <button
          className="primary"
          disabled={busy || !inspection || !context || !selected}
          onClick={() => {
            if (selected)
              open({ location: selected.location, context, namespace, operational }, selected.name);
          }}
        >
          전용 탭 열기 · {operational ? '운영' : '조회'}
        </button>
      </div>
    </Dialog>
  );
}
