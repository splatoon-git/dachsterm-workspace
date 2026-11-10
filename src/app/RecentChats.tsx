import { useState } from 'react';
import {
  anchorBelow,
  ContextMenu,
  isMenuKey,
  type MenuItem,
  type MenuPoint,
} from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import type { Profile } from '../lib/ipc';

/** A workspace a chat was opened in, as the connection tree lists it. */
export type RecentChat = {
  key: string;
  title: string;
  detail: string;
  /** Whether a chat is open there now: going to it then shows that chat. */
  open: boolean;
  /** Shows the open chat there, or opens one. */
  go(): void;
  /** Opens another chat there even when one is open. */
  again(): void;
  forget(): void;
};

/** What the connection tree needs from the chat tabs. */
export type ChatShortcuts = {
  /** Asks for a server folder, then opens the session as a chat with its agent (AC.1). */
  ask(profile: Profile): void;
  recent: RecentChat[];
};

/**
 * The connection tree's recent chat workspaces: one click goes back to where a chat was, without
 * finding the folder again. The ✕ only takes the row off the list.
 */
export function RecentChats({ rows }: { rows: RecentChat[] }) {
  const [menu, setMenu] = useState<{ at: MenuPoint; row: RecentChat } | null>(null);
  const items = (row: RecentChat): MenuItem[] => [
    { label: row.open ? '열린 채팅으로 이동' : '채팅 열기', shortcut: 'Enter', run: row.go },
    ...(row.open ? [{ label: '새 채팅 열기', run: row.again }] : []),
    { label: '목록에서 제거', separated: true, run: row.forget },
  ];
  return (
    <>
      <ul className="recent-chats" aria-label="최근 채팅">
        {rows.map((row) => (
          <li key={row.key} className="recent-chat">
            <button
              className="recent-chat-target"
              onClick={row.go}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ at: { x: e.clientX, y: e.clientY }, row });
              }}
              onKeyDown={(e) => {
                if (!isMenuKey(e)) return;
                e.preventDefault();
                setMenu({ at: anchorBelow(e.currentTarget), row });
              }}
              title={`${row.title} · ${row.detail}\n${row.open ? '클릭하면 열린 채팅으로 이동' : '클릭하면 이 폴더에서 채팅 열기'} · 우클릭으로 더 보기`}
            >
              <Icon name="chat" size={14} />
              <strong>{row.title}</strong>
              <span className="row-detail">{row.detail}</span>
              {row.open && <small className="recent-chat-open">열림</small>}
            </button>
            <button
              className="recent-chat-forget"
              aria-label={`${row.title} ${row.detail} 최근 채팅에서 제거`}
              title="목록에서 제거"
              onClick={row.forget}
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
      </ul>
      {menu && (
        <ContextMenu
          label={`${menu.row.title} 채팅 작업`}
          at={menu.at}
          items={items(menu.row)}
          close={() => setMenu(null)}
        />
      )}
    </>
  );
}
