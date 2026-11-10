import { useState } from 'react';
import { rememberFolder } from '../features/chat/chatFolders';
import { ChatOpenDialog } from '../features/chat/ChatOpenDialog';
import { ChatPane } from '../features/chat/ChatPane';
import { ChatSession } from '../features/chat/chatSession';
import type { Profile } from '../lib/ipc';
import { PlainTab } from './GroupTabBar';
import type { Workspace } from './useWorkspaceLayout';
import { tabKey, type TabRef } from './workspaceLayout';

type ChatRef = Extract<TabRef, { kind: 'chat' }>;
type Chat = { id: string; session: ChatSession };

const refOf = (chat: Chat): ChatRef => ({ kind: 'chat', id: chat.id });

/**
 * Agent chat tabs (AC.1). The tab, not its pane, owns the connection: moving a tab between cells
 * never reconnects, and closing it ends the agent on the server.
 */
export function useChatTabs({ workspace }: { workspace: Workspace }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [asking, setAsking] = useState<Profile | null>(null);
  /** Opens a chat whose agent works in `folder` on the server; empty means the login folder. */
  const open = (profile: Profile, folder: string) => {
    const chat: Chat = { id: crypto.randomUUID(), session: new ChatSession(profile, folder) };
    rememberFolder(profile.id, folder);
    chat.session.open();
    setChats((old) => [...old, chat]);
    workspace.open(refOf(chat));
  };
  const find = (tab: ChatRef) => chats.find((c) => c.id === tab.id);
  /** Closes a chat tab and its agent. False for a key that is not a chat. */
  const close = (key: string) => {
    const chat = chats.find((c) => tabKey(refOf(c)) === key);
    if (!chat) return false;
    chat.session.close();
    setChats((old) => old.filter((c) => c !== chat));
    workspace.close(key);
    return true;
  };
  return {
    order: chats.map(refOf),
    open,
    /** Asks for the folder first, for a chat opened from the session list. */
    ask: setAsking,
    dialog: asking && (
      <ChatOpenDialog
        profile={asking}
        open={(folder) => {
          setAsking(null);
          open(asking, folder);
        }}
        close={() => setAsking(null)}
      />
    ),
    close,
    renderTab: (tab: ChatRef, active: boolean, select: () => void) => {
      const chat = find(tab);
      return (
        chat && (
          <PlainTab
            tabKey={tabKey(tab)}
            title={`채팅 · ${chat.session.profile.name}`}
            active={active}
            select={select}
            close={() => close(tabKey(tab))}
          />
        )
      );
    },
    renderCell: (tab: ChatRef) => {
      const chat = find(tab);
      return chat && <ChatPane session={chat.session} />;
    },
  };
}
