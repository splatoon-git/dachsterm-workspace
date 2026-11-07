import type { ComponentProps } from 'react';
import { FileDecorationsContext } from '../components/fileDecorations';
import { useGitFileMarks } from '../features/git/useGitStatus';
import { SidebarFiles as FileSidebar } from '../features/sftp/SidebarFiles';

/** The sidebar's file view with Git marks on its rows. The file panels never see Git itself. */
export function SidebarFiles(props: ComponentProps<typeof FileSidebar>) {
  const decorations = useGitFileMarks(props.session);
  return (
    <FileDecorationsContext.Provider value={decorations}>
      <FileSidebar {...props} />
    </FileDecorationsContext.Provider>
  );
}
