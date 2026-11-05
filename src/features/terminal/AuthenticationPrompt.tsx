import { useRef, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import type { AuthPrompt, TerminalSession } from './session';
export function AuthenticationPrompt({
  session,
  prompt,
}: {
  session: TerminalSession;
  prompt: AuthPrompt;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      ref={form}
      className="trust-card"
      aria-label="서버 추가 인증"
      onSubmit={(event) => {
        event.preventDefault();
        const inputs = Array.from(form.current!.querySelectorAll('input'));
        const responses = inputs.map((input) => input.value);
        inputs.forEach((input) => {
          input.value = '';
        });
        setBusy(true);
        void call('auth_reply', {
          id: session.connectionId,
          challenge: prompt.challenge,
          responses,
        })
          .catch((e) => {
            setError(errorText(e));
            setBusy(false);
          })
          .finally(() => responses.fill(''));
      }}
    >
      <h2>서버 추가 인증</h2>
      <p>
        {session.profile.host} · {prompt.name}
      </p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{prompt.instructions}</p>
      {prompt.prompts.map((item, index) => (
        <label key={index}>
          {item.prompt || `응답 ${index + 1}`}
          <input
            autoFocus={index === 0}
            type={item.echo ? 'text' : 'password'}
            autoComplete="off"
            maxLength={16384}
            disabled={busy}
          />
        </label>
      ))}
      {error && <p role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" onClick={() => void session.disconnect()}>
          취소 · 연결 종료
        </button>
        <button disabled={busy}>{busy ? '응답 확인 중' : '인증 응답'}</button>
      </div>
    </form>
  );
}
