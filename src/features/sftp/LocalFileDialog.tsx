import { Dialog } from '../../components/Dialog';
import { EditorPicker } from './EditorPicker';
import { operationText } from './fileOperation';

export type LocalFileOperation =
  | { kind: 'mkdir' | 'newfile' | 'rename'; value: string }
  | { kind: 'edit'; program: string }
  | { kind: 'delete' };

export function saveEditor(program: string) {
  try {
    localStorage.setItem('dachsterm.editor', program);
  } catch {
    /* The editor still opened; only the remembered choice is lost. */
  }
}

export function LocalFileDialog({
  operation,
  selection,
  error,
  change,
  fail,
  close,
  submit,
}: {
  operation: LocalFileOperation;
  selection: string[];
  error: string;
  change: (operation: LocalFileOperation) => void;
  fail: (message: string) => void;
  close: () => void;
  submit: () => void;
}) {
  const text = operationText(operation.kind, selection.length);
  return (
    <Dialog title={text.title} size={operation.kind === 'edit' ? 'medium' : 'small'} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {operation.kind === 'delete' ? (
          <>
            <p>폴더 안의 내용까지 모두 지웁니다. 휴지통을 거치지 않으며 되돌릴 수 없습니다.</p>
            <ul className="delete-list">
              {selection.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </>
        ) : operation.kind === 'edit' ? (
          <EditorPicker
            value={operation.program}
            change={(program) => change({ kind: 'edit', program })}
            fail={fail}
          />
        ) : (
          <label>
            이름 또는 경로
            <input
              required
              value={operation.value}
              onChange={(e) => change({ ...operation, value: e.target.value })}
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" onClick={close}>
            취소
          </button>
          <button className={text.danger ? 'danger' : 'primary'}>
            {operation.kind === 'edit' ? '열기' : text.action}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
