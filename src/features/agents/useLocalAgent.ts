import { useEffect, useRef, useState } from 'react';
import { call, errorText, type ForwardKey } from '../../lib/ipc';

/**
 * `local_agent_settings`: app-wide, since local tabs have no session (DX.13). `wslGitCredentials`
 * lets WSL tabs ask this PC for HTTPS Git credentials (DX.14).
 */
export type LocalAgent = { enabled: boolean; keys: ForwardKey[]; wslGitCredentials: boolean };

/**
 * The saved value, for the two settings screens that show parts of it. It saves as it changes,
 * one save at a time in order; only the latest answer replaces what is shown.
 */
export function useLocalAgent() {
  const [value, setValue] = useState<LocalAgent | null>(null);
  const [status, setStatus] = useState('');
  const queue = useRef(Promise.resolve());
  const latest = useRef(0);
  useEffect(() => {
    call<LocalAgent>('local_agent_settings').then(setValue, (e: unknown) =>
      setStatus(errorText(e)),
    );
  }, []);
  function save(next: LocalAgent, tabs: '로컬' | 'WSL') {
    setValue(next);
    const turn = ++latest.current;
    queue.current = queue.current.then(() =>
      call<LocalAgent>('local_agent_save', {
        enabled: next.enabled,
        keys: next.keys.map((key) => key.path),
        wslGitCredentials: next.wslGitCredentials,
      }).then(
        (saved) => {
          if (turn !== latest.current) return;
          setValue(saved);
          setStatus(`저장했습니다. 새로 여는 ${tabs} 탭부터 적용됩니다.`);
        },
        (e: unknown) => setStatus(errorText(e)),
      ),
    );
  }
  return { value, status, save };
}
