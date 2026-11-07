import { useEffect, useState } from 'react';
import { signPurpose, type PendingSign, type SignDecision } from './agentSign';
import './agentSign.css';

/**
 * Shown in the pane like the host key card, not as a dialog: the terminal stays visible, so the
 * user can tell whether they started the command that asks. Nothing takes focus by itself, so
 * keys typed into the terminal cannot answer it.
 */
export function AgentSignCard({
  request,
  answer,
}: {
  request: PendingSign;
  answer: (decision: SignDecision) => void;
}) {
  const [left, setLeft] = useState(request.seconds);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(
      () => setLeft(Math.max(0, request.seconds - Math.floor((Date.now() - started) / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, [request.seconds]);
  return (
    <div className="trust-card agent-sign-card" role="alertdialog" aria-label="키 서명 요청">
      <h2>서버가 이 PC의 키로 서명하려고 합니다</h2>
      <p>직접 실행한 작업(git push 등)이 보낸 요청인지 확인하세요. 모르는 요청이면 거부하세요.</p>
      <dl>
        <dt>세션</dt>
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
        <dt>지문</dt>
        <dd>
          <code>{request.fingerprint}</code>
        </dd>
      </dl>
      <p role="timer">{left}초 안에 답하지 않으면 거부합니다.</p>
      <div className="form-actions">
        <button onClick={() => answer('deny')}>거부</button>
        <button onClick={() => answer('connection')}>이 연결에서 10분 허용</button>
        <button className="primary" onClick={() => answer('once')}>
          이번만 허용
        </button>
      </div>
    </div>
  );
}
