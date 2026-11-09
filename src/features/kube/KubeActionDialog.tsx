import { useState } from 'react';
import { defaultChoice, Dialog } from '../../components/Dialog';
import { call, errorText } from '../../lib/ipc';
import type { ActionPlan } from './actionModel';
import './kubeActions.css';

/**
 * Asks once and runs once. Cancel has the focus, so Enter does nothing harmful. The window stays
 * until the answer arrives: closing it would leave a write running with nothing on screen.
 */
export function KubeActionDialog({
  plan,
  connectionId,
  context,
  close,
  done,
}: {
  plan: ActionPlan;
  connectionId: string;
  /** Sent back so the backend can refuse if it is no longer the session's context. */
  context: string;
  close: () => void;
  done: (plan: ActionPlan) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const leave = () => {
    if (!running) close();
  };
  const run = () => {
    setRunning(true);
    setError('');
    call('kube_action', { id: connectionId, context, action: plan.action })
      .then(() => done(plan))
      .catch((e: unknown) => {
        setError(errorText(e));
        setRunning(false);
      });
  };
  return (
    <Dialog title={plan.title} size="small" close={leave}>
      <dl className="kube-action-facts">
        <dt>Context</dt>
        <dd>{context}</dd>
        <dt>Namespace</dt>
        <dd>{plan.namespace}</dd>
        <dt>대상</dt>
        <dd>{plan.target}</dd>
      </dl>
      <p className={plan.permanent ? 'kube-action-impact permanent' : 'kube-action-impact'}>
        {plan.impact}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" ref={defaultChoice} disabled={running} onClick={leave}>
          취소
        </button>
        <button type="button" className="danger" disabled={running} onClick={run}>
          {running ? '실행 중…' : plan.confirm}
        </button>
      </div>
    </Dialog>
  );
}
