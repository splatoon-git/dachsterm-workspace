import { Icon } from '../components/Icon';
import { modKey } from '../lib/platform';
import './sidebarTabs.css';

export type SidebarView = 'connections' | 'files' | 'git';
const views: [SidebarView, string, 'server' | 'folder' | 'branch', string, string?][] = [
  ['connections', '연결', 'server', 'session-sidebar', 'Shift+B'],
  ['files', '파일', 'folder', 'file-sidebar', 'Shift+E'],
  ['git', 'Git', 'branch', 'git-sidebar'],
];

/**
 * The top line of the sidebar: the connections, files and Git views as tabs. Adding is in the
 * connection tree's section menus, and the sidebar folds from the title bar or Ctrl/Cmd+Shift+B.
 */
export function SidebarTabs({
  view,
  choose,
}: {
  view: SidebarView;
  choose: (view: SidebarView) => void;
}) {
  return (
    <div className="sidebar-head">
      <div
        className="sidebar-tabs"
        role="tablist"
        aria-label="사이드바 보기"
        onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const at = views.findIndex(([id]) => id === view);
          const step = e.key === 'ArrowRight' ? 1 : -1;
          const index =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? views.length - 1
                : (at + step + views.length) % views.length;
          const next = views[index][0];
          choose(next);
          document.getElementById(`sidebar-tab-${next}`)?.focus();
        }}
      >
        {views.map(([id, label, icon, panel, keys]) => (
          <button
            key={id}
            id={`sidebar-tab-${id}`}
            role="tab"
            title={keys ? `${label} · ${modKey(keys)}` : label}
            aria-selected={view === id}
            aria-controls={panel}
            tabIndex={view === id ? 0 : -1}
            onClick={() => choose(id)}
          >
            <Icon name={icon} size={14} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
