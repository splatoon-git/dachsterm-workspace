import type { Profile } from '../../lib/ipc';
import type { CommandPlan } from './proxyApproval';

/** The commands imported sessions would run on this PC, each off until ticked (CG.2). */
export function ProxyCommandApproval({
  plan,
  selected,
  toggle,
  missing,
}: {
  plan: CommandPlan;
  selected: string[];
  toggle: (id: string, on: boolean) => void;
  missing: Profile[];
}) {
  return (
    <fieldset className="proxy-command-approval">
      <legend>연결할 때 실행할 명령 승인</legend>
      <p>
        아래 세션은 연결할 때마다 이 PC에서 명령을 실행합니다(ProxyCommand). 명령을 직접 확인하고
        믿는 세션만 선택하세요. 선택하지 않은 세션은 가져오지 않습니다.
      </p>
      {plan.sessions.map((s) => (
        <label className="checkbox" key={s.id}>
          <input
            type="checkbox"
            aria-label={`${s.name} 명령 승인`}
            checked={selected.includes(s.id)}
            onChange={(e) => toggle(s.id, e.target.checked)}
          />
          <span>
            {s.name}
            <code>{s.command}</code>
          </span>
        </label>
      ))}
      {missing.length > 0 && (
        <p role="alert">
          선택한 세션의 경유지 {missing.map((p) => p.name).join(', ')}도 명령을 실행합니다. 위에서
          승인해야 가져올 수 있습니다.
        </p>
      )}
    </fieldset>
  );
}
