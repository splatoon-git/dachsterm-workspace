import { GitView } from '../features/git/GitView';
import type { TerminalSession } from '../features/terminal/session';
import { SidebarFiles } from './SidebarFiles';
import type { SidebarView } from './SidebarTabs';
import type { FileTabOpeners } from './useFileTabs';
import { reviewable } from './useReviewTabs';

/** The sidebar's file and Git views, the two that follow the selected tab. */
export function SidebarViews({
  view,
  session,
  showConnections,
  startAgent,
  openReview,
  files,
}: {
  view: SidebarView;
  session: TerminalSession | undefined;
  showConnections: () => void;
  startAgent: (folder: string) => void;
  openReview: () => void;
  files: FileTabOpeners;
}) {
  return (
    <>
      <div
        id="file-sidebar"
        className="sidebar-file-panel"
        role="tabpanel"
        aria-labelledby="sidebar-tab-files"
        hidden={view !== 'files'}
      >
        <SidebarFiles
          session={session}
          showConnections={showConnections}
          startAgent={startAgent}
          openFile={files.open}
        />
      </div>
      <div
        id="git-sidebar"
        className="sidebar-file-panel"
        role="tabpanel"
        aria-labelledby="sidebar-tab-git"
        hidden={view !== 'git'}
      >
        {/* Mounted only while open: its query lists every untracked file. */}
        {view === 'git' && (
          <GitView
            session={session}
            review={reviewable(session) ? openReview : undefined}
            openFile={(path, pinned) => session && files.open(session, path, pinned)}
            openDiff={(row, root, pinned) => session && files.openDiff(session, row, root, pinned)}
          />
        )}
      </div>
    </>
  );
}
