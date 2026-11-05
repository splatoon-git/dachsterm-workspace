import { useEffect, useState } from 'react';
import { call, desktop, errorText } from '../../lib/ipc';

type RecoveryFile = { id: string; modified: number };
export function MaintenancePanel({ restored }: { restored: () => void }) {
  const [files, setFiles] = useState<RecoveryFile[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const refresh = async () => setFiles(await call<RecoveryFile[]>('recovery_list'));
  useEffect(() => {
    if (desktop)
      void call<RecoveryFile[]>('recovery_list')
        .then(setFiles)
        .catch((e) => setError(errorText(e)));
  }, []);
  async function run(kind: 'create' | 'restore' | 'diagnostics') {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (kind === 'create') {
        await call('recovery_create');
        setMessage('설정 복구본을 만들었습니다.');
        await refresh();
      } else if (kind === 'restore') {
        const count = await call<number>('recovery_restore', { id: selected });
        setMessage(`${count}개 세션을 추가했습니다. 저장 암호는 다시 입력하세요.`);
        setConfirm(false);
        setSelected('');
        await refresh();
        restored();
      } else if (await call<boolean>('diagnostics_export')) {
        setMessage('진단 파일을 저장했습니다.');
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-data" aria-label="복구와 진단">
      <h3>복구와 진단</h3>
      <p className="muted">
        세션·그룹 삭제와 설정 가져오기 전에 복구본을 만듭니다. 최근 10개를 이 PC에 보관하며,
        암호·개인키 내용·신뢰한 호스트키·편집 파일은 포함하지 않습니다. 다른 PC에 보관하려면 JSON
        내보내기를 사용하세요.
      </p>
      <div className="form-actions">
        <button disabled={busy || !desktop} onClick={() => void run('create')}>
          설정 복구본 만들기
        </button>
        <button disabled={busy || !desktop} onClick={() => void run('diagnostics')}>
          진단 파일 저장
        </button>
      </div>
      <label>
        저장된 설정 복구본
        <select
          value={selected}
          disabled={busy}
          onChange={(e) => {
            setSelected(e.target.value);
            setConfirm(false);
          }}
        >
          <option value="">복구본 선택</option>
          {files.map((file) => (
            <option key={file.id} value={file.id}>
              {new Date(file.modified * 1000).toLocaleString()} · {file.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      <div className="form-actions">
        <button disabled={!selected || busy} onClick={() => setConfirm(true)}>
          선택한 복구본 가져오기
        </button>
      </div>
      {confirm && (
        <div>
          <p>
            기존 세션은 유지하고 복구본의 세션을 새 ID로 추가합니다. 같은 서버가 중복될 수 있으며
            자동 터널 시작은 꺼집니다.
          </p>
          <div className="form-actions">
            <button disabled={busy} onClick={() => void run('restore')}>
              세션 추가 확인
            </button>
            <button disabled={busy} onClick={() => setConfirm(false)}>
              취소
            </button>
          </div>
        </div>
      )}
      <p className="muted">
        진단 파일에는 앱 버전·OS 종류·DB 검사 결과·작업 개수만 포함됩니다. 서버 주소, 사용자 이름,
        경로, 터미널 출력과 인증정보는 수집하지 않습니다.
      </p>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
