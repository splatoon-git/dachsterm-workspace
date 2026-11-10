import { useMemo, useState, useSyncExternalStore } from 'react';
import { rememberFolder } from '../features/chat/chatFolders';
import { ChatOpenDialog } from '../features/chat/ChatOpenDialog';
import { ChatPane } from '../features/chat/ChatPane';
import {
  readLaunch,
  sameWorkspace,
  saveLaunch,
  withoutMissing,
  withRecent,
  type ChatLaunch,
  type ChatWorkspace,
} from '../features/chat/chatPlaces';
import { ChatSession, placeTitle, type ChatPlace } from '../features/chat/chatSession';
import { chatSummary } from '../features/chat/chatStatus';
import { chatTranscript } from '../features/chat/chatText';
import type { TerminalSession } from '../features/terminal/session';
import { sessionKind } from '../features/terminal/sessionKind';
import { StatusBadge } from '../features/terminal/StatusBadge';
import { call, type Profile } from '../lib/ipc';
import { folderProblem } from '../lib/shell';
import { chatReportOf, type AgentSource } from './agentStatus';
import { ChatLauncher, type Described, type LaunchTarget } from './ChatLauncher';
import { PlainTab } from './GroupTabBar';
import type { BoardTabs } from './useAgentBoard';
import type { Workspace } from './useWorkspaceLayout';
import { tabKey, type TabRef } from './workspaceLayout';

type ChatRef = Extract<TabRef, { kind: 'chat' }>;
type Chat = { id: string; session: ChatSession };
type Target = { place: ChatPlace; folder: string };

const refOf = (chat: Chat): ChatRef => ({ kind: 'chat', id: chat.id });
const rowKey = (id: string) => `chat:${id}`;

/** The terminal's connection while it is up, for a chat to share instead of logging in again. */
const viaOf = (terminal: TerminalSession) => () =>
  !terminal.disposed && terminal.snapshot().status === 'connected' ? terminal.connectionId : null;

/** A chat where a terminal tab is: its server and shell folder, or this PC for a local shell. */
function targetOf(terminal: TerminalSession | undefined, folder?: string): Target | string {
  if (!terminal) return '따라갈 터미널 탭이 없습니다. 터미널 탭을 고르거나 위치를 고정하세요.';
  const at = folder ?? terminal.snapshot().directory ?? '';
  const kind = sessionKind(terminal);
  if (kind === 'local' && terminal.localTarget?.kind === 'shell')
    return { place: { kind: 'local', name: terminal.localTarget.name }, folder: at };
  if (kind !== 'ssh') return '이 탭에서는 채팅을 열 수 없습니다. SSH나 로컬 셸 탭을 고르세요.';
  return {
    place: { kind: 'ssh', profile: terminal.profile, via: viaOf(terminal) },
    folder: folderProblem(at) ? '' : at,
  };
}

const workspaceOf = ({ place, folder }: Target): ChatWorkspace =>
  place.kind === 'ssh'
    ? { kind: 'ssh', profileId: place.profile.id, folder }
    : { kind: 'local', folder };

function ChatTab({
  chat,
  active,
  select,
  close,
}: {
  chat: Chat;
  active: boolean;
  select: () => void;
  close: () => void;
}) {
  const state = useSyncExternalStore(chat.session.subscribe, chat.session.snapshot);
  const summary = chatSummary(state);
  return (
    <PlainTab
      tabKey={tabKey(refOf(chat))}
      title={`채팅 · ${placeTitle(chat.session.place)}`}
      hint={summary?.detail || undefined}
      badge={summary && <StatusBadge summary={summary} />}
      active={active}
      select={select}
      close={close}
    />
  );
}

/**
 * Agent chat tabs (AC.1), their reports to the agent list (AC.4) and the title bar entry (§9.7).
 * The tab, not its pane, owns the agent: moving a tab between cells never reconnects, and closing
 * it ends the agent on the server.
 */
export function useChatTabs({
  workspace,
  sessions,
  profiles,
}: {
  workspace: Workspace;
  sessions: readonly TerminalSession[];
  profiles: readonly Profile[];
}) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [asking, setAsking] = useState<Profile | null>(null);
  const [launching, setLaunching] = useState(false);
  const [saved, setSaved] = useState<ChatLaunch>(readLaunch);
  const ids = useMemo(() => new Set(profiles.map((p) => p.id)), [profiles]);
  const launch = useMemo(() => withoutMissing(saved, ids), [saved, ids]);
  const setLaunch = (next: ChatLaunch) => {
    setSaved(next);
    saveLaunch(next);
  };
  /** Opens a chat whose agent works in `folder`; empty means the login or home folder. */
  const open = ({ place, folder }: Target) => {
    const chat: Chat = { id: crypto.randomUUID(), session: new ChatSession(place, folder) };
    if (place.kind === 'ssh') rememberFolder(place.profile.id, folder);
    setLaunch(withRecent(launch, workspaceOf({ place, folder })));
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
  const focusedKey = workspace.focusedGroup.active;
  const focusedChat = chats.find((c) => tabKey(refOf(c)) === focusedKey);
  const focusedTerminal = sessions.find(
    (t) => tabKey({ kind: 'session', tabId: t.tabId }) === focusedKey,
  );
  /** A saved workspace as a place to open in. Null when its session was deleted. */
  const resolve = (w: ChatWorkspace): Target | null => {
    if (w.kind === 'local') return { place: { kind: 'local', name: '' }, folder: w.folder };
    const profile = profiles.find((p) => p.id === w.profileId);
    return profile ? { place: { kind: 'ssh', profile }, folder: w.folder } : null;
  };
  const describe = (w: ChatWorkspace): Described | null => {
    const target = resolve(w);
    if (!target) return null;
    const { place } = target;
    const home = place.kind === 'ssh' ? '로그인 폴더' : '홈 폴더';
    return { title: placeTitle(place), detail: w.folder || home };
  };
  // With a chat in focus, following means beside it: the same place and folder.
  const followed = focusedChat?.session ?? targetOf(focusedTerminal);
  const fixed = launch.mode === 'fixed' && launch.fixed ? resolve(launch.fixed) : null;
  const target: Target | string = fixed ?? followed;
  const shown: LaunchTarget =
    typeof target === 'string'
      ? { reason: target }
      : (describe(workspaceOf(target)) ?? { reason: '세션을 찾을 수 없습니다.' });
  const choices = [
    ...(typeof followed === 'string' ? [] : [workspaceOf(followed)]),
    ...(launch.fixed ? [launch.fixed] : []),
    ...launch.recent,
  ].filter((w, i, all) => all.findIndex((o) => sameWorkspace(o, w)) === i);
  const board = useMemo<BoardTabs>(
    () => ({
      sources: chats.map((chat): AgentSource => ({
        key: rowKey(chat.id),
        read: () => chatReportOf(chat.session),
        watch: (changed) => chat.session.subscribe(changed),
      })),
      focused: focusedChat && rowKey(focusedChat.id),
      activate: (key) => {
        const chat = chats.find((c) => rowKey(c.id) === key);
        if (chat) workspace.open(refOf(chat));
        return !!chat;
      },
    }),
    [chats, focusedChat, workspace],
  );
  return {
    order: chats.map(refOf),
    board,
    /** Opens or closes the title bar's chat popover. */
    toggleLauncher: () => setLaunching((v) => !v),
    launcher: (
      <ChatLauncher
        open={launching}
        setOpen={setLaunching}
        target={shown}
        launch={launch}
        setLaunch={setLaunch}
        choices={choices}
        describe={describe}
        openNew={() => typeof target !== 'string' && open(target)}
        openAt={(w) => {
          const at = resolve(w);
          if (at) open(at);
        }}
        chats={chats}
        focused={focusedChat?.id}
        select={(id) => {
          const chat = chats.find((c) => c.id === id);
          if (chat) workspace.open(refOf(chat));
        }}
      />
    ),
    /** A chat in a folder of the tab's own place, sharing its connection (§9.7). */
    openFrom: (session: TerminalSession, folder: string) => {
      const at = targetOf(session, folder);
      if (typeof at !== 'string') open(at);
    },
    /** Asks for the folder first, for a chat opened from the session list. */
    ask: setAsking,
    dialog: asking && (
      <ChatOpenDialog
        profile={asking}
        open={(folder) => {
          setAsking(null);
          open({ place: { kind: 'ssh', profile: asking }, folder });
        }}
        close={() => setAsking(null)}
      />
    ),
    close,
    /** What the tab menu offers on a chat tab. */
    menu: {
      owns: (key: string) => chats.some((c) => tabKey(refOf(c)) === key),
      again: (key: string) => {
        const chat = chats.find((c) => tabKey(refOf(c)) === key);
        if (chat) open(chat.session);
      },
      copy: (key: string) => {
        const chat = chats.find((c) => tabKey(refOf(c)) === key);
        // A failed copy has nowhere better to be said than the chat itself, which shows nothing.
        if (chat)
          void call('clipboard_write_text', {
            text: chatTranscript(chat.session.snapshot()),
          }).catch(() => {});
      },
    },
    renderTab: (tab: ChatRef, active: boolean, select: () => void) => {
      const chat = find(tab);
      return (
        chat && (
          <ChatTab chat={chat} active={active} select={select} close={() => close(tabKey(tab))} />
        )
      );
    },
    renderCell: (tab: ChatRef) => {
      const chat = find(tab);
      return chat && <ChatPane session={chat.session} again={() => open(chat.session)} />;
    },
  };
}
