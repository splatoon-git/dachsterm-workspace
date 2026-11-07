import { useEffect, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import { Dialog } from '../../components/Dialog';
import type { TerminalSession } from './session';
import { isRecording, refreshLogStatus, useLogStatus } from './logStatus';
import './sessionLog.css';
export const logLabels: Record<string, string> = {
  off: '꺼짐',
  recording: '기록 중',
  paused: '일시정지',
  stopping: '저장 중',
  stopped: '종료',
  error: '오류 · 기록 중단',
};
const labels = logLabels;
/** Session log settings and controls for one connection, opened from its tab menu. */
export function SessionLogDialog({
  session,
  connected,
  close,
}: {
  session: TerminalSession;
  connected: boolean;
  close: () => void;
}) {
  const [auto, setAuto] = useState(false);
  const [directory, setDirectory] = useState('');
  const [timestamps, setTimestamps] = useState(false);
  const [daily, setDaily] = useState(true);
  const [size, setSize] = useState(10);
  const [keep, setKeep] = useState(10);
  const [masks, setMasks] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const id = session.connectionId;
  const autoKey = session.localTarget
    ? `local:${session.localTarget.id}`
    : `ssh:${session.profile.id}`;
  useEffect(() => {
    let live = true;
    void call<{
      directory: string;
      timestamps: boolean;
      maxBytes: number;
      keepFiles: number;
      daily: boolean;
    } | null>('log_auto_get', { key: autoKey })
      .then((saved) => {
        if (!live) return;
        setAuto(!!saved);
        if (saved) {
          setDirectory(saved.directory);
          setTimestamps(saved.timestamps);
          setSize(saved.maxBytes / 1048576);
          setKeep(saved.keepFiles);
          setDaily(saved.daily);
        }
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [autoKey]);
  const status = useLogStatus(id);
  const options = { directory, timestamps, maxBytes: size * 1048576, keepFiles: keep, daily };
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await refreshLogStatus(id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const active = isRecording(status);
  const setAutomatic = (on: boolean) =>
    void run(async () => {
      await call('log_auto', { key: autoKey, options: on ? options : null });
      setAuto(on);
      setNotice(on ? '다음 연결부터 자동으로 기록합니다.' : '자동 기록을 껐습니다.');
    });
  return (
    <Dialog
      title="세션 로그"
      description="터미널 출력만 UTF-8 텍스트로 저장합니다. 입력과 인증 대화는 기록하지 않습니다."
      className="session-log-dialog"
      close={close}
    >
      <div className={`log-state ${status.state}`} role="status">
        <span className="log-dot" aria-hidden="true" />
        <strong>{labels[status.state]}</strong>
        <span>{status.bytes.toLocaleString()}바이트</span>
        {status.message && <span>{status.message}</span>}
        {status.path && <code title={status.path}>{status.path}</code>}
      </div>
      <p className="field-help">
        프로그램이 출력한 비밀은 자동으로 가릴 수 없습니다. 민감한 작업 전에는 일시정지하세요.
      </p>
      <section className="dialog-section">
        <h3>저장 위치</h3>
        <p>기록할 때마다 이 폴더 안에 새 폴더를 만듭니다. 지난 기록은 직접 정리하세요.</p>
        <div className="log-folder">
          <input
            aria-label="저장 폴더"
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            disabled={active || busy}
          />
          <button
            disabled={active || busy}
            onClick={() =>
              void run(async () => {
                const path = await call<string | null>('log_pick');
                if (path) setDirectory(path);
              })
            }
          >
            폴더 선택
          </button>
        </div>
      </section>
      <section className="dialog-section">
        <h3>파일 나누기</h3>
        <p>ANSI 색 코드를 빼고 완성된 줄부터 씁니다. 64KiB가 넘는 줄을 만나면 멈춥니다.</p>
        <div className="log-grid">
          <label>
            파일 하나의 크기 (MiB)
            <input
              type="number"
              min="1"
              max="1024"
              value={size}
              disabled={active}
              onChange={(e) => setSize(Number(e.target.value))}
            />
          </label>
          <label>
            기록당 보관 파일
            <input
              type="number"
              min="1"
              max="100"
              value={keep}
              disabled={active}
              onChange={(e) => setKeep(Number(e.target.value))}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={daily}
              disabled={active}
              onChange={(e) => setDaily(e.target.checked)}
            />
            UTC 날짜가 바뀌면 새 파일
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={timestamps}
              disabled={active}
              onChange={(e) => setTimestamps(e.target.checked)}
            />
            줄마다 타임스탬프 (UTC epoch)
          </label>
        </div>
      </section>
      <section className="dialog-section">
        <h3>가릴 문자열</h3>
        <p>이번 기록에서만 가립니다. 한 줄에 하나씩 쓰며 설정에 저장하지 않습니다.</p>
        <textarea
          aria-label="이번 기록에서 가릴 문자열 (줄당 하나)"
          value={masks}
          disabled={active}
          onChange={(e) => setMasks(e.target.value)}
          autoComplete="off"
        />
      </section>
      <section className="dialog-section">
        <h3>자동 기록</h3>
        <div className="log-auto">
          <p>
            자동 기록: {auto ? '켜짐' : '꺼짐'}. 이 {session.localTarget ? '로컬 환경' : '세션'}에만
            적용되며 가릴 문자열 없이 시작합니다.
          </p>
          {auto ? (
            <button disabled={busy} onClick={() => setAutomatic(false)}>
              자동 기록 끄기
            </button>
          ) : (
            <button disabled={busy || !directory} onClick={() => setAutomatic(true)}>
              이 설정으로 자동 기록 켜기
            </button>
          )}
        </div>
      </section>
      {(error || status.error) && <p role="alert">{error || status.error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="form-actions">
        <button
          className="start danger-quiet"
          disabled={!active || busy}
          onClick={() => void run(() => call('log_action', { id, action: 'stop' }))}
        >
          기록 종료
        </button>
        <button
          disabled={!['recording', 'paused'].includes(status.state) || busy}
          onClick={() =>
            void run(() =>
              call('log_action', {
                id,
                action: status.state === 'paused' ? 'resume' : 'pause',
              }),
            )
          }
        >
          {status.state === 'paused' ? '재개' : '일시정지'}
        </button>
        <button
          className="primary"
          disabled={!connected || active || busy || !directory}
          onClick={() =>
            void run(() =>
              call('log_start', { id, options, masks: masks.split('\n').filter(Boolean) }),
            )
          }
        >
          기록 시작
        </button>
      </div>
    </Dialog>
  );
}
