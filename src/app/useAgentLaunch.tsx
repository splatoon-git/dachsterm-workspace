import { useState } from 'react';
import { AgentLaunchDialog, AgentNotTypedDialog } from '../features/agents/AgentLaunchDialog';
import { connectWithLaunch } from '../features/terminal/launch';
import type { TerminalSession } from '../features/terminal/session';
import type { Profile, TerminalLaunch } from '../lib/ipc';
import { startLine } from '../lib/shell';
import type { Beside } from './useWorkspaceLayout';

/** How a new tab opens: beside a group, and with a start command that runs once. */
export type Opening = { beside?: Beside; launch?: TerminalLaunch };

/**
 * Starting an agent: the confirmation from the agent presets, then a new terminal tab that runs
 * the command once. The two features meet only here.
 */
export function useAgentLaunch(open: (profile: Profile, launch: TerminalLaunch) => void) {
  const [asking, setAsking] = useState<{ profile: Profile; folder?: string } | null>(null);
  const [missed, setMissed] = useState<{ session: TerminalSession; line: string } | null>(null);
  return {
    /** Asks first; `folder` comes from the file tree, otherwise the user may type one. */
    ask: (profile: Profile, folder?: string) => setAsking({ profile, folder }),
    connect(
      session: TerminalSession,
      secret: string | null,
      remember: boolean,
      launch?: TerminalLaunch,
    ) {
      void connectWithLaunch(session, secret, remember, launch).then((result) => {
        if (result === 'noPrompt' && launch) setMissed({ session, line: startLine(launch) });
      });
    },
    dialogs: (
      <>
        {asking && (
          <AgentLaunchDialog
            profile={asking.profile}
            folder={asking.folder}
            start={(launch) => {
              setAsking(null);
              open(asking.profile, launch);
            }}
            close={() => setAsking(null)}
          />
        )}
        {missed && (
          <AgentNotTypedDialog
            sessionName={missed.session.profile.name}
            line={missed.line}
            copy={() => missed.session.copyText(missed.line)}
            close={() => setMissed(null)}
          />
        )}
      </>
    ),
  };
}
