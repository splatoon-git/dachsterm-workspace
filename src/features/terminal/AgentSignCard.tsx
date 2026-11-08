import { useEffect, useState } from 'react';
import {
  passphraseReason,
  signPurpose,
  signSource,
  signText,
  type PendingSign,
  type SignAnswer,
  type SignDecision,
  type SignReply,
} from './agentSign';
import './agentSign.css';

type Unlocking = { decision: SignDecision; reason: keyof typeof passphraseReason };

/**
 * Shown in the pane like the host key card, not as a dialog: the terminal stays visible, so the
 * user can tell whether they started the command that asks. Nothing takes focus by itself, so
 * keys typed into the terminal cannot answer it. Only after the user allows a locked key does the
 * Passphrase field appear and take focus.
 */
export function AgentSignCard({
  request,
  answer,
}: {
  request: PendingSign;
  answer: (answer: SignAnswer) => Promise<SignReply | null> | void;
}) {
  const [left, setLeft] = useState(request.seconds);
  const [unlocking, setUnlocking] = useState<Unlocking | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const text = signText(request);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(
      () => setLeft(Math.max(0, request.seconds - Math.floor((Date.now() - started) / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, [request.seconds]);
  async function send(value: SignAnswer) {
    setBusy(true);
    const reply = await answer(value);
    setBusy(false);
    // The typed value is not kept once it has been sent.
    setPassphrase('');
    if (reply?.kind === 'passphrase')
      setUnlocking({ decision: value.decision, reason: reply.reason });
  }
  return (
    <div className="trust-card agent-sign-card" role="alertdialog" aria-label="키 서명 요청">
      <h2>{text.title}</h2>
      <p>직접 실행한 작업(git push 등)이 보낸 요청인지 확인하세요. 모르는 요청이면 거부하세요.</p>
      <dl>
        <dt>{text.where}</dt>
        <dd>{request.session}</dd>
        <dt>용도</dt>
        <dd>{signPurpose(request)}</dd>
        {request.hostKey && (
          <>
            <dt>로그인할 서버의 호스트키</dt>
            <dd>
              <code>{request.hostKey}</code>
            </dd>
          </>
        )}
        <dt>키</dt>
        <dd>{request.key || '이름 없는 키'}</dd>
        <dt>키 출처</dt>
        <dd>{signSource(request)}</dd>
        <dt>지문</dt>
        <dd>
          <code>{request.fingerprint}</code>
        </dd>
      </dl>
      <p role="timer">{left}초 안에 답하지 않으면 거부합니다.</p>
      {unlocking ? (
        <form
          className="agent-sign-unlock"
          onSubmit={(e) => {
            e.preventDefault();
            void send({ decision: unlocking.decision, passphrase, remember });
          }}
        >
          <p role="status">{passphraseReason[unlocking.reason]}</p>
          <label>
            Passphrase
            <input
              type="password"
              autoComplete="off"
              autoFocus
              maxLength={16384}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
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
            <button type="submit" className="primary" disabled={busy || !passphrase}>
              확인
            </button>
          </div>
        </form>
      ) : (
        <div className="form-actions">
          <button disabled={busy} onClick={() => void send({ decision: 'deny' })}>
            거부
          </button>
          <button disabled={busy} onClick={() => void send({ decision: 'connection' })}>
            {text.allow}
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void send({ decision: 'once' })}
          >
            이번만 허용
          </button>
        </div>
      )}
    </div>
  );
}
