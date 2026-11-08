import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { GitCredentialSettings } from '../features/agents/GitCredentialSettings';
import { WslGitCredentialSetting } from '../features/agents/WslGitCredentialSetting';
import { GitSettings } from '../features/settings/GitSettings';
import type { TerminalSession } from '../features/terminal/session';
import { sessionSource } from '../features/terminal/sessionKind';
import type { LocalCatalog } from '../features/terminal/sessionTypes';
import { call, desktop, errorText } from '../lib/ipc';
import type { SettingsRepo } from '../lib/settingsRequest';
import { GitDisplaySettings } from './GitDisplaySettings';
import { gitConfigTargets, repoTargetId, type GitConfigServer } from './gitConfigTargets';

const noSession = { subscribe: () => () => {}, snapshot: () => undefined };

/** The category's parts from each feature, and what it can edit from the app's own state. */
export function GitSettingsSection({
  session,
  repo,
}: {
  session: TerminalSession | undefined;
  repo?: SettingsRepo;
}) {
  const [catalog, setCatalog] = useState<LocalCatalog | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!desktop) return;
    call<LocalCatalog>('local_targets').then(setCatalog, (e: unknown) => setProblem(errorText(e)));
  }, []);
  const status = useSyncExternalStore(
    session?.subscribe ?? noSession.subscribe,
    () => session?.snapshot().status,
  );
  const source = status === 'connected' && session ? sessionSource(session) : null;
  const connection = source?.kind === 'ssh' ? source.connectionId : null;
  const name = session?.profile.name ?? '';
  const server = useMemo<GitConfigServer | null>(
    () => (connection ? { source: { kind: 'ssh', connectionId: connection }, name } : null),
    [connection, name],
  );
  const targets = useMemo(() => gitConfigTargets(catalog, server, repo), [catalog, server, repo]);
  return (
    <>
      <GitSettings
        targets={targets}
        initialTarget={repo ? repoTargetId : undefined}
        display={<GitDisplaySettings />}
        credentials={
          <>
            <WslGitCredentialSetting />
            <GitCredentialSettings />
          </>
        }
      />
      {problem && <p role="alert">{problem}</p>}
    </>
  );
}
