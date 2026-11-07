import { useEffect, useState } from 'react';
import {
  ContextMenu,
  anchorBelow,
  isMenuKey,
  type MenuItem,
  type MenuPoint,
} from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
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
  const [menu, setMenu] = useState<{ at: MenuPoint; transfer: Transfer } | null>(null);
  const chosen = transfers.filter((t) => selected.includes(t.id));
  const control = (action: string, values: Transfer[]) =>
    void run('transfer_control', { ids: values.map((t) => t.id), action, connectionId, profileId });
  const verb = (t: Transfer) => (t.direction === 'upload' ? '보내기' : '받기');
  // The one action a row shows; everything else is in its menu.
  const main = (t: Transfer) =>
    pausable(t)
      ? { label: '일시 중지', run: () => control('pause', [t]) }
      : resumable(t)
        ? { label: `확인 후 이어서 ${verb(t)}`, run: () => control('resume', [t]) }
        : null;
  const items = (t: Transfer): MenuItem[] => [
    { label: '맨 앞으로', disabled: t.status !== 'queued', run: () => control('first', [t]) },
    {
      label: details === t.id ? '파일별 결과 닫기' : '파일별 결과',
      disabled: !t.files,
      run: () => setDetails(details === t.id ? null : t.id),
    },
    {
      label: '전송 취소',
      separated: true,
      disabled: !(pausable(t) || resumable(t)),
      run: () => control('cancel', [t]),
    },
    {
      label: t.status === 'completed' ? '기록 정리' : '부분 파일 삭제',
      danger: t.status !== 'completed',
      disabled: !(resumable(t) || t.status === 'completed'),
      run: () => discard(t.id),
    },
  ];
  return (
    <section aria-label="전송 큐" className="transfer-queue">
      <p className="encoding-note">
        동시 2개 묶음 · 취소 시 부분 파일·빈 폴더 보존 · 재개는 현재 서버에서 사용자 확인 후 실행
      </p>
      {transfers.length > 0 && (
        <div className="transfer-batch">
          <button
            onClick={() =>
              setSelected(chosen.length === transfers.length ? [] : transfers.map((t) => t.id))
            }
          >
            {chosen.length === transfers.length ? '선택 해제' : '모두 선택'}
          </button>
          {chosen.length > 0 && (
            <>
              <span>{chosen.length}개 선택</span>
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
            </>
          )}
        </div>
      )}
      {transfers.map((t) => {
        const action = main(t);
        return (
          <div
            className="transfer-item"
            key={t.id}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ at: { x: e.clientX, y: e.clientY }, transfer: t });
            }}
          >
            <div className="transfer-head">
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
                />
                <span aria-hidden="true">{t.direction === 'upload' ? '↑' : '↓'}</span>
                <span className="transfer-name" title={t.name}>
                  {t.name.split('/').pop()}
                </span>
              </label>
              <strong className="transfer-status" data-status={t.status}>
                {labels[t.status] ?? t.status}
              </strong>
              {action && <button onClick={action.run}>{action.label}</button>}
              <button
                className="transfer-more"
                aria-label={`${t.name} 전송 작업`}
                aria-haspopup="menu"
                onClick={(e) => setMenu({ at: anchorBelow(e.currentTarget), transfer: t })}
                onKeyDown={(e) => {
                  if (!isMenuKey(e)) return;
                  e.preventDefault();
                  setMenu({ at: anchorBelow(e.currentTarget), transfer: t });
                }}
              >
                <Icon name="more" size={14} />
              </button>
            </div>
            <progress aria-label={`${t.name} 전체 진행률`} value={t.done} max={t.total || 1} />
            <small>
              {size(t.done)} / {size(t.total)} · {t.finished ?? 0} 완료 · {t.skipped ?? 0} 건너뜀 /{' '}
              {t.files ?? 0} 항목 ·{' '}
              {t.conflict === 'overwrite'
                ? '묶음 전체 덮어쓰기'
                : t.conflict === 'rename'
                  ? '동명 이름 변경'
                  : '기존 파일 보존'}
            </small>
            {t.current && (
              <small className="transfer-current" title={t.current}>
                {t.current.split(/[\\/]/).pop()} · {size(t.currentDone ?? 0)} /{' '}
                {size(t.currentTotal ?? 0)}
              </small>
            )}
            {t.message && (
              <small role={t.status === 'failed' ? 'alert' : undefined}>{t.message}</small>
            )}
            {details === t.id && <Results id={t.id} count={t.files ?? 0} />}
          </div>
        );
      })}
      {menu && (
        <ContextMenu
          at={menu.at}
          label={`${menu.transfer.name} 전송 작업`}
          items={items(menu.transfer)}
          close={() => setMenu(null)}
        />
      )}
    </section>
  );
}
