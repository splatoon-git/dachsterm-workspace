import { useLayoutEffect, useMemo, useRef, type ComponentProps } from 'react';
import { FileDecorationsContext, type FileDecorations } from '../components/fileDecorations';
import { useGitFileMarks } from '../features/git/useGitStatus';
import { SidebarFiles as FileSidebar } from '../features/sftp/SidebarFiles';

/**
 * The sidebar's file view with Git marks on its rows and "start an agent here" on its folders.
 * The file panels never see Git or agents themselves.
 */
export function SidebarFiles({
  startAgent,
  ...props
}: ComponentProps<typeof FileSidebar> & { startAgent: (folder: string) => void }) {
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
  return (
    <FileDecorationsContext.Provider value={decorations}>
      <FileSidebar {...props} />
    </FileDecorationsContext.Provider>
  );
}
