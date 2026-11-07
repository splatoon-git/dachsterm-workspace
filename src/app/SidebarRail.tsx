import { Icon } from '../components/Icon';
import './sidebarRail.css';

export type SidebarView = 'connections' | 'files';
const views: [SidebarView, string, 'server' | 'folder', string][] = [
  ['connections', '연결', 'server', 'session-sidebar'],
  ['files', '파일', 'folder', 'file-sidebar'],
];

/**
 * The narrow column of icons at the left edge. An icon shows its view; pressing the icon of the
 * view already open folds the sidebar away. Settings sit at the bottom.
 */
export function SidebarRail({
  view,
  open,
  choose,
  settings,
}: {
  view: SidebarView;
  open: boolean;
  /** Shows a view, or folds the sidebar when that view is already open. */
  choose: (view: SidebarView) => void;
  settings: () => void;
}) {
  return (
    <nav className="sidebar-rail" aria-label="사이드바 보기">
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="사이드바"
        onKeyDown={(e) => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
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
        {views.map(([id, label, icon, panel]) => (
          <button
            key={id}
            id={`sidebar-tab-${id}`}
            role="tab"
            aria-label={label}
            title={`${label} · ${id === 'connections' ? 'Ctrl/Cmd+Shift+B' : 'Ctrl/Cmd+Shift+E'}`}
            aria-selected={open && view === id}
            aria-expanded={open && view === id}
            aria-controls={panel}
            tabIndex={view === id ? 0 : -1}
            onClick={() => choose(id)}
          >
            <Icon name={icon} size={18} />
          </button>
        ))}
      </div>
      <button className="rail-settings" aria-label="설정" title="설정" onClick={settings}>
        <Icon name="settings" size={18} />
      </button>
    </nav>
  );
}
