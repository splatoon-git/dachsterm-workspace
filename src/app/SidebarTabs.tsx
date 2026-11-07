import { Icon } from '../components/Icon';
import { modKey } from '../lib/platform';
import './sidebarTabs.css';

export type SidebarView = 'connections' | 'files';
const views: [SidebarView, string, 'server' | 'folder', string, string][] = [
  ['connections', '연결', 'server', 'session-sidebar', 'Shift+B'],
  ['files', '파일', 'folder', 'file-sidebar', 'Shift+E'],
];

/**
 * The top line of the sidebar: the connections and files views as two tabs. Adding is in the
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
          const next =
            e.key === 'Home'
              ? 'connections'
              : e.key === 'End'
                ? 'files'
                : view === 'files'
                  ? 'connections'
                  : 'files';
          choose(next);
          document.getElementById(`sidebar-tab-${next}`)?.focus();
        }}
      >
        {views.map(([id, label, icon, panel, keys]) => (
          <button
            key={id}
            id={`sidebar-tab-${id}`}
            role="tab"
            title={`${label} · ${modKey(keys)}`}
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
