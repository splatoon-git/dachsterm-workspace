import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { call, errorText } from '../../lib/ipc';
import type { TerminalSession } from '../terminal/session';
import {
  browserUrl,
  connectHost,
  linkTarget,
  openTemporaryTunnel,
  runningTemporary,
  visiblePorts,
  type ServerPort,
  type Target,
  type TunnelStatus,
} from './serverPorts';
import './tunnels.css';

/** Opens a server's port on this PC. A tunnel starts only after the user picks one here. */
export function ForwardPortDialog({
  session,
  link,
  close,
}: {
  session: TerminalSession;
  link?: string;
  close: () => void;
}) {
  const id = session.connectionId;
  const [ports, setPorts] = useState<ServerPort[] | null>(null);
  const [portError, setPortError] = useState('');
  const [running, setRunning] = useState<TunnelStatus[]>([]);
  const [showSystem, setShowSystem] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setPortError('');
    const [listed, statuses] = await Promise.all([
      call<ServerPort[]>('remote_ports', { id }).catch((e) => {
        setPortError(errorText(e));
        return null;
      }),
      call<TunnelStatus[]>('tunnel_list').catch(() => []),
    ]);
    setPorts(listed);
    setRunning(runningTemporary(statuses, id));
  }, [id]);
  useEffect(() => {
    // Asked once on opening and on request. A server is never polled for this.
    let alive = true;
    void Promise.resolve().then(() => {
      if (alive) void refresh();
    });
    return () => {
      alive = false;
    };
  }, [refresh]);
  const target = link ? linkTarget(link) : null;
  async function open(next: Target, url?: string) {
    setBusy(true);
    setError('');
    try {
      const port = await openTemporaryTunnel(id, session.profile.id, next);
      await call('url_open', { url: browserUrl(url, port) });
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function stop(tunnel: TunnelStatus) {
    try {
      await call('tunnel_stop', { id: tunnel.id });
      setRunning((list) => list.filter((t) => t.id !== tunnel.id));
    } catch (e) {
      setError(errorText(e));
    }
  }
  const listed = ports && visiblePorts(ports, showSystem);
  return (
    <Dialog title="서버 포트 열기" className="forward-port-dialog" close={close}>
      <p className="muted">
        {session.profile.name}의 포트를 내 PC의 127.0.0.1로 연결합니다. 저장되지 않고 연결이 끝나면
        함께 닫힙니다.
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {link && target && (
        <div className="forward-port-link">
          <code>{link}</code>
          <button className="primary" disabled={busy} onClick={() => void open(target, link)}>
            터널 열고 브라우저로 열기
          </button>
        </div>
      )}
      {running.length > 0 && (
        <section aria-label="실행 중인 임시 터널">
          <h3>실행 중</h3>
          {running.map((tunnel) => (
            <div className="forward-port-row" key={tunnel.id}>
              <span>
                내 PC <code>127.0.0.1:{tunnel.port}</code> → 서버{' '}
                <code>
                  {tunnel.host}:{tunnel.targetPort}
                </code>
              </span>
              <button
                onClick={() =>
                  void call('url_open', { url: browserUrl(undefined, tunnel.port) }).catch((e) =>
                    setError(errorText(e)),
                  )
                }
              >
                브라우저로 열기
              </button>
              <button onClick={() => void stop(tunnel)}>중지</button>
            </div>
          ))}
        </section>
      )}
      <section aria-label="서버에서 대기 중인 포트">
        <div className="forward-port-heading">
          <h3>서버에서 대기 중인 포트</h3>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={showSystem}
              onChange={(e) => setShowSystem(e.target.checked)}
            />
            1024 미만도 표시
          </label>
          <button disabled={busy} onClick={() => void refresh()}>
            새로고침
          </button>
        </div>
        {portError && <p className="muted">{portError}</p>}
        {!portError && !listed && <p className="muted">포트 목록을 읽는 중입니다.</p>}
        {listed?.length === 0 && <p className="muted">표시할 포트가 없습니다.</p>}
        {listed?.map((port) => (
          <div className="forward-port-row" key={`${port.host}:${port.port}`}>
            <span>
              <code>
                {port.host}:{port.port}
              </code>
            </span>
            <button
              disabled={busy}
              aria-label={`포트 ${port.port} 열기`}
              onClick={() => void open({ host: connectHost(port.host), port: port.port })}
            >
              열기
            </button>
          </div>
        ))}
      </section>
    </Dialog>
  );
}

/** The tunnel panel's way in. It uses the current tab, or the first connected server. */
export function ServerPortsButton({
  sessions,
  current,
}: {
  sessions: TerminalSession[];
  current?: TerminalSession;
}) {
  const [open, setOpen] = useState(false);
  const session = sessions.find((s) => s === current) ?? sessions[0];
  return (
    <>
      <button
        disabled={!session}
        title={session ? undefined : 'SSH 서버에 먼저 연결하세요'}
        onClick={() => setOpen(true)}
      >
        서버 포트 보기
      </button>
      {open && session && <ForwardPortDialog session={session} close={() => setOpen(false)} />}
    </>
  );
}
