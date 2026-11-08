import { useState, type ReactNode } from 'react';
import { defaultChoice, Dialog } from '../../components/Dialog';

/** A yes-or-no question whose default is not to do it (roadmap: destructive actions). */
export function ConfirmDialog({
  title,
  action,
  children,
  confirm,
  cancel,
}: {
  title: string;
  action: string;
  children: ReactNode;
  confirm: () => void;
  cancel: () => void;
}) {
  return (
    <Dialog title={title} size="small" close={cancel}>
      {children}
      <div className="form-actions">
        <button ref={defaultChoice} onClick={cancel}>
          취소
        </button>
        <button className="danger" onClick={confirm}>
          {action}
        </button>
      </div>
    </Dialog>
  );
}

export function SaveAsDialog({
  path,
  submit,
  close,
}: {
  path: string;
  submit: (path: string) => void;
  close: () => void;
}) {
  const [target, setTarget] = useState(path);
  const value = target.trim();
  return (
    <Dialog title="다른 이름으로 저장" size="small" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value) submit(value);
        }}
      >
        <label>
          저장할 경로
          <input
            autoFocus
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </label>
        <div className="form-actions">
          <button type="button" onClick={close}>
            취소
          </button>
          <button type="submit" className="primary" disabled={!value}>
            저장
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Asked when closing a tab or the window would lose edits. */
export function UnsavedDialog({
  names,
  canSave,
  busy,
  save,
  discard,
  cancel,
}: {
  names: string[];
  canSave: boolean;
  busy: boolean;
  save: () => void;
  discard: () => void;
  cancel: () => void;
}) {
  const title = names.length === 1 ? `${names[0]} 저장` : `저장 안 된 파일 ${names.length}개`;
  return (
    <Dialog title={title} size="small" close={cancel}>
      <p>저장하지 않은 내용이 있습니다. 저장하지 않으면 변경한 내용을 잃습니다.</p>
      {names.length > 1 && (
        <ul>
          {names.map((name, index) => (
            <li key={`${name}-${index}`}>{name}</li>
          ))}
        </ul>
      )}
      {!canSave && <p role="status">연결이 끊겼거나 읽기 전용인 파일이 있어 저장할 수 없습니다.</p>}
      <div className="form-actions">
        <button ref={defaultChoice} onClick={cancel} disabled={busy}>
          취소
        </button>
        <button className="danger" onClick={discard} disabled={busy}>
          저장 안 함
        </button>
        <button className="primary" onClick={save} disabled={busy || !canSave}>
          {busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </Dialog>
  );
}
