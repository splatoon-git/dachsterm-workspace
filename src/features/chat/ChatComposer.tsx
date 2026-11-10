import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatSession } from './chatSession';
import { canSend, commandMatches, modelLabel, tokenText, type ChatState } from './chatState';

type Panel = 'model' | 'context' | 'agents' | null;

/** A list over the composer. It closes on Escape or a press anywhere else. */
function Popover({
  label,
  close,
  children,
}: {
  label: string;
  close: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [close]);
  return (
    <div
      ref={root}
      className="chat-popover"
      role="dialog"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      {children}
    </div>
  );
}

/** How full the context window is, as a ring. */
function ContextRing({ percentage }: { percentage: number }) {
  const circumference = 2 * Math.PI * 6;
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="chat-ring">
      <circle cx="8" cy="8" r="6" />
      <circle
        cx="8"
        cy="8"
        r="6"
        className="used"
        strokeDasharray={`${(circumference * percentage) / 100} ${circumference}`}
      />
    </svg>
  );
}

const agentStates = { running: '실행 중', done: '완료', failed: '실패' } as const;

/** The prompt box with its row of controls: commands, subagents, context, model, send or stop. */
export function ChatComposer({ session, chat }: { session: ChatSession; chat: ChatState }) {
  const [draft, setDraft] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const working = chat.phase === 'working';
  const ended = chat.phase === 'ended';
  const commands = dismissed === draft ? [] : commandMatches(chat, draft).slice(0, 8);
  const running = chat.agents.filter((a) => a.status === 'running').length;
  const toggle = (next: Panel) => setPanel((open) => (open === next ? null : next));
  const close = () => setPanel(null);
  const submit = async () => {
    const text = draft;
    if (!text.trim() || !canSend(chat)) return;
    setDraft('');
    if (!(await session.send(text))) setDraft(text);
  };
  const chooseCommand = (name: string) => {
    setDraft(`/${name} `);
    setPick(0);
    box.current?.focus();
  };
  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {commands.length > 0 && (
        <ul className="chat-popover chat-commands" role="listbox" aria-label="명령">
          {commands.map((c, i) => (
            <li
              key={c.value}
              role="option"
              aria-selected={i === pick}
              onPointerDown={(e) => {
                e.preventDefault();
                chooseCommand(c.value);
              }}
            >
              <b>/{c.value}</b>
              {c.hint && <span className="chat-hint">{c.hint}</span>}
              <span className="chat-detail">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {panel === 'model' && (
        <Popover label="모델" close={close}>
          {chat.offers.models.map((m) => (
            <button
              key={m.value}
              type="button"
              className={m.label === modelLabel(chat) ? 'on' : undefined}
              onClick={() => {
                close();
                void session.setModel(m.value);
              }}
            >
              <b>{m.label}</b>
              <span className="chat-detail">{m.detail}</span>
            </button>
          ))}
        </Popover>
      )}
      {panel === 'context' && chat.context && (
        <Popover label="컨텍스트" close={close}>
          <p className="chat-popover-title">
            컨텍스트 {tokenText(chat.context.used)} / {tokenText(chat.context.max)} (
            {chat.context.percentage}%)
          </p>
          <ul className="chat-parts">
            {chat.context.parts.map((part) => (
              <li key={part.name} className={part.free ? 'free' : undefined}>
                <span>{part.name}</span>
                <span>{tokenText(part.tokens)}</span>
              </li>
            ))}
          </ul>
        </Popover>
      )}
      {panel === 'agents' && (
        <Popover label="서브에이전트" close={close}>
          <ul className="chat-parts">
            {chat.agents.map((agent) => (
              <li key={agent.id} title={agent.summary || undefined}>
                <span>
                  <b>{agent.role}</b> {agent.task}
                </span>
                <span>{agentStates[agent.status]}</span>
              </li>
            ))}
          </ul>
        </Popover>
      )}
      <textarea
        ref={box}
        aria-label="프롬프트"
        rows={2}
        value={draft}
        disabled={ended}
        placeholder={
          ended
            ? '이 채팅은 끝났습니다.'
            : working
              ? '이어서 지시하기. 작업 중에도 보낼 수 있습니다'
              : '에이전트에게 맡길 일을 적어 주세요. / 로 명령'
        }
        aria-expanded={commands.length > 0}
        onChange={(e) => {
          setDraft(e.target.value);
          setPick(0);
        }}
        onKeyDown={(e) => {
          // Keys never act while an input method is composing.
          if (e.nativeEvent.isComposing) return;
          if (commands.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : commands.length - 1;
              setPick((pick + step) % commands.length);
              return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
              e.preventDefault();
              chooseCommand(commands[pick].value);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(draft);
              return;
            }
          }
          // Enter sends; Shift+Enter is a new line.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="chat-composer-row">
        <button
          type="button"
          className="chat-icon"
          aria-label="명령"
          title="명령 (/)"
          disabled={ended || !chat.offers.commands.length}
          onClick={() => {
            setDraft('/');
            setDismissed('');
            box.current?.focus();
          }}
        >
          /
        </button>
        {chat.agents.length > 0 && (
          <button
            type="button"
            className="chat-chip"
            aria-expanded={panel === 'agents'}
            onClick={() => toggle('agents')}
          >
            {running ? `에이전트 ${running}개 실행 중` : `에이전트 ${chat.agents.length}`}
          </button>
        )}
        <span className="chat-spacer" />
        {chat.context && (
          <button
            type="button"
            className="chat-chip"
            aria-label={`컨텍스트 ${chat.context.percentage}% 사용`}
            aria-expanded={panel === 'context'}
            onClick={() => toggle('context')}
          >
            <ContextRing percentage={chat.context.percentage} />
            {chat.context.percentage}%
          </button>
        )}
        {(chat.model || chat.chosen) && (
          <button
            type="button"
            className="chat-chip"
            aria-label={`모델 ${modelLabel(chat)}`}
            aria-expanded={panel === 'model'}
            disabled={ended || !chat.offers.models.length}
            onClick={() => toggle('model')}
          >
            {modelLabel(chat)}
          </button>
        )}
        {working && !draft.trim() ? (
          <button
            type="button"
            className="chat-send"
            aria-label="작업 중지"
            title="작업 중지"
            disabled={chat.stopping}
            onClick={() => void session.interrupt()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4" y="4" width="8" height="8" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            className="chat-send"
            aria-label="보내기"
            title="보내기 (Enter)"
            disabled={!canSend(chat) || !draft.trim()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
