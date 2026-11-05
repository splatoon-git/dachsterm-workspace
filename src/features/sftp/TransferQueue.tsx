import { useEffect, useState } from 'react';
import { call, errorText } from '../../lib/ipc';

export type Transfer = {
  id: string;
  profileId: string;
  connectionId: string;
  name: string;
  direction: string;
  done: number;
  total: number;
  status: string;
  message: string;
  files?: number;
  finished?: number;
  skipped?: number;
  current?: string;
  currentDone?: number;
  currentTotal?: number;
  conflict?: string;
};
type Item = { name: string; status: string; size: number; directory: boolean; message?: string };
const labels: Record<string, string> = {
  queued: '대기',
  scanning: '탐색 중',
  running: '전송 중',
  paused: '일시정지',
  failed: '실패',
  completed: '완료',
  cancelled: '취소',
  discarding: '정리 중',
  pending: '대기',
  transferring: '전송 중',
  committing: '완료 확인 중',
  skipped: '건너뜀',
};
const resumable = (t: Transfer) => ['paused', 'failed', 'cancelled'].includes(t.status);
const pausable = (t: Transfer) => ['queued', 'scanning', 'running'].includes(t.status);
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
function Results({ id, count }: { id: string; count: number }) {
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const poll = () =>
      void call<Item[]>('transfer_items', { id, offset })
        .then((items) => {
          if (alive) setItems(items);
        })
        .catch((e) => {
          if (alive) setError(errorText(e));
        });
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, offset]);
  return (
    <div className="transfer-results">
      {error && <p role="alert">{error}</p>}
      <ul>
        {items.map((item) => (
          <li key={item.name}>
            <span title={item.name}>{item.name}</span>
            <small>
              {labels[item.status] ?? item.status} · {item.directory ? '폴더' : size(item.size)}{' '}
              {item.message}
            </small>
          </li>
        ))}
      </ul>
      <div className="file-toolbar">
        <button disabled={offset === 0} onClick={() => setOffset(offset - 100)}>
          이전 결과
        </button>
        <span>
          {offset + 1}–{Math.min(offset + 100, count)} / {count}
        </span>
        <button disabled={offset + 100 >= count} onClick={() => setOffset(offset + 100)}>
          다음 결과
        </button>
      </div>
    </div>
  );
}
export function TransferQueue({
  transfers,
  connectionId,
  profileId,
  run,
  discard,
}: {
  transfers: Transfer[];
  connectionId: string;
  profileId: string;
  run: (command: string, args: Record<string, unknown>) => Promise<boolean>;
  discard: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [details, setDetails] = useState<string | null>(null);
  const chosen = transfers.filter((t) => selected.includes(t.id));
  const control = (action: string, values: Transfer[]) =>
    void run('transfer_control', { ids: values.map((t) => t.id), action, connectionId, profileId });
  return (
    <section aria-label="전송 큐" className="transfer-queue">
      <p className="encoding-note">
        동시 2개 묶음 · 취소 시 부분 파일·빈 폴더 보존 · 재개는 현재 서버에서 사용자 확인 후 실행
      </p>
      {transfers.length > 0 && (
        <div className="file-toolbar">
          <button
            onClick={() =>
              setSelected(chosen.length === transfers.length ? [] : transfers.map((t) => t.id))
            }
          >
            {chosen.length === transfers.length ? '선택 해제' : '모두 선택'}
          </button>
          <button
            disabled={!chosen.some(pausable)}
            onClick={() => control('pause', chosen.filter(pausable))}
          >
            선택 일시정지
          </button>
          <button
            disabled={!chosen.some(resumable)}
            onClick={() => control('resume', chosen.filter(resumable))}
          >
            선택 재개 확인
          </button>
          <button
            disabled={!chosen.some((t) => pausable(t) || resumable(t))}
            onClick={() =>
              control(
                'cancel',
                chosen.filter((t) => pausable(t) || resumable(t)),
              )
            }
          >
            선택 취소
          </button>
        </div>
      )}
      {transfers.map((t) => (
        <div className="transfer-item" key={t.id}>
          <label>
            <input
              type="checkbox"
              aria-label={`${t.name} 전송 선택`}
              checked={selected.includes(t.id)}
              onChange={(e) =>
                setSelected(
                  e.target.checked ? [...selected, t.id] : selected.filter((id) => id !== t.id),
                )
              }
            />{' '}
            {t.direction === 'upload' ? '↑' : '↓'} {t.name.split('/').pop()}
          </label>
          <strong>{labels[t.status] ?? t.status}</strong>
          <small>
            {t.finished ?? 0} 완료 · {t.skipped ?? 0} 건너뜀 / {t.files ?? 0} 항목 ·{' '}
            {t.conflict === 'overwrite'
              ? '묶음 전체 덮어쓰기'
              : t.conflict === 'rename'
                ? '동명 이름 변경'
                : '기존 파일 보존'}
          </small>
          <progress aria-label={`${t.name} 전체 진행률`} value={t.done} max={t.total || 1} />
          <small>
            {size(t.done)} / {size(t.total)}
          </small>
          {t.current && (
            <small className="transfer-current" title={t.current}>
              {t.current.split(/[\\/]/).pop()} · {size(t.currentDone ?? 0)} /{' '}
              {size(t.currentTotal ?? 0)}
            </small>
          )}
          <small role={t.status === 'failed' ? 'alert' : undefined}>{t.message}</small>
          <div className="file-toolbar">
            {t.status === 'queued' && (
              <button onClick={() => control('first', [t])}>맨 앞으로</button>
            )}
            {pausable(t) && <button onClick={() => control('pause', [t])}>일시 중지</button>}
            {resumable(t) && (
              <button onClick={() => control('resume', [t])}>
                확인 후 이어서 {t.direction === 'upload' ? '보내기' : '받기'}
              </button>
            )}
            {(pausable(t) || resumable(t)) && (
              <button onClick={() => control('cancel', [t])}>전송 취소</button>
            )}
            {(resumable(t) || t.status === 'completed') && (
              <button onClick={() => discard(t.id)}>
                {t.status === 'completed' ? '기록 정리' : '부분 파일 삭제'}
              </button>
            )}
            {!!t.files && (
              <button
                aria-expanded={details === t.id}
                onClick={() => setDetails(details === t.id ? null : t.id)}
              >
                파일별 결과
              </button>
            )}
          </div>
          {details === t.id && <Results id={t.id} count={t.files ?? 0} />}
        </div>
      ))}
    </section>
  );
}
