import { MIN_TARGETS, sameIds, type InputScope } from './inputScopeModel';
import type { InputScopeController } from './useInputScope';
import './inputScope.css';

const modes: { mode: InputScope['mode']; label: string; title: string }[] = [
  { mode: 'off', label: '개별', title: '입력은 포커스된 창에만 갑니다' },
  { mode: 'all', label: '전체', title: '보이는 터미널 창 모두에 같은 입력을 보냅니다' },
  { mode: 'pick', label: '선택', title: '탭 바에서 입력 받을 창을 고릅니다' },
];

/** The input scope in the status bar. It appears once two or more terminals are on screen. */
export function InputScopeControl({ input }: { input: InputScopeController }) {
  const { scope, status, candidates, sending, pending, notice } = input;
  const shown = candidates.length >= MIN_TARGETS || sending || scope.mode !== 'off';
  // A group set before this window's state existed (a reload) still shows as one.
  const current =
    scope.mode !== 'off' || !sending
      ? scope.mode
      : sameIds(candidates, status.selected)
        ? 'all'
        : 'pick';
  const picked = scope.mode === 'pick' ? scope.ids.filter((id) => candidates.includes(id)) : [];
  return (
    <div className={`input-scope ${sending ? 'sending' : ''}`}>
      {shown && (
        <div
          className="input-scope-modes"
          role="radiogroup"
          aria-label="입력 범위"
          title="입력 범위 · Ctrl/Cmd+Shift+M"
        >
          {modes.map(({ mode, label, title }) => (
            <label key={mode} title={title} className={current === mode ? 'checked' : ''}>
              <input
                type="radio"
                name="input-scope"
                value={mode}
                checked={current === mode}
                disabled={pending || (mode !== 'off' && candidates.length < MIN_TARGETS)}
                onChange={() => input.choose(mode)}
              />
              {label}
            </label>
          ))}
        </div>
      )}
      {sending ? (
        <>
          <strong className="input-scope-state" role="status">
            동시 입력 중 · {status.selected.length}개 창
          </strong>
          {current === 'all' && (
            <button disabled={pending} onClick={() => input.choose('pick')}>
              대상 변경
            </button>
          )}
          <button
            disabled={pending}
            onClick={() => input.choose('off')}
            aria-label="동시 입력 중지"
          >
            중지
          </button>
        </>
      ) : (
        scope.mode === 'pick' && (
          <span className="input-scope-state" role="status">
            {picked.length}개 선택 · {MIN_TARGETS}개 이상 고르면 전달됩니다
          </span>
        )
      )}
      {notice && (
        <span className="input-scope-notice" role="status">
          {notice}
        </span>
      )}
    </div>
  );
}

/** A pane's part in the group, at the start of its tab bar. */
export function InputScopeMark({
  input,
  connectionId,
  name,
}: {
  input: InputScopeController;
  /** The pane's connection, or nothing for a pane without a terminal. */
  connectionId?: string;
  name: string;
}) {
  const role = input.roleOf(connectionId);
  if (role === 'pick' && connectionId) {
    const checked = input.scope.mode === 'pick' && input.scope.ids.includes(connectionId);
    return (
      <label className="input-mark pick" data-connection-id={connectionId}>
        <input
          type="checkbox"
          checked={checked}
          disabled={input.pending}
          aria-label={`${name} 입력 받기`}
          onChange={(e) => input.toggle(connectionId, e.target.checked)}
        />
        입력 받기
      </label>
    );
  }
  if (role === 'outside') return <span className="input-mark outside">입력 전달 대상 아님</span>;
  return null;
}
