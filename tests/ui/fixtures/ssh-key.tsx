// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { GeneratedKey } from '../../../src/components/SshKeyDialog';
import type { ForwardKey } from '../../../src/lib/ipc';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';
import '../../../src/features/sessions/sessionForm.css';

interface SshKeyFixture {
  calls: { command: string; args: Record<string, unknown> }[];
  /** A message `ssh_key_generate` fails with, instead of succeeding. */
  failure?: string;
  submits: number;
  keyPath: string;
  keys: ForwardKey[];
}
declare global {
  interface Window {
    __sshKey: SshKeyFixture;
  }
}

const made: GeneratedKey = {
  path: 'C:\\Users\\me\\.ssh\\id_new',
  publicKey: 'ssh-ed25519 AAAAC3Nza me@pc',
  fingerprint: 'SHA256:abcdef',
};
const state: SshKeyFixture = { calls: [], submits: 0, keyPath: '', keys: [] };
window.__sshKey = state;
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      state.calls.push({ command, args });
      if (command === 'ssh_key_defaults')
        return { folder: 'C:\\Users\\me\\.ssh', comment: 'me@pc' };
      if (command === 'ssh_key_pick_folder') return 'D:\\keys';
      if (command === 'ssh_key_generate') {
        if (state.failure) throw state.failure;
        return made;
      }
      if (command === 'ssh_key_info')
        return {
          path: made.path,
          name: 'id_new',
          algorithm: 'ssh-ed25519',
          fingerprint: made.fingerprint,
          comment: 'me@pc',
          encrypted: false,
        };
      if (command === 'clipboard_write_text') return null;
      throw `unexpected ${command}`;
    },
  },
});
applyTheme(getCurrentTheme());

// Loaded after the bridge above: `lib/ipc` decides whether it is on the desktop at import time.
const { KeyFileList } = await import('../../../src/components/KeyFileList');
const { LoginKeyField } = await import('../../../src/features/sessions/LoginKeyField');

function Harness() {
  const [keyPath, setKeyPath] = useState('');
  const [keys, setKeys] = useState<ForwardKey[]>([]);
  state.keyPath = keyPath;
  state.keys = keys;
  return (
    // The session form holds these fields, so a key made there must not submit it.
    <form
      onSubmit={(event) => {
        event.preventDefault();
        state.submits += 1;
      }}
    >
      <div className="form-grid">
        <LoginKeyField value={keyPath} change={setKeyPath} />
        <div className="wide">
          <KeyFileList keys={keys} change={setKeys} placeholder="키 경로" />
        </div>
      </div>
    </form>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
