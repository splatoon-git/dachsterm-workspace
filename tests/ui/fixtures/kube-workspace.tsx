// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { KubeCopyResult } from '../../../src/features/kube/KubeWorkspace';
import type {
  Detail,
  DetailKind,
  PodLogs,
  ShellCheck,
} from '../../../src/features/kube/detailTypes';
import type { Detection, KubeDisplay } from '../../../src/features/kube/kubeModel';
import type { SearchEvent } from '../../../src/features/kube/logSearchModel';
import type { PodTerminalRequest } from '../../../src/features/kube/podShell';
import type { MetricsRead, ProbeRead } from '../../../src/features/kube/runtimeTypes';
import type { Snapshot, SnapshotKind } from '../../../src/features/kube/snapshotTypes';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';

declare global {
  interface Window {
    __kube: {
      /** Answers to `kube_detect`, in order; the last one repeats. */
      detections: Detection[];
      /** What the terminal says when a command is typed. */
      copyResult: KubeCopyResult;
      persist: boolean;
      /** Answers to `kube_snapshot` by kind. A kind that is absent has an unreachable cluster. */
      snapshots?: Partial<Record<SnapshotKind, Snapshot>>;
      /** `visible` starts true; the spec turns it off through `setVisible`. */
      setVisible?: (visible: boolean) => void;
      /** Answers to `kube_detail` by `kind`, `kube_logs` and `kube_terminal_probe`. */
      podAnswers?: {
        detail?: Partial<Record<DetailKind, Detail>>;
        logs?: PodLogs;
        probe?: ShellCheck;
      };
      /** Answers to `kube_metrics` by target kind (by port for `pod`) and to `kube_probe`. */
      runtime?: {
        candidates?: MetricsRead;
        threads?: MetricsRead;
        ports?: Record<number, MetricsRead>;
        probe?: ProbeRead;
      };
      /** Sent to the running search's channel, with Tauri's message numbering. */
      emitSearch?: (event: SearchEvent) => void;
      /** Ends the fake `kube_log_search` call, as the backend does when a search is over. */
      endSearch?: () => void;
      calls: { command: string; args: Record<string, unknown> }[];
      copied: string[];
      terminals: PodTerminalRequest[];
    };
  }
}

const state = window.__kube;
const callbacks = new Map<number, (message: unknown) => void>();
let nextCallback = 1;
let searchChannel = 0;
let searchSent = 0;
state.calls = [];
state.copied = [];
state.terminals = [];
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    transformCallback: (callback: (message: unknown) => void) => {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    invoke: async (command: string, allArgs: Record<string, unknown>) => {
      // A channel object cannot cross into the test, and only its ID matters here.
      const { onEvent, ...args } = allArgs;
      state.calls.push({ command, args });
      if (command === 'kube_log_search') {
        searchChannel = (onEvent as { id: number }).id;
        searchSent = 0;
        return new Promise<void>((resolve) => {
          state.endSearch = resolve;
        });
      }
      if (command === 'kube_log_cancel') return null;
      if (command === 'kube_detect') {
        const detections = state.detections;
        return structuredClone(detections.length > 1 ? detections.shift() : detections[0]);
      }
      if (command === 'kube_snapshot') {
        const answer = state.snapshots?.[args.kind as SnapshotKind];
        if (answer) return structuredClone(answer);
        return {
          state: { kind: 'unreachable' },
          data: null,
          collectedAt: Date.now(),
          elapsedMs: 1,
        };
      }
      if (command === 'kube_metrics') {
        const target = args.target as { kind: string; port?: number };
        const runtime = state.runtime;
        const answer =
          target.kind === 'candidates'
            ? runtime?.candidates
            : target.kind === 'threads'
              ? runtime?.threads
              : runtime?.ports?.[target.port ?? 0];
        return structuredClone(
          answer ?? { state: { kind: 'unreachable' }, data: null, elapsedMs: 1 },
        );
      }
      if (command === 'kube_probe')
        return structuredClone(state.runtime?.probe ?? { kind: 'noShell' });
      if (command === 'kube_detail')
        return structuredClone(state.podAnswers?.detail?.[args.kind as DetailKind] ?? null);
      if (command === 'kube_logs') return structuredClone(state.podAnswers?.logs ?? null);
      if (command === 'kube_terminal_probe')
        return structuredClone(state.podAnswers?.probe ?? { kind: 'ready' });
      return null;
    },
  },
});

state.emitSearch = (event) => {
  callbacks.get(searchChannel)?.({ message: event, index: searchSent++ });
};

// `lib/ipc` reads `isTauri` once when it loads, so the app code comes after the stub above.
const { KubeWorkspace } = await import('../../../src/features/kube/KubeWorkspace');

function Harness() {
  const [display, setDisplay] = useState<Exclude<KubeDisplay, 'off'>>('workspace');
  const [visible, setVisible] = useState(true);
  state.setVisible = setVisible;
  return (
    <KubeWorkspace
      connectionId="connection"
      persist={state.persist}
      session="profile"
      visible={visible}
      focused
      display={display}
      showTerminal={() => setDisplay('terminal')}
      showWorkspace={() => setDisplay('workspace')}
      copy={(command) => {
        state.copied.push(command);
        if ('typed' in state.copyResult) setDisplay('terminal');
        return state.copyResult;
      }}
      focusPod={null}
      openTerminal={(request) => state.terminals.push(request)}
    />
  );
}

applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(<Harness />);
