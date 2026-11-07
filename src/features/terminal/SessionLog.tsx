import { useEffect, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import { Dialog } from '../../components/Dialog';
import type { TerminalSession } from './session';
import { isRecording, refreshLogStatus, useLogStatus } from './logStatus';
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
  return (
    <Dialog title="세션 로그" close={close}>
      <p>
        터미널 출력만 UTF-8로 저장합니다. 입력 이벤트와 인증 대화는 기록하지 않습니다. 프로그램이
        출력한 비밀은 자동으로 판별할 수 없습니다. 민감한 작업 전에 일시정지하세요.
      </p>
      <p role="status">
        {labels[status.state]} · {status.bytes.toLocaleString()}바이트 · {status.message}
      </p>
      {status.path && <p style={{ overflowWrap: 'anywhere' }}>현재 파일: {status.path}</p>}
      <div className="terminal-preferences">
        <label>
          저장 폴더
          <input
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            disabled={active || busy}
          />
        </label>
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
        <label>
          회전 크기 (MiB)
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
            checked={timestamps}
            disabled={active}
            onChange={(e) => setTimestamps(e.target.checked)}
          />
          줄 타임스탬프 (UTC epoch)
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={daily}
            disabled={active}
            onChange={(e) => setDaily(e.target.checked)}
          />
          UTC 날짜 변경 시 회전
        </label>
        <label>
          이번 기록에서 가릴 문자열 (줄당 하나)
          <textarea
            value={masks}
            disabled={active}
            onChange={(e) => setMasks(e.target.value)}
            autoComplete="off"
          />
        </label>
      </div>
      <p className="muted">
        ANSI를 제거하고 완성된 줄부터 저장합니다. 줄이 64KiB를 넘으면 중단합니다. 일시정지 경계의
        미완성 줄은 버립니다. 매번 새 전용 폴더를 만들며 보관 한도는 이번 기록에만 적용됩니다. 이전
        기록 폴더는 직접 관리하세요. 마스킹 문자열은 설정에 저장하지 않습니다.
      </p>
      {(error || status.error) && <p role="alert">{error || status.error}</p>}
      <div className="form-actions">
        <button
          disabled={!connected || active || busy || !directory}
          onClick={() =>
            void run(() =>
              call('log_start', { id, options, masks: masks.split('\n').filter(Boolean) }),
            )
          }
        >
          기록 시작
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
          disabled={!active || busy}
          onClick={() => void run(() => call('log_action', { id, action: 'stop' }))}
        >
          기록 종료
        </button>
      </div>
      <p>
        자동 기록: {auto ? '켜짐' : '꺼짐'}. 이 세션/로컬 환경에만 적용되며 마스킹 없이 시작합니다.
      </p>
      <div className="form-actions">
        <button
          disabled={busy || !directory}
          onClick={() =>
            void run(async () => {
              await call('log_auto', {
                key: session.localTarget
                  ? `local:${session.localTarget.id}`
                  : `ssh:${session.profile.id}`,
                options,
              });
              setAuto(true);
              setError('다음 연결부터 자동 기록합니다.');
            })
          }
        >
          이 설정으로 자동 기록 켜기
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await call('log_auto', {
                key: session.localTarget
                  ? `local:${session.localTarget.id}`
                  : `ssh:${session.profile.id}`,
                options: null,
              });
              setAuto(false);
              setError('자동 기록을 껐습니다.');
            })
          }
        >
          자동 기록 끄기
        </button>
      </div>
    </Dialog>
  );
}
