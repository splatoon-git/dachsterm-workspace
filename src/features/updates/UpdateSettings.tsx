import { useEffect, useState } from 'react';
import { SettingGroup, SettingRow } from '../../components/SettingRows';
import { desktop, errorText } from '../../lib/ipc';
import {
  checkUpdates,
  checkedText,
  installUpdate,
  isBusy,
  loadUpdates,
  progressPercent,
  progressText,
  separateError,
  setAutoUpdates,
  useUpdateStatus,
  type UpdatePhase,
} from './updateState';
import './updates.css';

function PhaseView({ phase, install }: { phase: UpdatePhase; install: () => void }) {
  switch (phase.state) {
    case 'idle':
      return null;
    case 'checking':
      return <p role="status">새 버전을 확인하는 중…</p>;
    case 'latest':
      return <p role="status">최신 버전입니다. 마지막 확인 {checkedText(phase.checked)}</p>;
    case 'failed':
      return <p role="alert">{phase.message}</p>;
    case 'installing':
      return <p role="status">{phase.version} 설치 중… 곧 앱이 다시 시작합니다.</p>;
    case 'downloading': {
      const percent = progressPercent(phase);
      return (
        <div className="update-progress" role="status">
          <span>
            {phase.version} 내려받는 중 · {progressText(phase)}
          </span>
          <progress aria-label="내려받기 진행" max={100} value={percent ?? undefined} />
        </div>
      );
    }
    case 'available':
      return (
        <div className="update-available">
          <p>
            설치할 수 있는 새 버전: <strong>{phase.version}</strong>
          </p>
          {phase.notes && <pre className="update-notes">{phase.notes}</pre>}
          <p className="field-help">
            설치하면 열린 연결과 터미널을 모두 닫고 앱을 다시 시작합니다. 저장된 세션과 전송
            대기열은 그대로 남습니다.
          </p>
          <div className="form-actions">
            <button className="primary" onClick={install}>
              내려받아 설치
            </button>
          </div>
        </div>
      );
  }
}

/** Settings → 업데이트: the version, the automatic check, and installing what it found. */
export function UpdateSettings() {
  const status = useUpdateStatus();
  const [error, setError] = useState('');
  useEffect(() => {
    void loadUpdates().catch((e) => setError(errorText(e)));
  }, []);
  const run = (action: () => Promise<void>) => {
    setError('');
    void action().catch((e) => setError(errorText(e)));
  };
  if (!desktop)
    return <p className="dialog-empty">데스크톱 앱에서 새 버전을 확인하고 설치합니다.</p>;
  if (!status) return error ? <p role="alert">{error}</p> : <p role="status">불러오는 중…</p>;
  const busy = isBusy(status.phase);
  const blocked = Boolean(status.unavailable);
  return (
    <div className="update-settings">
      <SettingGroup title="버전">
        <SettingRow label="현재 버전">
          <span className="update-version">{status.current}</span>
        </SettingRow>
        <SettingRow label="새 버전 자동 확인">
          <input
            type="checkbox"
            className="switch"
            checked={status.auto}
            disabled={blocked}
            onChange={(e) => run(() => setAutoUpdates(e.target.checked))}
          />
        </SettingRow>
      </SettingGroup>
      <p className="field-help">
        켜 두면 앱을 시작할 때와 하루에 한 번 공개 배포 위치에서 새 버전 정보를 받아 옵니다. 이
        요청에는 세션·계정 정보가 들어가지 않습니다. 새 버전은 내려받은 뒤 배포 서명을 확인하고,
        설치는 사용자가 누를 때만 합니다.
      </p>
      {status.unavailable && <p className="update-unavailable">{status.unavailable}</p>}
      <PhaseView phase={status.phase} install={() => run(installUpdate)} />
      {separateError(status.phase, error) && <p role="alert">{error}</p>}
      <div className="form-actions">
        <button disabled={busy || blocked} onClick={() => run(() => checkUpdates(false))}>
          지금 확인
        </button>
      </div>
    </div>
  );
}
