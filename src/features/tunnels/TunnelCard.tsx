import { useState } from 'react';
import { ContextMenu, anchorBelow, isMenuKey, type MenuPoint } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import type { TerminalSession } from '../terminal/session';
import type { TunnelStatus as Status } from './serverPorts';
import { isActive, tunnelKinds, type TunnelConfig } from './tunnelConfig';

/**
 * One saved tunnel: what it connects and its state, one start or stop button, and the rest
 * (edit, automatic start, delete) in its menu, from the ⋯ button or a right click.
 */
export function TunnelCard({
  config: c,
  profileName,
  instances,
  candidates,
  chosen,
  current,
  statusError,
  busy,
  deleting,
  choose,
  run,
  edit,
  setAutoStart,
  askDelete,
  cancelDelete,
  confirmDelete,
}: {
  config: TunnelConfig;
  profileName?: string;
  /** Running or failed instances of this tunnel, on any connection. */
  instances: Status[];
  /** Connected sessions of the tunnel's server, which could start it. */
  candidates: TerminalSession[];
  chosen?: TerminalSession;
  current?: TerminalSession;
  statusError: string;
  busy: boolean;
  deleting: boolean;
  choose: (connectionId: string) => void;
  /** Starts the tunnel on the chosen connection, or stops every running instance. */
  run: (live: Status[]) => void;
  edit: () => void;
  setAutoStart: (on: boolean) => void;
  askDelete: () => void;
  cancelDelete: () => void;
  confirmDelete: () => void;
}) {
  const [menu, setMenu] = useState<MenuPoint | null>(null);
  const live = instances.filter(isActive);
  const failed = instances.find((s) => s.status === 'error');
  const blocked = busy || !!statusError;
  const state = statusError
    ? '확인 불가'
    : live.some((s) => s.status === 'starting')
      ? '시작 중'
      : live.length
        ? '실행 중'
        : failed
          ? '시작 실패'
          : '중지됨';
  const label = `${c.name} 작업`;
  return (
    <article
      className="tunnel-card"
      aria-label={c.name}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="tunnel-card-main">
        <div className="tunnel-card-title">
          <strong>{c.name}</strong>
          <span
            className="tunnel-state"
            data-state={
              statusError ? 'unknown' : live.length ? 'running' : failed ? 'error' : 'stopped'
            }
          >
            {state}
            {live.length > 1 ? ` · ${live.length}개 연결` : ''}
          </span>
          {c.autoStart && <span className="tunnel-tag">자동 시작</span>}
        </div>
        <p className="tunnel-route">
          {c.kind === 'remote' ? 'SSH 서버' : '내 PC'}{' '}
          <code>127.0.0.1:{live[0]?.port || c.port || '자동'}</code>
          <span aria-hidden="true"> → </span>
          {c.kind === 'dynamic' ? (
            'SSH 서버 → 앱에서 지정한 목적지'
          ) : (
            <>
              {c.kind === 'remote' ? '내 PC 쪽' : '서버 쪽'}{' '}
              <code>
                {c.host}:{c.targetPort}
              </code>
            </>
          )}
        </p>
        <small>
          {tunnelKinds.find((k) => k.id === c.kind)?.name} · SSH: {profileName ?? '삭제된 세션'}
        </small>
        {!live.length && !candidates.length && (
          <small>시작하려면 ‘{profileName ?? '해당 SSH 세션'}’에 먼저 연결하세요.</small>
        )}
        {!live.length && failed && <small className="error">{failed.message}</small>}
        {candidates.length > 1 && !live.length && (
          <label className="tunnel-connection">
            실행할 SSH 연결
            <select value={chosen?.connectionId ?? ''} onChange={(e) => choose(e.target.value)}>
              {candidates.map((s, i) => (
                <option key={s.connectionId} value={s.connectionId}>
                  {s.profile.name} · 연결 {i + 1}
                  {s === current ? ' (현재 탭)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {live.length > 1 && (
          <small>중지하면 이 설정으로 실행 중인 {live.length}개 터널을 모두 멈춥니다.</small>
        )}
      </div>
      <div className="tunnel-card-controls">
        <button
          className={live.length ? '' : 'primary'}
          disabled={blocked || (!live.length && !chosen)}
          onClick={() => run(live)}
        >
          {live.length ? '중지' : '시작'}
        </button>
        <button
          className="tunnel-more"
          aria-label={label}
          aria-haspopup="menu"
          title="수정 · 자동 시작 · 삭제"
          onClick={(e) => setMenu(anchorBelow(e.currentTarget))}
          onKeyDown={(e) => {
            if (!isMenuKey(e)) return;
            e.preventDefault();
            setMenu(anchorBelow(e.currentTarget));
          }}
        >
          <Icon name="more" size={16} />
        </button>
      </div>
      {deleting && (
        <div className="tunnel-delete">
          <span>‘{c.name}’ 설정을 삭제할까요?</span>
          <div className="tunnel-row-actions">
            <button disabled={busy} onClick={cancelDelete}>
              취소
            </button>
            <button
              className="danger-action"
              disabled={blocked || !!live.length}
              onClick={confirmDelete}
            >
              삭제 확인
            </button>
          </div>
        </div>
      )}
      {menu && (
        <ContextMenu
          at={menu}
          label={label}
          close={() => setMenu(null)}
          items={[
            { label: '수정…', disabled: blocked || !!live.length, run: edit },
            {
              label: c.autoStart ? '연결 시 자동 시작 끄기' : '연결 시 자동 시작 켜기',
              disabled: blocked,
              run: () => setAutoStart(!c.autoStart),
            },
            {
              label: '삭제…',
              separated: true,
              danger: true,
              disabled: blocked || !!live.length,
              run: askDelete,
            },
          ]}
        />
      )}
    </article>
  );
}
