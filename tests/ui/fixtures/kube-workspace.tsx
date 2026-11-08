// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { KubeCopyResult } from '../../../src/features/kube/KubeWorkspace';
import type { Detection, KubeDisplay } from '../../../src/features/kube/kubeModel';
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
      calls: { command: string; args: Record<string, unknown> }[];
      copied: string[];
    };
  }
}

const state = window.__kube;
state.calls = [];
state.copied = [];
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      state.calls.push({ command, args });
      if (command === 'kube_detect') {
        const detections = state.detections;
        return structuredClone(detections.length > 1 ? detections.shift() : detections[0]);
      }
      return null;
    },
  },
});

// `lib/ipc` reads `isTauri` once when it loads, so the app code comes after the stub above.
const { KubeWorkspace } = await import('../../../src/features/kube/KubeWorkspace');

function Harness() {
  const [display, setDisplay] = useState<Exclude<KubeDisplay, 'off'>>('workspace');
  return (
    <KubeWorkspace
      connectionId="connection"
      persist={state.persist}
      display={display}
      showTerminal={() => setDisplay('terminal')}
      showWorkspace={() => setDisplay('workspace')}
      copy={(command) => {
        state.copied.push(command);
        if ('typed' in state.copyResult) setDisplay('terminal');
        return state.copyResult;
      }}
    />
  );
}

applyTheme(getCurrentTheme());
createRoot(document.getElementById('root')!).render(<Harness />);
