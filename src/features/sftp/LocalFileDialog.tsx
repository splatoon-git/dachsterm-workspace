import { Dialog } from '../../components/Dialog';
import { call, errorText } from '../../lib/ipc';

export type LocalFileOperation =
  | { kind: 'mkdir' | 'newfile' | 'rename'; value: string }
  | { kind: 'edit'; program: string }
  | { kind: 'delete' };

export function savedEditor() {
  try {
    return localStorage.getItem('dachsterm.editor') ?? 'code';
  } catch {
    return 'code';
  }
}
export function saveEditor(program: string) {
  try {
    localStorage.setItem('dachsterm.editor', program);
  } catch {
    /* The editor still opened; only the remembered choice is lost. */
  }
}
export function savedEditorArgs() {
  try {
    const args: unknown = JSON.parse(localStorage.getItem('dachsterm.editorArgs') ?? '[]');
    return Array.isArray(args) && args.every((a) => typeof a === 'string')
      ? (args as string[])
      : [];
  } catch {
    return [];
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
  return (
    <Dialog title={operation.kind === 'edit' ? '외부 편집기' : '파일 작업'} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {operation.kind === 'delete' ? (
          <p>
            {selection.length}개 항목과 폴더 안의 모든 내용을 삭제합니다. 휴지통을 거치지 않으며
            되돌릴 수 없습니다.
            <br />
            {selection.join(', ')}
          </p>
        ) : operation.kind === 'edit' ? (
          <>
            <label>
              프로그램 경로
              <input
                required
                value={operation.program}
                onChange={(e) => change({ kind: 'edit', program: e.target.value })}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                void call<string | null>('editor_pick')
                  .then((program) => {
                    if (program) change({ kind: 'edit', program });
                  })
                  .catch((e) => fail(errorText(e)))
              }
            >
              프로그램 찾아보기…
            </button>
          </>
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
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" onClick={close}>
            취소
          </button>
          <button className="primary">{operation.kind === 'edit' ? '열기' : '적용'}</button>
        </div>
      </form>
    </Dialog>
  );
}
