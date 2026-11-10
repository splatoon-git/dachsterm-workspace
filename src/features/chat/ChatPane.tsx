import { lazy, Suspense, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AuthPromptCard, HostKeyCard } from '../../components/ConnectionCards';
import { placeDetail, placeTitle, type ChatSession } from './chatSession';
import { ChatComposer } from './ChatComposer';
import { type ChatEdit, type ChatItem, type ChatPhase } from './chatState';
import './chat.css';

// The Markdown renderer is its own chunk, loaded with the first reply.
const MarkdownPreview = lazy(() => import('../../components/MarkdownPreview'));

const waiting: Partial<Record<ChatPhase, string>> = {
  starting: '에이전트를 시작하는 중…',
};

function Reply({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Suspense fallback={<p className="chat-plain">{text}</p>}>
      <MarkdownPreview text={text} className={`chat-markdown${streaming ? ' streaming' : ''}`} />
    </Suspense>
  );
}

function EditLines({ edit }: { edit: ChatEdit }) {
  const lines = (text: string) => (text ? text.split('\n') : []);
  return (
    <pre className="chat-diff" aria-label={`${edit.path} 변경`}>
      {lines(edit.before).map((line, i) => (
        <span key={`b${i}`} className="del">
          {`- ${line}`}
        </span>
      ))}
      {lines(edit.after).map((line, i) => (
        <span key={`a${i}`} className="add">
          {`+ ${line}`}
        </span>
      ))}
    </pre>
  );
}

const toolStates = { running: '실행 중', done: '완료', failed: '실패' } as const;

function Tool({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const hasBody = !!item.edit || !!item.output;
  return (
    <li className={`chat-step tool ${item.status}`}>
      <button
        type="button"
        className="chat-tool"
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => setOpen((v) => !v)}
      >
        <b>{item.name}</b>
        <span className="chat-tool-summary">{item.summary}</span>
        <span className="sr-only">{toolStates[item.status]}</span>
      </button>
      {open && item.edit && <EditLines edit={item.edit} />}
      {open && item.output && <pre className="chat-output">{item.output}</pre>}
    </li>
  );
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <li className="chat-you">{item.text}</li>;
    case 'agent':
      return (
        <li className="chat-step">
          <Reply text={item.text} streaming={item.streaming} />
        </li>
      );
    case 'thinking':
      return (
        <li className={`chat-step quiet${item.seconds === null ? ' running' : ''}`}>
          {item.seconds === null ? '생각하는 중…' : `${item.seconds}초 생각함`}
        </li>
      );
    case 'tool':
      return <Tool item={item} />;
    case 'notice':
      return (
        <li
          className={`chat-notice ${item.tone}`}
          role={item.tone === 'error' ? 'alert' : undefined}
        >
          {item.text}
        </li>
      );
  }
}

/** A conversation with the agent of a server or of this PC, in the manner of an editor's chat. */
export function ChatPane({ session }: { session: ChatSession }) {
  const chat = useSyncExternalStore(session.subscribe, session.snapshot);
  const link = useSyncExternalStore(session.link.subscribe, session.link.snapshot);
  const thread = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const { place, folder } = session;
  const title = placeTitle(place);
  const last = chat.items.at(-1);
  // Follows new output unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const view = thread.current;
    if (view && stuck.current) view.scrollTop = view.scrollHeight;
  }, [chat.items.length, last]);
  const status = chat.phase === 'connecting' ? link.message : waiting[chat.phase];
  const working = chat.phase === 'working';
  const busy = working && !(last?.kind === 'agent' && last.streaming);
  return (
    <section className="chat-pane" aria-label={`${title} 에이전트 채팅`}>
      <header className="chat-head">
        <strong>{title}</strong>
        <span>{[placeDetail(place), folder].filter(Boolean).join(' · ')}</span>
      </header>
      <div
        className="chat-thread"
        ref={thread}
        onScroll={(e) => {
          const view = e.currentTarget;
          stuck.current = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
        }}
      >
        <ol className="chat-column" aria-label="대화" aria-live="polite">
          {chat.items.map((item) => (
            <Item key={item.id} item={item} />
          ))}
          {busy && (
            <li className="chat-step quiet running">
              {chat.stopping ? '중지하는 중…' : '작업 중…'}
            </li>
          )}
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
                host={link.profile?.host ?? ''}
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
      <ChatComposer session={session} chat={chat} />
    </section>
  );
}
