import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import { KubeSetup } from './KubeSetup';
import {
  finishesAfterRecheck,
  kubeScreens,
  opensDirectly,
  settingsFrom,
  type DetectRequest,
  type Detection,
  type KubeDisplay,
  type KubeScreen,
} from './kubeModel';
import './kube.css';

export type KubeCopyResult = { blocked: string } | { typed: 'run' | 'wait' };

type Phase =
  | { name: 'detecting' }
  | { name: 'setup'; detection: Detection }
  /** `offline` says the saved cluster could not be reached when the tab opened. */
  | { name: 'open'; settings: KubeSettings; offline: boolean };

/**
 * The tab's header and the screen under it. The server terminal is a sibling that the pane shows
 * or hides, so its shell keeps running while this is on screen. Keyed by connection: a reconnect
 * detects again and types nothing.
 */
export function KubeWorkspace({
  connectionId,
  persist,
  display,
  showTerminal,
  showWorkspace,
  copy,
}: {
  connectionId: string;
  /** Saved only for a session opened as a Kubernetes session. */
  persist: boolean;
  display: Exclude<KubeDisplay, 'off'>;
  showTerminal: () => void;
  showWorkspace: () => void;
  copy: (command: string) => KubeCopyResult;
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'detecting' });
  const [screen, setScreen] = useState<KubeScreen>('dashboard');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const latest = useRef(0);

  const finish = useCallback(
    async (settings: KubeSettings) => {
      if (persist) await call('kube_save', { id: connectionId, kube: settings });
      setNote('');
      setPhase({ name: 'open', settings, offline: false });
    },
    [connectionId, persist],
  );

  const detect = useCallback(
    (request: DetectRequest, context: string | null) =>
      call<Detection>('kube_detect', { id: connectionId, request, context }),
    [connectionId],
  );

  /** Only the newest request may change the screen. */
  const settle = useCallback(
    (pending: Promise<Detection>, recheck: boolean) => {
      const ticket = ++latest.current;
      void pending
        .then((detection) => {
          if (ticket !== latest.current) return;
          if (opensDirectly(detection) && detection.saved) {
            setPhase({
              name: 'open',
              settings: detection.saved,
              offline: detection.state.kind === 'unreachable',
            });
          } else if (recheck && finishesAfterRecheck(detection)) {
            return finish(settingsFrom(detection, detection.context, ''));
          } else {
            setPhase({ name: 'setup', detection });
          }
        })
        .catch((e: unknown) => {
          if (ticket === latest.current) setError(errorText(e));
        })
        .finally(() => {
          if (ticket === latest.current) setBusy(false);
        });
    },
    [finish],
  );

  useEffect(() => {
    settle(detect({ mode: 'saved' }, null), false);
    const tickets = latest;
    return () => {
      tickets.current++;
    };
  }, [detect, settle]);

  const run = (request: DetectRequest, context: string | null, recheck: boolean) => {
    setBusy(true);
    setError('');
    settle(detect(request, context), recheck);
  };

  const recheck = (request: DetectRequest) => {
    setNote('');
    showWorkspace();
    run(request, null, true);
  };

  const copyToTerminal = (command: string) => {
    const result = copy(command);
    if ('blocked' in result) setNote(result.blocked);
    else
      setNote(
        result.typed === 'run'
          ? '터미널에 sudo 암호를 입력한 뒤 다시 확인을 누르세요.'
          : '터미널에 명령을 넣었습니다. Enter를 누르고 sudo 암호를 입력한 뒤 다시 확인을 누르세요.',
      );
  };

  const detection = phase.name === 'setup' ? phase.detection : null;
  const settingUp = phase.name !== 'open';
  return (
    <div className={`kube-workspace ${display === 'terminal' ? 'on-terminal' : ''}`}>
      <div className="kube-header" role="tablist" aria-label="쿠버네티스 화면">
        {kubeScreens.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={display === 'workspace' && screen === id}
            onClick={() => {
              setScreen(id);
              showWorkspace();
            }}
          >
            {label}
          </button>
        ))}
        <button role="tab" aria-selected={display === 'terminal'} onClick={showTerminal}>
          서버 터미널
        </button>
        <span className="kube-status">
          {phase.name === 'open' && (
            <>
              <strong>{phase.settings.context}</strong> · {phase.settings.namespace || '전체'} ·
              조회 모드
              {phase.offline && <em> · 클러스터 연결 불가</em>}
            </>
          )}
          {display === 'terminal' && settingUp && (
            <>
              {note && <span className="kube-status-note">{note}</span>}
              <button disabled={busy} onClick={() => recheck({ mode: 'scan' })}>
                다시 확인
              </button>
            </>
          )}
        </span>
      </div>
      {display === 'workspace' && (
        <div className="kube-body">
          {phase.name === 'detecting' && <p className="kube-detecting">클러스터를 확인하는 중…</p>}
          {detection && (
            <KubeSetup
              detection={detection}
              busy={busy}
              error={error}
              note={note}
              recheck={recheck}
              chooseContext={(context) =>
                run(
                  {
                    mode: 'manual',
                    kubectl: detection.kubectl,
                    kubeconfig: detection.kubeconfig,
                  },
                  context,
                  false,
                )
              }
              start={(context, namespace) => {
                setBusy(true);
                finish(settingsFrom(detection, context, namespace))
                  .catch((e: unknown) => setError(errorText(e)))
                  .finally(() => setBusy(false));
              }}
              copy={copyToTerminal}
            />
          )}
          {phase.name === 'open' && (
            <div className="kube-empty" role="tabpanel">
              <h2>{kubeScreens.find((item) => item.id === screen)?.label}</h2>
              <p>이 화면은 아직 준비 중입니다.</p>
            </div>
          )}
          {phase.name === 'detecting' && error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
