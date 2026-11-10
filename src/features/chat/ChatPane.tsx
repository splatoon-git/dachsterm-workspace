import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AuthPromptCard, HostKeyCard } from '../../components/ConnectionCards';
import type { ChatSession } from './chatSession';
import { canSend, type ChatItem, type ChatPhase } from './chatState';
import './chat.css';

const waiting: Partial<Record<ChatPhase, string>> = {
  starting: '에이전트를 시작하는 중…',
  working: '작업 중…',
};

function Item({ item }: { item: ChatItem }) {
  if (item.kind === 'user') return <li className="chat-you">{item.text}</li>;
  if (item.kind === 'agent') return <li className="chat-agent">{item.text}</li>;
  return (
    <li className={`chat-notice ${item.tone}`} role={item.tone === 'error' ? 'alert' : undefined}>
      {item.text}
    </li>
  );
}

/** A saved SSH session as a conversation with the agent on the server (AC.1). */
export function ChatPane({ session }: { session: ChatSession }) {
  const chat = useSyncExternalStore(session.subscribe, session.snapshot);
  const link = useSyncExternalStore(session.link.subscribe, session.link.snapshot);
  const [draft, setDraft] = useState('');
  const thread = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const { profile, folder } = session;
  // Follows new messages unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const view = thread.current;
    if (view && stuck.current) view.scrollTop = view.scrollHeight;
  }, [chat.items.length]);
  const submit = async () => {
    const text = draft;
    if (!text.trim() || !canSend(chat)) return;
    setDraft('');
    if (!(await session.send(text))) setDraft(text);
  };
  const status = chat.phase === 'connecting' ? link.message : waiting[chat.phase];
  return (
    <section className="chat-pane" aria-label={`${profile.name} 에이전트 채팅`}>
      <header className="chat-head">
        <div>
          <h2>{profile.name}</h2>
          <p>
            {profile.username}@{profile.host}
            {folder ? ` · ${folder}` : ''}
          </p>
        </div>
        <span className="chat-chip">{chat.model ? `claude · ${chat.model}` : 'claude'}</span>
      </header>
      <div
        className="chat-thread"
        ref={thread}
        onScroll={(e) => {
          const view = e.currentTarget;
          stuck.current = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
        }}
      >
        <ol className="chat-column" aria-label="대화">
          {chat.items.map((item) => (
            <Item key={item.id} item={item} />
          ))}
        </ol>
        {(link.hostKey || link.authPrompt) && (
          <div className="chat-cards">
            {link.hostKey && (
              <HostKeyCard
                request={link.hostKey}
                answer={(accept) => void session.link.trust(accept)}
              />
            )}
            {link.authPrompt && (
              <AuthPromptCard
                key={link.authPrompt.challenge}
                host={profile.host}
                prompt={link.authPrompt}
                reply={(responses) => session.link.reply(responses)}
                cancel={session.close}
              />
            )}
          </div>
        )}
        {status && (
          <p className="chat-status" role="status">
            {status}
          </p>
        )}
      </div>
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          aria-label="프롬프트"
          rows={3}
          value={draft}
          disabled={chat.phase === 'ended'}
          placeholder={
            chat.phase === 'ended' ? '이 채팅은 끝났습니다.' : '에이전트에게 맡길 일을 적어 주세요'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Never while an input method is composing.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button type="submit" className="primary" disabled={!canSend(chat) || !draft.trim()}>
          보내기
        </button>
      </form>
    </section>
  );
}
