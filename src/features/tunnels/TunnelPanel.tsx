import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { call, errorText, type Profile } from '../../lib/ipc';
import type { TerminalSession } from '../terminal/session';
import { ServerPortsButton } from './ForwardPortDialog';
import type { TunnelStatus as Status } from './serverPorts';
import { TunnelCard } from './TunnelCard';
import { belongsTo, isActive, tunnelKinds, type TunnelConfig } from './tunnelConfig';
import './tunnels.css';

export function TunnelPanel({
  session,
  sessions,
  profiles,
  close,
}: {
  session?: TerminalSession;
  sessions: TerminalSession[];
  profiles: Profile[];
  close: () => void;
}) {
  const sshProfiles = profiles.filter((p) => p.protocol === 'ssh');
  const [configs, setConfigs] = useState<TunnelConfig[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [draft, setDraft] = useState<TunnelConfig | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [connectionChoices, setConnectionChoices] = useState<Record<string, string>>({});
  const [, rerender] = useState(0);
  const focusTarget = useRef<HTMLHeadingElement>(null);
  const draftId = draft?.id;
  useEffect(() => {
    focusTarget.current?.focus();
  }, [draftId]);
  useEffect(() => {
    const unsubscribe = sessions.map((s) => s.subscribe(() => rerender((n) => n + 1)));
    return () => unsubscribe.forEach((fn) => fn());
  }, [sessions]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    void call<TunnelConfig[]>('tunnel_configs')
      .then((v) => {
        if (alive) {
          setConfigs(v);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    const poll = async () => {
      try {
        const next = await call<Status[]>('tunnel_list');
        if (alive) {
          setStatuses(next);
          setStatusError('');
        }
      } catch (e) {
        if (alive) setStatusError(errorText(e));
      }
      if (alive) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  async function perform(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function save(next: TunnelConfig[]) {
    await call('tunnel_save', { configs: next });
    setConfigs(next);
  }
  async function ensureStopped(config: TunnelConfig) {
    const latest = await call<Status[]>('tunnel_list');
    setStatuses(latest);
    if (latest.some((s) => belongsTo(s, config) && isActive(s)))
      throw '실행 중인 터널을 먼저 중지하세요. 연결 중 자동 시작되었을 수 있습니다.';
  }
  function newTunnel() {
    setError('');
    setNotice('');
    setDraft({
      id: crypto.randomUUID(),
      profileId:
        sshProfiles.find((p) => p.id === session?.profile.id)?.id ?? sshProfiles[0]?.id ?? '',
      name: '새 터널',
      kind: 'local',
      port: 8080,
      host: '127.0.0.1',
      targetPort: 80,
      autoStart: false,
    });
  }
  const ready = sessions.filter(
    (s) => !s.localTarget && s.profile.protocol === 'ssh' && s.snapshot().status === 'connected',
  );
  const selectedProfile = sshProfiles.find((p) => p.id === draft?.profileId);
  const editing = configs.some((c) => c.id === draft?.id);
  const draftRunning = draft && statuses.some((s) => belongsTo(s, draft) && isActive(s));
  const remote = draft?.kind === 'remote';
  const dynamic = draft?.kind === 'dynamic';
  return (
    <Dialog
      title="SSH 터널"
      description="서버의 서비스를 내 PC에서, 내 PC의 서비스를 서버에서 쓰도록 잇습니다. 창을 닫아도 실행 중인 터널은 유지됩니다."
      className="tunnel-dialog"
      close={() => {
        if (!busyRef.current) close();
      }}
    >
      {error && <p role="alert">{error}</p>}
      {statusError && <p role="alert">상태를 확인할 수 없습니다. {statusError}</p>}
      <p className="tunnel-notice" role="status">
        {busy ? '처리 중…' : notice}
      </p>
      {!draft ? (
        <>
          <div className="tunnel-list-heading">
            <div>
              <h3 ref={focusTarget} tabIndex={-1}>
                저장된 터널 <span className="count">{configs.length}</span>
              </h3>
            </div>
            <div className="tunnel-list-actions">
              <ServerPortsButton sessions={ready} current={session} />
              <button
                className="primary"
                disabled={!loaded || busy || !sshProfiles.length}
                onClick={newTunnel}
              >
                <Icon name="plus" size={16} />새 터널
              </button>
            </div>
          </div>
          {!sshProfiles.length && (
            <p className="tunnel-hint">
              연결 목록에서 SSH 서버 세션을 먼저 저장하세요. FTP와 로컬 셸은 터널에 사용할 수
              없습니다.
            </p>
          )}
          {!loaded ? (
            <p className="muted">
              {error
                ? '목록을 불러오지 못했습니다. 창을 다시 열어 재시도하세요.'
                : '터널 목록 불러오는 중…'}
            </p>
          ) : !configs.length ? (
            <div className="tunnel-empty">
              <Icon name="tunnel" size={32} />
              <strong>아직 저장된 터널이 없습니다</strong>
              <p>
                서버의 웹·DB 서비스에 접속하거나 내 PC의 서비스를 연결해 보세요.
                <br />
                ‘새 터널’에서 연결 방향을 보며 설정할 수 있습니다.
              </p>
            </div>
          ) : (
            <div className="tunnel-list" aria-label="저장된 터널 목록">
              {configs.map((c) => {
                const candidates = ready.filter((s) => s.profile.id === c.profileId);
                const chosen =
                  candidates.find((s) => s.connectionId === connectionChoices[c.id]) ??
                  candidates.find((s) => s === session) ??
                  candidates[0];
                const edit = () => {
                  setDraft({ ...c });
                  setError('');
                  setNotice('');
                };
                return (
                  <TunnelCard
                    key={c.id}
                    config={c}
                    profileName={sshProfiles.find((p) => p.id === c.profileId)?.name}
                    instances={statuses.filter((s) => belongsTo(s, c))}
                    candidates={candidates}
                    chosen={chosen}
                    current={session}
                    statusError={statusError}
                    busy={busy}
                    deleting={deleting === c.id}
                    choose={(id) => setConnectionChoices({ ...connectionChoices, [c.id]: id })}
                    run={(live) =>
                      void perform(async () => {
                        if (live.length) {
                          for (const s of live) await call('tunnel_stop', { id: s.id });
                          setNotice(
                            '중지 요청을 보냈습니다. 리스너 정리가 끝나면 중지됨으로 표시됩니다.',
                          );
                        } else if (chosen) {
                          await call('tunnel_start', { id: chosen.connectionId, config: c });
                          setNotice(`${c.name} 터널을 시작했습니다.`);
                        }
                        setStatuses(await call<Status[]>('tunnel_list'));
                      })
                    }
                    edit={edit}
                    setAutoStart={(autoStart) =>
                      void perform(async () => {
                        await save(configs.map((v) => (v.id === c.id ? { ...v, autoStart } : v)));
                        setNotice(
                          autoStart
                            ? '다음 SSH 연결·재접속부터 자동으로 시작합니다.'
                            : '자동 시작을 껐습니다.',
                        );
                      })
                    }
                    askDelete={() => setDeleting(c.id)}
                    cancelDelete={() => setDeleting(null)}
                    confirmDelete={() =>
                      void perform(async () => {
                        await ensureStopped(c);
                        await save(configs.filter((v) => v.id !== c.id));
                        setDeleting(null);
                        setNotice('터널 설정을 삭제했습니다.');
                      })
                    }
                  />
                );
              })}
            </div>
          )}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              await ensureStopped(draft);
              const next = {
                ...draft,
                name: draft.name.trim(),
                host: draft.kind === 'dynamic' ? '127.0.0.1' : draft.host.trim(),
                targetPort: draft.kind === 'dynamic' ? 80 : draft.targetPort,
              };
              if (!next.name) throw '터널 이름을 입력하세요.';
              if (!sshProfiles.some((p) => p.id === next.profileId))
                throw 'SSH 서버 세션을 선택하세요.';
              await save(
                editing ? configs.map((c) => (c.id === next.id ? next : c)) : [...configs, next],
              );
              setDraft(null);
              setNotice('설정을 저장했습니다. 목록에서 시작할 수 있습니다.');
            });
          }}
        >
          <h3 ref={focusTarget} tabIndex={-1}>
            {editing ? '터널 수정' : '새 터널 만들기'}
          </h3>
          <fieldset className="tunnel-editor-fields" disabled={busy}>
            <fieldset className="tunnel-kind-picker">
              <legend>1. 어떤 연결이 필요한가요?</legend>
              <div className="tunnel-kind-options">
                {tunnelKinds.map((kind) => (
                  <label className="tunnel-kind" key={kind.id}>
                    <input
                      type="radio"
                      name="tunnel-kind"
                      value={kind.id}
                      checked={draft.kind === kind.id}
                      onChange={() => setDraft({ ...draft, kind: kind.id })}
                    />
                    <span>
                      <strong>{kind.name}</strong>
                      <small>{kind.code}</small>
                      <small>{kind.description}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <section className="tunnel-flow-section" aria-label="터널 연결 흐름">
              <h4>2. 연결 흐름에 맞춰 입력하세요</h4>
              <p className="muted">
                {remote
                  ? 'SSH 서버에서 포트를 열고, 요청을 내 PC가 접근할 수 있는 서비스로 전달합니다.'
                  : dynamic
                    ? '내 PC의 앱에 SOCKS5 프록시를 지정하면 SSH 서버를 통해 접속합니다.'
                    : '내 PC의 포트에 접속하면 SSH 서버를 통해 목적지 서비스로 연결합니다.'}
              </p>
              <div className="tunnel-flow">
                <div className="tunnel-node">
                  <div className="tunnel-node-heading">
                    <Icon name={remote ? 'server' : 'terminal'} />
                    <strong>{remote ? 'SSH 서버에서 접속' : '내 PC에서 접속'}</strong>
                  </div>
                  <small>접속 주소 · 127.0.0.1:{draft.port || '자동 배정'}</small>
                  <label>
                    {remote ? 'SSH 서버에서 열 포트' : '내 PC에서 열 포트'}
                    <input
                      aria-label="리스닝 포트"
                      type="number"
                      min="0"
                      max="65535"
                      required
                      value={draft.port}
                      onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
                    />
                  </label>
                  <small>0을 입력하면 빈 포트를 자동 배정합니다.</small>
                </div>
                <div className="tunnel-flow-arrow" aria-hidden="true">
                  <Icon name="arrow" />
                </div>
                <div className="tunnel-node tunnel-node-ssh">
                  <div className="tunnel-node-heading">
                    <Icon name="tunnel" />
                    <strong>SSH 보안 연결</strong>
                  </div>
                  <label>
                    서버 세션
                    <select
                      required
                      value={draft.profileId}
                      onChange={(e) => setDraft({ ...draft, profileId: e.target.value })}
                    >
                      <option value="" disabled>
                        SSH 세션 선택
                      </option>
                      {sshProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <small>
                    {selectedProfile
                      ? `${selectedProfile.username}@${selectedProfile.host}:${selectedProfile.port}`
                      : '저장된 SSH 세션이 필요합니다.'}
                  </small>
                  <small>{remote ? 'SSH 서버 → 내 PC' : '내 PC → SSH 서버'}</small>
                </div>
                <div className="tunnel-flow-arrow" aria-hidden="true">
                  <Icon name="arrow" />
                </div>
                <div className="tunnel-node">
                  <div className="tunnel-node-heading">
                    <Icon name={remote ? 'terminal' : 'server'} />
                    <strong>
                      {dynamic
                        ? '앱에서 정한 목적지'
                        : remote
                          ? '내 PC 쪽 서비스'
                          : '서버 쪽 서비스'}
                    </strong>
                  </div>
                  {dynamic ? (
                    <>
                      <p className="muted">
                        브라우저·앱의 프록시 설정에서 SOCKS5와 왼쪽 접속 주소를 입력하세요.
                      </p>
                      <small>
                        TCP CONNECT 지원. 도메인을 프록시로 보내는 앱 설정을 사용하면 SSH 서버에서
                        이름을 해석합니다.
                      </small>
                    </>
                  ) : (
                    <>
                      <label>
                        목적지 호스트
                        <input
                          required
                          maxLength={253}
                          value={draft.host}
                          onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                        />
                      </label>
                      <label>
                        목적지 포트
                        <input
                          type="number"
                          min="1"
                          max="65535"
                          required
                          value={draft.targetPort}
                          onChange={(e) =>
                            setDraft({ ...draft, targetPort: Number(e.target.value) })
                          }
                        />
                      </label>
                    </>
                  )}
                </div>
              </div>
              <p className="tunnel-hint">
                {remote
                  ? '목적지 127.0.0.1은 내 PC를 뜻합니다. 열린 포트는 SSH 서버 자신에서만 접속할 수 있으며, 서버가 원격 포워딩을 허용해야 합니다.'
                  : dynamic
                    ? '프록시는 내 PC에서만 접속할 수 있습니다. 모든 앱의 네트워크를 자동으로 바꾸지는 않습니다.'
                    : '목적지 127.0.0.1은 SSH 서버 자신을 뜻합니다. 열린 포트는 내 PC에서만 접속할 수 있습니다.'}
              </p>
            </section>
            <section className="tunnel-save-section">
              <h4>3. 목록에 저장할 이름과 시작 방식</h4>
              <div className="form-grid">
                <label>
                  이름
                  <input
                    required
                    maxLength={100}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={draft.autoStart}
                    onChange={(e) => setDraft({ ...draft, autoStart: e.target.checked })}
                  />
                  이 세션 연결·재접속 시 자동 시작
                </label>
              </div>
            </section>
          </fieldset>
          {draftRunning && (
            <p role="alert" className="error">
              이 터널이 실행 중입니다. 목록으로 돌아가 중지한 뒤 저장하세요.
            </p>
          )}
          <div className="form-actions">
            <span className="muted">저장 후 목록에서 시작할 수 있습니다.</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setError('');
              }}
            >
              취소
            </button>
            <button
              className="primary"
              disabled={busy || !!draftRunning || !!statusError || !draft.profileId}
            >
              {busy ? '저장 중…' : '설정 저장'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
