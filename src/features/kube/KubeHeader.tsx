import type { ReactNode } from 'react';
import type { KubeSettings } from '../../lib/ipc';
import { kubeScreens, type KubeDisplay, type KubeScreen } from './kubeModel';

/** The workspace's screen tabs and the status at their end. */
export function KubeHeader({
  screen,
  display,
  openScreen,
  showTerminal,
  settings,
  mode,
  age,
  warning,
  liveLogs,
  problems,
  aiAvailable,
  setup,
}: {
  screen: KubeScreen;
  display: Exclude<KubeDisplay, 'off'>;
  openScreen: (id: KubeScreen) => void;
  showTerminal: () => void;
  /** `null` until the workspace is open. */
  settings: KubeSettings | null;
  /** The operate-mode control, which belongs next to what it applies to. */
  mode: ReactNode;
  age: string | null;
  warning: string | null;
  liveLogs: boolean;
  /** Shown on the problem tab only when there are any. */
  problems: number;
  /** The vLLM·GPU tab exists only where detection found something to show. */
  aiAvailable: boolean;
  /** The way back from the terminal while setup is unfinished; `null` otherwise. */
  setup: { note: string; busy: boolean; recheck: () => void } | null;
}) {
  return (
    <div className="kube-header" role="tablist" aria-label="쿠버네티스 화면">
      {kubeScreens
        .filter(({ id }) => id !== 'ai' || aiAvailable)
        .map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={display === 'workspace' && screen === id}
            onClick={() => openScreen(id)}
          >
            {label}
            {id === 'board' && liveLogs && (
              <i className="kube-header-live" title="로그를 받는 중" aria-hidden="true" />
            )}
            {id === 'problems' && problems > 0 && (
              <span className="kube-header-count">{problems}</span>
            )}
          </button>
        ))}
      <span className="kube-header-divider" aria-hidden="true" />
      <button role="tab" aria-selected={display === 'terminal'} onClick={showTerminal}>
        서버 터미널
      </button>
      <span className="kube-status">
        {settings && (
          <>
            <strong>{settings.context}</strong> · {settings.namespace || '전체'} ·{mode}
            {age && ` · ${age}`}
            {warning && <em> · {warning}</em>}
          </>
        )}
        {display === 'terminal' && setup && (
          <>
            {setup.note && <span className="kube-status-note">{setup.note}</span>}
            <button disabled={setup.busy} onClick={setup.recheck}>
              다시 확인
            </button>
          </>
        )}
      </span>
    </div>
  );
}
