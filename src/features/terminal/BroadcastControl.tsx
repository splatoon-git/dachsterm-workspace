import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { call, desktop, errorText } from '../../lib/ipc';
type Status = {
  targets: { id: string; name: string; host: string; username: string }[];
  selected: string[];
};
export function BroadcastControl({
  enabled = true,
  scope,
  onSelectionChange,
}: {
  enabled?: boolean;
  scope?: string[];
  onSelectionChange?: (ids: string[]) => void;
}) {
  const [state, setState] = useState<Status>({ targets: [], selected: [] });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const scopeKey = scope?.join(',') ?? '*';
  const lastScope = useRef(scopeKey);
  const candidates = state.targets.filter((t) => !scope || scope.includes(t.id));
  const selectionKey = JSON.stringify(state.selected);
  useEffect(() => {
    onSelectionChange?.(JSON.parse(selectionKey));
  }, [onSelectionChange, selectionKey]);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const refresh = () =>
      void call<Status>('broadcast_status')
        .then((s) => {
          if (active) setState(s);
        })
        .catch((e) => {
          if (active) setError(errorText(e));
        });
    refresh();
    const timer = setInterval(refresh, 500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function apply(ids: string[]) {
    setPending(true);
    try {
      await call('broadcast_set', { ids });
      setState(await call<Status>('broadcast_status'));
      setOpen(false);
      setError('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  const resetScope = useEffectEvent(() => {
    if (state.selected.length) void apply([]);
  });
  useEffect(() => {
    if (lastScope.current !== scopeKey) {
      lastScope.current = scopeKey;
      resetScope();
    }
  }, [scopeKey]);
  const mode = !state.selected.length
    ? 'off'
    : candidates.length === state.selected.length &&
        candidates.every((t) => state.selected.includes(t.id))
      ? 'all'
      : 'selected';
  return (
    <div className={`split-input ${state.selected.length ? 'broadcast-active' : ''}`}>
      <label title="분할된 터미널의 입력 전달 범위">
        입력
        <select
          aria-label="분할 입력 모드"
          value={mode}
          disabled={pending || (!enabled && !state.selected.length)}
          onChange={(e) => {
            if (e.target.value === 'off') void apply([]);
            else if (e.target.value === 'all') void apply(candidates.map((t) => t.id));
            else {
              setSelected(state.selected.filter((id) => candidates.some((t) => t.id === id)));
              setOpen(true);
            }
          }}
        >
          <option value="off">개별 입력</option>
          <option value="all" disabled={!enabled || candidates.length < 2}>
            모든 창
          </option>
          <option value="selected" disabled={!enabled || candidates.length < 2}>
            선택한 창…
          </option>
        </select>
      </label>
      {state.selected.length > 0 && (
        <>
          <span className="input-count" role="status">
            {state.selected.length}개 동시 입력
          </span>
          <button
            disabled={pending}
            onClick={() => {
              setSelected(state.selected.filter((id) => candidates.some((t) => t.id === id)));
              setOpen(true);
            }}
            aria-label="입력 대상 변경"
          >
            대상
          </button>
          <button
            disabled={pending}
            onClick={() => void apply([])}
            aria-label="멀티 입력 즉시 중지"
          >
            중지
          </button>
        </>
      )}
      {error && (
        <span className="error split-input-error" role="alert">
          {error}
        </span>
      )}
      {open && (
        <Dialog title="멀티 입력 대상" close={() => setOpen(false)}>
          <p className="muted">
            선택한 창에서 입력하면 체크한 모든 창에 같은 입력이 전달됩니다. SSH·로컬 셸·WSL을 함께
            선택할 수 있습니다. 서로 다른 셸에서는 명령의 의미가 다를 수 있습니다.
          </p>
          <p className="muted">
            배치를 바꾸거나 대상 연결이 종료되면 개별 입력으로 돌아갑니다. 새 연결은 자동으로
            추가하지 않습니다.
          </p>
          <div className="broadcast-targets">
            {candidates.map((t) => (
              <label className="checkbox" key={t.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(t.id)}
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked ? [...ids, t.id] : ids.filter((id) => id !== t.id),
                    )
                  }
                />
                <span>
                  <strong>{t.name}</strong>
                  <small>
                    {t.username}@{t.host} · {t.id.slice(0, 8)}
                  </small>
                </span>
              </label>
            ))}
          </div>
          {candidates.length < 2 && <p>현재 배치에 연결된 터미널이 2개 이상 필요합니다.</p>}
          <div className="form-actions">
            <button disabled={pending} onClick={() => setSelected(candidates.map((t) => t.id))}>
              모두 선택
            </button>
            <button disabled={pending} onClick={() => void apply([])}>
              개별 입력
            </button>
            <button
              className="primary"
              disabled={pending || selected.length < 2}
              onClick={() => void apply(selected)}
            >
              선택한 {selected.length}개에 입력 전달
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
