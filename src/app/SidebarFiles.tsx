import { useLayoutEffect, useMemo, useRef, type ComponentProps } from 'react';
import { FileDecorationsContext, type FileDecorations } from '../components/fileDecorations';
import { FileOpenContext } from '../components/fileOpen';
import { useGitFileMarks } from '../features/git/useGitStatus';
import { SidebarFiles as FileSidebar } from '../features/sftp/SidebarFiles';
import type { TerminalSession } from '../features/terminal/session';

/**
 * The sidebar's file view with Git marks on its rows and "start an agent here" on its folders.
 * The file panels never see Git or agents themselves.
 */
export function SidebarFiles({
  startAgent,
  openFile,
  ...props
}: ComponentProps<typeof FileSidebar> & {
  startAgent: (folder: string) => void;
  openFile: (session: TerminalSession, path: string, pinned: boolean) => void;
}) {
  const marks = useGitFileMarks(props.session);
  // The tree reports a listing whenever this value changes, so it must not change every render.
  const start = useRef(startAgent);
  useLayoutEffect(() => {
    start.current = startAgent;
  });
  const session = props.session;
  const remote =
    !!session && !session.localTarget && !session.podtree && session.profile.protocol === 'ssh';
  const decorations = useMemo<FileDecorations | null>(
    () =>
      remote
        ? {
            mark: (path) => marks?.mark(path),
            listed: (folder) => marks?.listed(folder),
            folderActions: (path) => [
              { label: '에이전트 시작…', separated: true, run: () => start.current(path) },
            ],
          }
        : marks,
    [marks, remote],
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
