import { useSyncExternalStore } from 'react';
import { inbandProgress, inbandQuestion, type InbandTransfer } from './inbandTransfer';
import './inband.css';

/**
 * A program on the server asks to move files through the terminal (CG.8). Nothing is accepted on
 * its own: the user picks the folder or the files, and can refuse or stop. Like the sign card it
 * takes no focus, so keys typed into the terminal cannot answer it.
 */
export function InbandCard({ transfer }: { transfer: InbandTransfer }) {
  const shown = useSyncExternalStore(transfer.subscribe, transfer.snapshot);
  if (!shown) return null;
  if (shown.stage === 'ask')
    return (
      <div className="trust-card inband-card" role="alertdialog" aria-label="터미널 파일 전송">
        <h2>터미널 파일 전송</h2>
        <p>{inbandQuestion(shown)}</p>
        <div className="form-actions">
          <button onClick={() => transfer.answer('decline')}>거절</button>
          <button className="primary" onClick={() => transfer.answer('accept')}>
            {shown.direction === 'download' ? '저장할 폴더 고르기…' : '보낼 파일 고르기…'}
          </button>
        </div>
      </div>
    );
  const value = shown.total ? Math.min(shown.done, shown.total) : undefined;
  return (
    <div className="inband-progress" role="status" aria-label="터미널 파일 전송 진행">
      <span>
        {shown.direction === 'download' ? '받는 중' : '보내는 중'} · {inbandProgress(shown)}
      </span>
      <progress max={shown.total || undefined} value={value} />
      <button onClick={() => transfer.answer('stop')}>취소</button>
    </div>
  );
}
