import { useState } from 'react';
import {
  anchorBelow,
  ContextMenu,
  isMenuKey,
  type MenuRequest,
} from '../../components/ContextMenu';
import type { Profile } from '../../lib/ipc';
import './profileList.css';

const protocolLabel = (profile: Profile) => (profile.protocol ?? 'ssh').toUpperCase();

/**
 * Saved connections. A card connects on double-click or Enter; everything else is in its
 * right-click menu, which Shift+F10 and the menu key also open.
 */
export function ProfileList({
  profiles,
  showRecent,
  empty,
  connect,
  edit,
  toggleFavorite,
  duplicate,
  remove,
}: {
  profiles: Profile[];
  /** Shows when each connection was last used, for the "recent" filter. */
  showRecent: boolean;
  empty: string;
  connect: (profile: Profile) => void;
  edit: (profile: Profile) => void;
  toggleFavorite: (profile: Profile) => void;
  duplicate: (profile: Profile) => void;
  remove: (profile: Profile) => void;
}) {
  const [menu, setMenu] = useState<(MenuRequest & { name: string }) | null>(null);
  const open = (profile: Profile, at: MenuRequest['at']) =>
    setMenu({
      at,
      name: profile.name,
      items: [
        { label: '연결', shortcut: 'Enter', run: () => connect(profile) },
        { label: '수정…', run: () => edit(profile) },
        {
          label: profile.favorite ? '즐겨찾기 해제' : '즐겨찾기',
          run: () => toggleFavorite(profile),
        },
        { label: '복제', run: () => duplicate(profile) },
        { label: '삭제…', danger: true, separated: true, run: () => remove(profile) },
      ],
    });
  return (
    <div className="session-list">
      {profiles.length ? (
        profiles.map((p) => (
          <article key={p.id} className="profile-card">
            <button
              className="profile-target"
              onDoubleClick={() => connect(p)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') connect(p);
                else if (isMenuKey(e)) {
                  e.preventDefault();
                  open(p, anchorBelow(e.currentTarget));
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                open(p, { x: e.clientX, y: e.clientY });
              }}
              title="더블클릭 또는 Enter로 연결 · 우클릭으로 수정과 삭제"
            >
              <strong>
                {p.favorite ? '★ ' : ''}
                {p.name}
                <span className={`protocol-badge ${p.protocol ?? 'ssh'}`}>{protocolLabel(p)}</span>
              </strong>
              <span>
                {p.username}@{p.host}:{p.port}
              </span>
              {showRecent && p.lastConnected && (
                <small>{new Date(p.lastConnected * 1000).toLocaleString()}</small>
              )}
            </button>
          </article>
        ))
      ) : (
        <div className="sidebar-empty">
          {empty}
          <p>새 연결에서 서버를 등록하세요.</p>
        </div>
      )}
      {menu && (
        <ContextMenu
          label={`${menu.name} 연결 작업`}
          at={menu.at}
          items={menu.items}
          close={() => setMenu(null)}
        />
      )}
    </div>
  );
}
