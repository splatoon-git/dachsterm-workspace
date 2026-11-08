import { useState } from 'react';
import type { ExternalEdit } from '../../lib/externalEdit';
import { editFileName, type EditSaveAnswer } from './editSave';
import './agentSign.css';

type Step = 'choose' | 'overwrite' | 'saveAs';

/**
 * Shown in the pane like the signature card and, like it, takes no focus on its own: keys typed
 * into the terminal cannot answer it. Focus moves only after the user opens a further step.
 */
export function EditSaveCard({
  edit,
  answer,
}: {
  edit: ExternalEdit;
  answer: (answer: EditSaveAnswer) => Promise<void> | void;
}) {
  const [step, setStep] = useState<Step>('choose');
  const [path, setPath] = useState(`${edit.remote}.copy`);
  const conflict = edit.status === 'conflict';
  return (
    <div className="trust-card agent-sign-card" role="alertdialog" aria-label="외부 편집 저장 확인">
      <h2>{conflict ? '서버 파일도 변경되었습니다' : '서버 파일에 업로드할까요?'}</h2>
      <p>
        {conflict
          ? '편집을 시작한 뒤 서버의 내용이 바뀌었습니다. 이 PC의 수정본은 보존되어 있습니다.'
          : '외부 편집기에서 저장한 수정본입니다.'}
      </p>
      <dl>
        <dt>파일</dt>
        <dd>{editFileName(edit)}</dd>
        <dt>서버 경로</dt>
        <dd>
          <code>{edit.remote}</code>
        </dd>
      </dl>
      {step === 'overwrite' && (
        <>
          <p role="status">서버에서 바뀐 내용을 잃습니다. 되돌릴 수 없습니다.</p>
          <div className="form-actions">
            <button autoFocus onClick={() => setStep('choose')}>
              취소
            </button>
            <button className="danger" onClick={() => void answer({ action: 'overwrite' })}>
              덮어쓰기
            </button>
          </div>
        </>
      )}
      {step === 'saveAs' && (
        <form
          className="agent-sign-unlock"
          onSubmit={(e) => {
            e.preventDefault();
            void answer({ action: 'saveAs', path });
          }}
        >
          <label>
            새 서버 경로
            <input
              autoFocus
              autoComplete="off"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button type="button" onClick={() => setStep('choose')}>
              취소
            </button>
            <button type="submit" className="primary" disabled={!path.trim()}>
              업로드
            </button>
          </div>
        </form>
      )}
      {step === 'choose' && (
        <div className="form-actions">
          <button onClick={() => void answer({ action: 'cancel' })}>취소 · 수정본 보존</button>
          {conflict ? (
            <>
              <button onClick={() => void answer({ action: 'reload' })}>다시 받기</button>
              <button onClick={() => setStep('saveAs')}>다른 이름…</button>
              <button onClick={() => setStep('overwrite')}>덮어쓰기…</button>
            </>
          ) : (
            <>
              <button onClick={() => void answer({ action: 'connectionAuto' })}>
                이 연결 동안 자동 업로드
              </button>
              <button className="primary" onClick={() => void answer({ action: 'upload' })}>
                업로드
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
