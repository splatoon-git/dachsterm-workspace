import { useRef, useState } from 'react';
import { errorText } from '../lib/ipc';

export type HostKeyRequest = {
  type: 'hostKey';
  challenge: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
};
export type AuthPrompt = {
  type: 'authPrompt';
  challenge: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
};

/** Asks whether to trust a server seen for the first time. Terminals and network tools share it. */
export function HostKeyCard({
  request,
  answer,
}: {
  request: HostKeyRequest;
  answer: (accept: boolean) => void;
}) {
  return (
    <div className="trust-card" role="alert" aria-label="최초 호스트키 확인">
      <h2>이 서버를 신뢰하시겠습니까?</h2>
      <p>서버 관리자가 제공한 지문과 비교하세요. 신뢰하면 이 기기의 known_hosts에 저장됩니다.</p>
      <p>
        {request.host}:{request.port} · {request.algorithm}
      </p>
      <code>{request.fingerprint}</code>
      <div className="form-actions">
        <button onClick={() => answer(false)}>거부</button>
        <button className="primary" onClick={() => answer(true)}>
          지문 확인 · 신뢰하고 연결
        </button>
      </div>
    </div>
  );
}

/** A server's own question during login. Give it a `key` of the challenge to start each one clean. */
export function AuthPromptCard({
  host,
  prompt,
  reply,
  cancel,
}: {
  host: string;
  prompt: AuthPrompt;
  reply: (responses: string[]) => Promise<unknown>;
  cancel: () => void;
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
        void reply(responses)
          .catch((e) => {
            setError(errorText(e));
            setBusy(false);
          })
          .finally(() => responses.fill(''));
      }}
    >
      <h2>서버 추가 인증</h2>
      <p>
        {host} · {prompt.name}
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
        <button type="button" onClick={cancel}>
          취소 · 연결 종료
        </button>
        <button className="primary" disabled={busy}>
          {busy ? '응답 확인 중' : '인증 응답'}
        </button>
      </div>
    </form>
  );
}
