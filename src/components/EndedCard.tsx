import './endedCard.css';

/** Shown over a pane whose connection has ended, with the two ways forward. */
export function EndedCard({
  message,
  reconnect,
  close,
}: {
  message: string;
  reconnect: () => void;
  close?: () => void;
}) {
  return (
    <div className="ended-card" role="group" aria-label="연결 종료 안내">
      <p>{message}</p>
      <div className="form-actions">
        {close && <button onClick={close}>탭 닫기</button>}
        <button className="primary" onClick={reconnect}>
          재접속
        </button>
      </div>
    </div>
  );
}
