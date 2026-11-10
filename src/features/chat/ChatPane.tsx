import { lazy, Suspense, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AuthPromptCard, HostKeyCard } from '../../components/ConnectionCards';
import { call } from '../../lib/ipc';
import { placeDetail, placeTitle, type ChatSession } from './chatSession';
import { ApprovalCard, EditLines } from './ChatApproval';
import { ChatComposer } from './ChatComposer';
import { waitsForUser, type ChatAgent, type ChatItem, type ChatPhase } from './chatState';
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

const toolStates = { running: '실행 중', done: '완료', failed: '실패' } as const;

function Tool({
  item,
  agent,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>;
  /** The subagent this call started, if it started one. */
  agent?: ChatAgent;
}) {
  const [open, setOpen] = useState(false);
  const hasBody = !!item.edit || !!item.output;
  return (
    <li className={`chat-step tool ${agent?.status ?? item.status}`}>
      <button
        type="button"
        className="chat-tool"
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => setOpen((v) => !v)}
      >
        <b>{agent ? `${agent.role} 에이전트` : item.name}</b>
        <span className="chat-tool-summary">{agent?.task ?? item.summary}</span>
        <span className="sr-only">{toolStates[agent?.status ?? item.status]}</span>
      </button>
      {agent && (
        <p className={`chat-subagent ${agent.status}`}>
          {agent.status === 'running' ? '서브에이전트가 작업 중입니다' : agent.summary}
        </p>
      )}
      {open && item.edit && <EditLines edit={item.edit} />}
      {open && item.output && <pre className="chat-output">{item.output}</pre>}
    </li>
  );
}

/** Copies one message. It says so for a moment, since the clipboard itself shows nothing. */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="chat-copy"
      aria-label={done ? '복사됨' : '복사'}
      title={done ? '복사됨' : '복사'}
      onClick={() =>
        void call('clipboard_write_text', { text }).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {done ? (
          <path d="M3.5 8.5l3 3 6-7" />
        ) : (
          <>
            <rect x="5" y="5" width="8" height="8" rx="1.5" />
            <path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" />
          </>
        )}
      </svg>
    </button>
  );
}

function Item({
  item,
  agents,
  session,
}: {
  item: ChatItem;
  agents: ChatAgent[];
  session: ChatSession;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <li className="chat-you">
          {item.text}
          {item.files.length > 0 && (
            <span className="chat-you-files">첨부: {item.files.join(', ')}</span>
          )}
          <CopyButton text={item.text} />
        </li>
      );
    case 'agent':
      return (
        <li className="chat-step chat-reply">
          <Reply text={item.text} streaming={item.streaming} />
          {!item.streaming && <CopyButton text={item.text} />}
        </li>
      );
    case 'thinking':
      return (
        <li className={`chat-step quiet${item.seconds === null ? ' running' : ''}`}>
          {item.seconds === null ? '생각하는 중…' : `${item.seconds}초 생각함`}
        </li>
      );
    case 'tool':
      return <Tool item={item} agent={agents.find((a) => a.call === item.call)} />;
    case 'approval':
      return <ApprovalCard item={item} session={session} />;
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
export function ChatPane({
  session,
  again,
}: {
  session: ChatSession;
  /** Opens another chat in the same place and folder. */
  again: () => void;
}) {
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
  // Not while the agent waits for the user, or while its reply is visibly being written.
  const busy = working && !waitsForUser(chat) && !(last?.kind === 'agent' && last.streaming);
  return (
    <section className="chat-pane" aria-label={`${title} 에이전트 채팅`}>
      <header className="chat-head">
        <strong>{title}</strong>
        <span>{[placeDetail(place), folder].filter(Boolean).join(' · ')}</span>
        <button
          type="button"
          className="chat-icon chat-new"
          aria-label="같은 위치에서 새 채팅"
          title="같은 위치에서 새 채팅"
          onClick={again}
        >
          +
        </button>
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
            <Item key={item.id} item={item} agents={chat.agents} session={session} />
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
