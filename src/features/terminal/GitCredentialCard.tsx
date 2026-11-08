import { useEffect, useState } from 'react';
import {
  credentialProblem,
  type CredentialAnswer,
  type CredentialReply,
  type PendingCredential,
  type SignDecision,
} from './agentSign';
import './agentSign.css';

type Stage =
  | { kind: 'choose' }
  | { kind: 'fetching' }
  | { kind: 'input'; decision: SignDecision | 'input'; reason: 'chosen' | 'notFound' };

const inputReason = {
  chosen: '이 저장소 서버에 쓸 사용자 이름과 토큰(또는 암호)을 입력하세요.',
  notFound: '앱과 이 PC의 Git 자격 증명 관리자에 저장된 값이 없습니다. 직접 입력하세요.',
} as const;

/**
 * In the pane like the signature card, and like it never takes focus by itself. Unlike a
 * signature, the value itself goes to the server, which the card says plainly. Allowing looks
 * for the value only then: the app's saved token, then this PC's Git credential helpers, which
 * may open their own sign-in window. A WSL tab's request (DX.14) names the tab instead, and the
 * value goes to git in that tab.
 */
export function GitCredentialCard({
  request,
  answer,
}: {
  request: PendingCredential;
  answer: (answer: CredentialAnswer) => Promise<CredentialReply | null> | void;
}) {
  const [deadline, setDeadline] = useState(() => Date.now() + request.seconds * 1000);
  const [left, setLeft] = useState(request.seconds);
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  const [username, setUsername] = useState(request.username ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  async function send(value: CredentialAnswer) {
    setBusy(true);
    const allowing = value.decision !== 'deny' && value.password === undefined;
    if (allowing && value.decision !== 'input') setStage({ kind: 'fetching' });
    const reply = await answer(value);
    setBusy(false);
    // The typed value is not kept once it has been sent.
    setPassword('');
    if (reply?.kind === 'input') {
      setDeadline(Date.now() + reply.seconds * 1000);
      setStage({ kind: 'input', decision: value.decision, reason: reply.reason });
    }
  }
  const problem = stage.kind === 'input' ? credentialProblem(username, password) : null;
  const local = request.local;
  return (
    <div className="trust-card agent-sign-card" role="alertdialog" aria-label="Git 자격 증명 요청">
      <h2>{local ? 'WSL' : '서버'}의 git이 HTTPS 자격 증명을 요청합니다</h2>
      <p>
        허용하면 이 PC의 자격 증명이{' '}
        <strong>{local ? '이 WSL 탭의 git으로 전달됩니다' : '서버로 전달됩니다'}</strong>.
      </p>
      {/* In a short pane this part scrolls, so the answers stay on screen. */}
      <div className="git-credential-details">
        <p>
          {local
            ? '이 탭에서 직접 실행한 git 작업인지 확인하세요. WSL에 설정한 Git helper가 있으면 그 helper도 이 값을 저장할 수 있습니다.'
            : '서버의 관리자는 전달된 값을 볼 수 있습니다. 직접 실행한 git 작업인지 확인하세요.'}
        </p>
        <dl>
          <dt>{local ? '탭' : '세션'}</dt>
          <dd>{request.session}</dd>
          <dt>저장소 서버</dt>
          <dd>
            <code>https://{request.host}</code>
          </dd>
          {request.path !== null && (
            <>
              <dt>저장소</dt>
              <dd>{request.path}</dd>
            </>
          )}
          {request.username !== null && (
            <>
              <dt>사용자</dt>
              <dd>{request.username}</dd>
            </>
          )}
        </dl>
        {request.serverHelpers.length > 0 && (
          <p role="note">
            서버의 Git helper({request.serverHelpers.join(', ')})가 이 값을 서버에 저장할 수
            있습니다.
          </p>
        )}
      </div>
      <p role="timer">{left}초 안에 답하지 않으면 거부합니다.</p>
      {stage.kind === 'input' ? (
        <form
          className="agent-sign-unlock"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem) void send({ decision: stage.decision, username, password, remember });
          }}
        >
          <p role="status">{inputReason[stage.reason]}</p>
          <label>
            사용자 이름
            <input
              autoComplete="off"
              autoFocus={!username}
              maxLength={256}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            토큰 또는 암호
            <input
              type="password"
              autoComplete="off"
              autoFocus={!!username}
              maxLength={16384}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            이 PC에 저장
          </label>
          <div className="form-actions">
            <button type="button" disabled={busy} onClick={() => void send({ decision: 'deny' })}>
              거부
            </button>
            <button type="submit" className="primary" disabled={busy || !!problem}>
              확인
            </button>
          </div>
        </form>
      ) : (
        <>
          {stage.kind === 'fetching' && (
            <p role="status">
              자격 증명을 가져오고 있습니다. 이 PC의 로그인 창이 열리면 그 창에서 계속하세요.
            </p>
          )}
          <div className="form-actions">
            <button onClick={() => void send({ decision: 'deny' })}>거부</button>
            <button disabled={busy} onClick={() => void send({ decision: 'input' })}>
              직접 입력
            </button>
            <button disabled={busy} onClick={() => void send({ decision: 'connection' })}>
              {local ? '이 탭에서 10분 허용' : '이 연결에서 10분 허용'}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void send({ decision: 'once' })}
            >
              이번만 허용
            </button>
          </div>
        </>
      )}
    </div>
  );
}
