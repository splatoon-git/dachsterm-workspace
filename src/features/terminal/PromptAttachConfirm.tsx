import { useState } from 'react';
import { formatBytes } from '../../lib/formatBytes';
import { promptFolder, type PendingAttachment } from './promptAttachments';
import './paste.css';

/** PC data leaves for a server here, so the user sees what, where and to which host first. */
export function PromptAttachConfirm({
  attachment,
  server,
  cancel,
  confirm,
}: {
  attachment: PendingAttachment;
  server: string;
  cancel: () => void;
  confirm: (remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="trust-card paste-confirm" role="alert" aria-label="서버로 파일 보내기 확인">
      <p>이 파일을 서버로 보내고 경로를 입력합니다. Enter는 누르지 않습니다.</p>
      <ul className="attach-items">
        {attachment.items.map((item, index) => (
          <li key={index}>
            <span>{item.name}</span> <small>{formatBytes(item.size)}</small>
          </li>
        ))}
      </ul>
      <p className="paste-counts">
        서버 {server} · 저장 위치 <code>{promptFolder}</code>
      </p>
      {attachment.kind === 'clipboard' && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          이 연결에서는 다시 묻지 않음
        </label>
      )}
      <div className="form-actions">
        <button onClick={cancel}>취소</button>
        <button className="primary" onClick={() => confirm(remember)}>
          서버로 보내기
        </button>
      </div>
    </div>
  );
}
