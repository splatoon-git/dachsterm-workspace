import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { Icon } from '../components/Icon';
import { sameWorkspace, type ChatLaunch, type ChatWorkspace } from '../features/chat/chatPlaces';
import { placeTitle, type ChatSession } from '../features/chat/chatSession';
import { chatSummary } from '../features/chat/chatStatus';
import { StatusBadge } from '../features/terminal/StatusBadge';
import { modKey } from '../lib/platform';
import './chatLauncher.css';

/** How a workspace reads in the launcher. */
export type Described = { title: string; detail: string };
/** Where "new chat" would open now, or why it cannot. */
export type LaunchTarget = Described | { reason: string };

type Open = { id: string; session: ChatSession };

function OpenChat({ chat, current, go }: { chat: Open; current: boolean; go: () => void }) {
  const state = useSyncExternalStore(chat.session.subscribe, chat.session.snapshot);
  const summary = chatSummary(state);
  const { place, folder } = chat.session;
  return (
    <li>
      <button
        type="button"
        className="chat-launch-row"
        aria-current={current ? 'page' : undefined}
        onClick={go}
      >
        <strong>{placeTitle(place)}</strong>
        <span className="chat-launch-detail">{folder || '기본 폴더'}</span>
        {summary && <StatusBadge summary={summary} />}
        {state.phase === 'disconnected' && !summary && (
          <small className="chat-launch-away">연결 끊김</small>
        )}
      </button>
    </li>
  );
}

/** Waiting chats, counted on the title bar icon so they are seen with the popover closed. */
function useWaiting(chats: readonly Open[]) {
  const read = () =>
    chats.filter((c) => chatSummary(c.session.snapshot())?.state === 'blocked').length;
  const subscribe = useCallback(
    (changed: () => void) => {
      const stops = chats.map((c) => c.session.subscribe(changed));
      return () => stops.forEach((stop) => stop());
    },
    [chats],
  );
  return useSyncExternalStore(subscribe, read);
}

/**
 * The title bar's chat entry (design §9.7): a new chat where the focused tab is or in a fixed
 * workspace, the recent workspaces, and the chats that are open. Ctrl/Cmd+Shift+A toggles it.
 */
export function ChatLauncher({
  open,
  setOpen,
  target,
  launch,
  setLaunch,
  choices,
  describe,
  openNew,
  openAt,
  chats,
  focused,
  select,
}: {
  open: boolean;
  setOpen(open: boolean): void;
  target: LaunchTarget;
  launch: ChatLaunch;
  setLaunch(next: ChatLaunch): void;
  /** What can be fixed: the focused tab's workspace, then the recent ones. */
  choices: ChatWorkspace[];
  describe(workspace: ChatWorkspace): Described | null;
  openNew(): void;
  openAt(workspace: ChatWorkspace): void;
  chats: readonly Open[];
  focused?: string;
  select(id: string): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const waiting = useWaiting(chats);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, setOpen]);
  const label = waiting ? `에이전트 채팅 · 입력 대기 ${waiting}` : '에이전트 채팅';
  const blocked = 'reason' in target;
  const { fixed } = launch;
  const fixedAt = fixed ? choices.findIndex((c) => sameWorkspace(c, fixed)) : -1;
  const recent = launch.recent.flatMap((w) => {
    const described = describe(w);
    return described ? [{ workspace: w, ...described }] : [];
  });
  const done = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div
      ref={root}
      className="chat-launcher"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <button
        ref={toggle}
        type="button"
        className="header-icon"
        aria-label={label}
        title={`${label} · ${modKey('Shift+A')}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chat" size={16} />
        {waiting > 0 && (
          <span className="chat-launch-count" aria-hidden="true">
            {waiting}
          </span>
        )}
      </button>
      {open && (
        <section className="chat-launch-popover" aria-label="에이전트 채팅">
          <button
            ref={first}
            type="button"
            className="chat-launch-new"
            disabled={blocked}
            onClick={done(openNew)}
          >
            <Icon name="plus" size={14} />
            <span>
              <strong>새 채팅</strong>
              <span className="chat-launch-detail">
                {blocked ? target.reason : `${target.title} · ${target.detail}`}
              </span>
            </span>
          </button>
          <fieldset className="chat-launch-mode">
            <legend>새 채팅 위치</legend>
            <label>
              <input
                type="radio"
                name="chat-launch-mode"
                checked={launch.mode === 'follow'}
                onChange={() => setLaunch({ ...launch, mode: 'follow' })}
              />
              현재 탭 따라가기
            </label>
            <label>
              <input
                type="radio"
                name="chat-launch-mode"
                checked={launch.mode === 'fixed'}
                disabled={!choices.length}
                onChange={() =>
                  setLaunch({ ...launch, mode: 'fixed', fixed: launch.fixed ?? choices[0] })
                }
              />
              고정
            </label>
          </fieldset>
          {launch.mode === 'fixed' && choices.length > 0 && (
            <select
              aria-label="고정할 작업 영역"
              value={Math.max(0, fixedAt)}
              onChange={(e) => setLaunch({ ...launch, fixed: choices[Number(e.target.value)] })}
            >
              {choices.map((choice, i) => {
                const described = describe(choice);
                return (
                  described && (
                    <option key={i} value={i}>
                      {described.title} · {described.detail}
                    </option>
                  )
                );
              })}
            </select>
          )}
          {recent.length > 0 && (
            <>
              <h3>최근 작업 영역</h3>
              <ul aria-label="최근 작업 영역">
                {recent.map((r, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="chat-launch-row"
                      onClick={done(() => openAt(r.workspace))}
                    >
                      <strong>{r.title}</strong>
                      <span className="chat-launch-detail">{r.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>열린 채팅</h3>
          {chats.length ? (
            <ul aria-label="열린 채팅">
              {chats.map((chat) => (
                <OpenChat
                  key={chat.id}
                  chat={chat}
                  current={chat.id === focused}
                  go={done(() => select(chat.id))}
                />
              ))}
            </ul>
          ) : (
            <p className="chat-launch-empty">열린 채팅이 없습니다.</p>
          )}
        </section>
      )}
    </div>
  );
}
