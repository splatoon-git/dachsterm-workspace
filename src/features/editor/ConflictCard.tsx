import { useState } from 'react';
import { conflictKind, type Conflict, type ConflictKind } from './fileSave';
import { ConfirmDialog } from './FileDialogs';

const messages: Record<ConflictKind, string> = {
  changed: '파일을 연 뒤 내용이 바뀌어 저장하지 않았습니다. 지금 편집본은 그대로 있습니다.',
  removed: '파일이 사라져 저장하지 않았습니다. 지금 편집본은 그대로 있습니다.',
  taken: '같은 이름의 파일이 이미 있어 저장하지 않았습니다.',
};
const overwriteLabels: Record<ConflictKind, string> = {
  changed: '덮어쓰기',
  removed: '다시 만들기',
  taken: '덮어쓰기',
};

/** The save stopped because the file is not what the user read. */
export function ConflictCard({
  conflict,
  busy,
  comparing,
  overwrite,
  compare,
  cancel,
}: {
  conflict: Conflict;
  busy: boolean;
  comparing: boolean;
  overwrite: () => void;
  compare: () => void;
  cancel: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const kind = conflictKind(conflict);
  return (
    <div className="file-conflict" role="alertdialog" aria-label="저장 충돌">
      <p>{messages[kind]}</p>
      <div className="file-conflict-actions">
        <button className="danger" disabled={busy} onClick={() => setConfirming(true)}>
          {overwriteLabels[kind]}
        </button>
        {kind !== 'removed' && (
          <button disabled={busy} aria-pressed={comparing} onClick={compare}>
            {comparing ? '비교 닫기' : '서버 내용 보기'}
          </button>
        )}
        <button disabled={busy} onClick={cancel}>
          취소
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="파일을 덮어씁니다"
          action={overwriteLabels[kind]}
          confirm={() => {
            setConfirming(false);
            overwrite();
          }}
          cancel={() => setConfirming(false)}
        >
          <p>{conflict.path}</p>
          <p>지금 파일의 내용은 되돌릴 수 없습니다.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
