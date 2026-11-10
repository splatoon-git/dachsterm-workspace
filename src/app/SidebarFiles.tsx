import { useLayoutEffect, useMemo, useRef, type ComponentProps } from 'react';
import { FileDecorationsContext, type FileDecorations } from '../components/fileDecorations';
import { FileOpenContext } from '../components/fileOpen';
import { useGitFileMarks } from '../features/git/useGitStatus';
import { SidebarFiles as FileSidebar } from '../features/sftp/SidebarFiles';
import type { TerminalSession } from '../features/terminal/session';

/**
 * The sidebar's file view with Git marks on its rows, and "chat here" and "start an agent here"
 * on its folders.
 * The file panels never see Git or agents themselves.
 */
export function SidebarFiles({
  startAgent,
  openChat,
  openFile,
  ...props
}: ComponentProps<typeof FileSidebar> & {
  startAgent: (folder: string) => void;
  /** Opens a chat whose agent works in this folder (AC.1). */
  openChat: (folder: string) => void;
  openFile: (session: TerminalSession, path: string, pinned: boolean) => void;
}) {
  const marks = useGitFileMarks(props.session);
  // The tree reports a listing whenever this value changes, so it must not change every render.
  const start = useRef({ startAgent, openChat });
  useLayoutEffect(() => {
    start.current = { startAgent, openChat };
  });
  const session = props.session;
  const remote =
    !!session && !session.localTarget && !session.podTerminal && session.profile.protocol === 'ssh';
  // A chat runs on this PC for a local shell. Inside WSL it would need the agent installed there.
  const local = session?.localTarget?.kind === 'shell';
  const decorations = useMemo<FileDecorations | null>(
    () =>
      remote || local
        ? {
            mark: (path) => marks?.mark(path),
            listed: (folder) => marks?.listed(folder),
            folderActions: (path) => [
              {
                label: '여기서 채팅 열기',
                separated: true,
                run: () => start.current.openChat(path),
              },
              ...(remote
                ? [{ label: '에이전트 시작…', run: () => start.current.startAgent(path) }]
                : []),
            ],
          }
        : marks,
    [marks, remote, local],
  );
  const opener = session && ((path: string, pinned: boolean) => openFile(session, path, pinned));
  return (
    <FileDecorationsContext.Provider value={decorations}>
      <FileOpenContext.Provider value={opener ?? null}>
        <FileSidebar {...props} />
      </FileOpenContext.Provider>
    </FileDecorationsContext.Provider>
  );
}
