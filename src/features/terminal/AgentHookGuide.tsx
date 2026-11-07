import { call, errorText } from '../../lib/ipc';
import { agentHookExample, tmuxSettingsExample } from './agentHooks';

/** Copy only. The app never writes a server's hook or tmux settings. */
export function AgentHookGuide({ notice }: { notice: (message: string) => void }) {
  const copy = (text: string) =>
    void call('clipboard_write_text', { text })
      .then(() => notice('복사했습니다.'))
      .catch((e) => notice(errorText(e)));
  return (
    <details className="agent-hook-guide">
      <summary>tmux 안에서 CLI 에이전트 상태 표시</summary>
      <p className="muted">
        tmux 안의 CLI 에이전트는 상태를 직접 보낼 수 없어 훅 설정이 필요합니다. 아래 예시를 서버의
        훅 설정에 넣으세요. 앱이 서버 설정을 바꾸지는 않습니다. 보이는 tmux 창의 상태만 전달되고, 한
        탭의 여러 패널은 구별되지 않습니다.
      </p>
      <pre tabIndex={0}>{agentHookExample}</pre>
      <button type="button" onClick={() => copy(agentHookExample)}>
        훅 예시 복사
      </button>
      <p className="muted">줄바꿈 키와 재접속 동작을 위한 tmux 설정입니다.</p>
      <pre tabIndex={0}>{tmuxSettingsExample}</pre>
      <button type="button" onClick={() => copy(tmuxSettingsExample)}>
        tmux 설정 복사
      </button>
    </details>
  );
}
