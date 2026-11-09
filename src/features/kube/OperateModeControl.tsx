import { useState } from 'react';
import { defaultChoice, Dialog } from '../../components/Dialog';
import { errorText } from '../../lib/ipc';
import type { OperateControl } from './useOperateMode';
import './kubeActions.css';

/** Always on screen. Going to operate mode asks first; going back to read-only never needs to. */
export function OperateModeControl({
  control,
  context,
}: {
  control: OperateControl;
  context: string;
}) {
  const { mode, change } = control;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const apply = (on: boolean) => {
    setBusy(true);
    setError('');
    change(on)
      .then(() => setAsking(false))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  const operating = mode === 'on';
  const switchable = operating || mode === 'off';
  return (
    <>
      <button
        type="button"
        className={operating ? 'kube-mode operating' : 'kube-mode'}
        disabled={!switchable || busy}
        title={
          operating
            ? '조회 모드로 돌아갑니다.'
            : mode === 'off'
              ? '운영 모드를 켜면 트리의 메뉴에서 제어할 수 있습니다.'
              : '탭 메뉴로 연 화면은 조회 모드로만 동작합니다.'
        }
        onClick={() => (operating ? apply(false) : setAsking(true))}
      >
        {operating ? '운영 모드' : '조회 모드'}
      </button>
      {!asking && error && <em role="alert">{error}</em>}
      {asking && (
        <Dialog title="운영 모드 켜기" size="small" close={() => !busy && setAsking(false)}>
          <dl className="kube-action-facts">
            <dt>Context</dt>
            <dd>{context}</dd>
          </dl>
          <p className="kube-action-impact">
            이 세션에서 파드 삭제, 롤아웃 재시작, cordon을 실행할 수 있게 됩니다. 실행할 때마다
            대상을 다시 확인하며, 실제 권한은 클러스터의 RBAC가 결정합니다.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="form-actions">
            <button
              type="button"
              ref={defaultChoice}
              disabled={busy}
              onClick={() => setAsking(false)}
            >
              취소
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => apply(true)}>
              운영 모드 켜기
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
