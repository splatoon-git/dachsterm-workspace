import { useEffect, useState, useSyncExternalStore } from 'react';
import type { TerminalSession } from '../terminal/session';
import { call, errorText } from '../../lib/ipc';
import { Icon } from '../../components/Icon';
import { MetricChart } from '../../components/MetricChart';
type Sample = {
  at: number;
  cpu: number | null;
  memoryTotal: number;
  memoryUsed: number;
  rx: number | null;
  tx: number | null;
  load: string;
  disks: { mount: string; total: number; used: number; available: number }[];
  interfaces: string[];
};
type Monitor = {
  connectionId: string;
  enabled: boolean;
  interval: number;
  interface: string;
  status: string;
  message: string;
  history: Sample[];
};
const rate = (n: number | null | undefined) =>
  n == null ? '측정 중' : `${(n / 1024).toFixed(1)} KB/s`;
const percent = (n: number | null | undefined) => (n == null ? '측정 중' : `${n.toFixed(1)}%`);
export function MonitorBar({ session }: { session: TerminalSession }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const id = session.connectionId;
  const [view, setView] = useState<Monitor | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.status !== 'connected') return;
    let alive = true;
    let pending = false;
    async function poll() {
      if (pending) return;
      pending = true;
      try {
        let data = await call<Monitor | null>('monitor_get', { id });
        if (!data) {
          await call('monitor_configure', {
            id,
            enabled: localStorage.getItem('dachsterm.monitor') !== 'false',
            interval: Number(localStorage.getItem('dachsterm.interval')) || 5,
            interface: 'all',
          });
          data = await call<Monitor | null>('monitor_get', { id });
        }
        if (alive) {
          setView(data);
          setNow(Date.now());
        }
      } catch (e) {
        if (alive) setError(errorText(e));
      } finally {
        pending = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, state.status]);
  const current = view?.connectionId === id ? view.history.at(-1) : undefined;
  const stale =
    state.status !== 'connected' ||
    view?.status === 'error' ||
    (current && now - current.at > (view?.interval ?? 5) * 2500);
  async function configure(enabled: boolean, interval: number, network: string) {
    try {
      await call('monitor_configure', { id, enabled, interval, interface: network });
      localStorage.setItem('dachsterm.monitor', String(enabled));
      localStorage.setItem('dachsterm.interval', String(interval));
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }
  const memory = current ? (current.memoryUsed / current.memoryTotal) * 100 : null;
  const disk = current?.disks.find((d) => d.mount === '/');
  return (
    <div
      className={`monitor ${stale ? 'stale' : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {open && (
        <section className="monitor-details" aria-label="서버 모니터링 상세">
          <div className="monitor-heading">
            <div>
              <strong>{session.profile.name}</strong>
              <small>
                {view?.message ?? '측정 준비 중'}
                {stale ? ' · 오래된 값' : ''}
                {current ? ` · ${new Date(current.at).toLocaleTimeString()}` : ''}
              </small>
            </div>
            <div className="monitor-options">
              <label>
                <input
                  type="checkbox"
                  checked={view?.enabled ?? true}
                  onChange={(e) =>
                    void configure(e.target.checked, view?.interval ?? 5, view?.interface ?? 'all')
                  }
                />
                수집
              </label>
              <label>
                주기
                <select
                  value={view?.interval ?? 5}
                  onChange={(e) =>
                    void configure(
                      view?.enabled ?? true,
                      Number(e.target.value),
                      view?.interface ?? 'all',
                    )
                  }
                >
                  {[2, 5, 10, 30, 60].map((n) => (
                    <option value={n} key={n}>
                      {n}초
                    </option>
                  ))}
                </select>
              </label>
              <label>
                NET
                <select
                  value={view?.interface ?? 'all'}
                  onChange={(e) =>
                    void configure(view?.enabled ?? true, view?.interval ?? 5, e.target.value)
                  }
                >
                  <option value="all">전체 (lo 제외)</option>
                  {current?.interfaces.map((i) => (
                    <option key={i}>{i}</option>
                  ))}
                </select>
              </label>
              <button aria-label="모니터링 상세 닫기" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
          </div>
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          <div className="monitor-charts">
            <MetricChart
              label="CPU"
              values={view?.history.map((s) => s.cpu) ?? []}
              unit="%"
              max={100}
              color={0}
            />
            <MetricChart
              label="RAM"
              values={view?.history.map((s) => (s.memoryUsed / s.memoryTotal) * 100) ?? []}
              unit="%"
              max={100}
              color={1}
            />
            <MetricChart
              label="NET ↓"
              values={view?.history.map((s) => (s.rx === null ? null : s.rx / 1024)) ?? []}
              unit=" KB/s"
              max={Math.max(...(view?.history.map((s) => (s.rx ?? 0) / 1024) ?? [1]))}
              color={2}
            />
          </div>
          <div className="disk-list">
            <span>Load {current?.load ?? '측정 중'}</span>
            {current?.disks.map((d) => (
              <span key={d.mount} title={`가용 ${(d.available / 1073741824).toFixed(1)} GB`}>
                {d.mount} · {percent(d.total ? (d.used / d.total) * 100 : 0)}
              </span>
            ))}
          </div>
        </section>
      )}
      <button
        className="monitor-bar"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${session.profile.host} 서버 모니터 · ↓ ${rate(current?.rx)} · ↑ ${rate(current?.tx)} · DISK ${disk ? percent((disk.used / disk.total) * 100) : '—'}`}
      >
        <Icon name="activity" size={13} />
        CPU <b>{percent(current?.cpu)}</b> · RAM <b>{percent(memory)}</b>
        {stale ? <small>오래된 값</small> : view?.enabled === false && <small>수집 꺼짐</small>}
      </button>
    </div>
  );
}
