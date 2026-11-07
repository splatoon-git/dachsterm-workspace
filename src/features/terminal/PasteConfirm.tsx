import { useMemo } from 'react';
import { describePaste } from './pastePreview';
import './paste.css';

export function PasteConfirm({
  text,
  reach = 1,
  cancel,
  confirm,
}: {
  text: string;
  /** Panes the paste goes to; above one while input reaches several panes. */
  reach?: number;
  cancel: () => void;
  confirm: () => void;
}) {
  const preview = useMemo(() => describePaste(text), [text]);
  const counts = [
    preview.lineBreaks > 0 && `줄바꿈 ${preview.lineBreaks.toLocaleString()}개`,
    preview.hiddenCharacters > 0 && `제어·숨김 문자 ${preview.hiddenCharacters.toLocaleString()}개`,
  ].filter(Boolean);
  return (
    <div className="trust-card paste-confirm" role="alert">
      <p>여러 줄 또는 제어문자가 포함되어 있습니다. 붙여넣으면 명령이 실행될 수 있습니다.</p>
      {reach > 1 && (
        <p className="paste-reach">
          <strong>동시 입력 중 · {reach}개 창</strong>에 같은 내용이 들어갑니다.
        </p>
      )}
      <p className="paste-counts">{counts.join(' · ')}</p>
      <pre aria-label="붙여넣을 내용" tabIndex={0}>
        {preview.segments.map((segment, index) => {
          if (segment.kind === 'text') return segment.text;
          if (segment.kind === 'hidden') return <mark key={index}>{segment.label}</mark>;
          return (
            <span key={index}>
              <mark title="줄바꿈">↵</mark>
              {'\n'}
            </span>
          );
        })}
      </pre>
      {preview.omitted > 0 && (
        <p className="paste-omitted">
          미리보기에 표시하지 않은 {preview.omitted.toLocaleString()}자도 함께 전송됩니다.
        </p>
      )}
      <div className="form-actions">
        <button onClick={cancel}>취소</button>
        <button onClick={confirm}>붙여넣기 실행</button>
      </div>
    </div>
  );
}
