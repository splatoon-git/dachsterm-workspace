import { useEffect, useRef, type ReactNode } from 'react';
import type { ChatSession } from './chatSession';
import type { ChatState } from './chatState';
import {
  costText,
  effortLabel,
  effortLevels,
  limitLabel,
  modelLabel,
  modesOf,
  resetText,
  tokenText,
} from './chatText';

/** A list over the composer. It closes on Escape or a press anywhere else. */
export function Popover({
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

type Props = { session: ChatSession; chat: ChatState; close: () => void };

export function ModelPanel({ session, chat, close }: Props) {
  const levels = effortLevels(chat);
  return (
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
      {session.program === 'claude' && (
        <label className="chat-switch">
          <span>
            <b>Ultracode</b>
            <span className="chat-detail">
              모든 작업에 여러 에이전트 흐름을 씁니다. 이 세션에만 적용됩니다.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={chat.ultracode}
            disabled={chat.phase !== 'ready'}
            onChange={(e) => void session.setUltracode(e.target.checked)}
          />
        </label>
      )}
      {levels.length > 0 && (
        <div className="chat-effort" role="group" aria-label="노력 수준">
          <span>노력</span>
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={chat.effort === level}
              onClick={() => void session.setEffort(level)}
            >
              {effortLabel(level)}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

export function ModePanel({ session, chat, close }: Props) {
  return (
    <Popover label="권한 모드" close={close}>
      {modesOf(session.program).map((mode) => (
        <button
          key={mode.value}
          type="button"
          className={[
            mode.value === chat.permissionMode ? 'on' : '',
            mode.risky ? 'risky' : '',
          ].join(' ')}
          onClick={() => {
            close();
            void session.setMode(mode.value);
          }}
        >
          <b>{mode.risky ? `${mode.label} (위험)` : mode.label}</b>
          <span className="chat-detail">{mode.detail}</span>
        </button>
      ))}
      <p className="chat-popover-note">
        SSH 키 서명과 Git 자격 증명은 어느 모드에서도 앱의 승인을 따릅니다.
      </p>
    </Popover>
  );
}

function Bar({ percent }: { percent: number }) {
  return (
    <span className="chat-bar" aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </span>
  );
}

export function UsagePanel({ chat, close }: Omit<Props, 'session'>) {
  return (
    <Popover label="계정과 사용량" close={close}>
      {chat.account && (
        <p className="chat-popover-title">
          {chat.account.plan || 'API 키'}
          {chat.account.email && <span className="chat-detail"> · {chat.account.email}</span>}
        </p>
      )}
      <ul className="chat-parts">
        {chat.limits.map((limit) => (
          <li key={limit.name} className="chat-limit">
            <span>{limitLabel(limit.name)}</span>
            <Bar percent={limit.percent} />
            <span>{Math.round(limit.percent)}%</span>
            <span className="chat-detail">{resetText(limit.resetsAt)}</span>
          </li>
        ))}
        {chat.usage && (
          <li>
            <span>이 채팅</span>
            <span>
              {costText(chat.usage.cost)} · +{chat.usage.added} −{chat.usage.removed}줄
            </span>
          </li>
        )}
      </ul>
    </Popover>
  );
}

export function ContextPanel({ chat, close }: Omit<Props, 'session'>) {
  if (!chat.context) return null;
  const { used, max, percentage, parts } = chat.context;
  return (
    <Popover label="컨텍스트" close={close}>
      <p className="chat-popover-title">
        컨텍스트 {tokenText(used)} / {tokenText(max)} ({percentage}%)
      </p>
      <ul className="chat-parts">
        {parts.map((part) => (
          <li key={part.name} className={part.free ? 'free' : undefined}>
            <span>{part.name}</span>
            <span>{tokenText(part.tokens)}</span>
          </li>
        ))}
      </ul>
      {chat.lastTurn && (
        <>
          <p className="chat-popover-title">지난 턴</p>
          <ul className="chat-parts">
            <li>
              <span>캐시 읽기 · 쓰기</span>
              <span>
                {tokenText(chat.lastTurn.cacheRead)} · {tokenText(chat.lastTurn.cacheWrite)}
              </span>
            </li>
            <li>
              <span>입력 · 출력</span>
              <span>
                {tokenText(chat.lastTurn.input)} · {tokenText(chat.lastTurn.output)}
              </span>
            </li>
          </ul>
        </>
      )}
    </Popover>
  );
}

const agentStates = { running: '실행 중', done: '완료', failed: '실패' } as const;

export function AgentsPanel({ chat, close }: Omit<Props, 'session'>) {
  return (
    <Popover label="서브에이전트" close={close}>
      {chat.agents.length ? (
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
      ) : (
        <p className="chat-popover-note">
          아직 서브에이전트가 없습니다. 쓸 수 있는 에이전트:{' '}
          {chat.offers.agents.map((a) => a.label).join(', ') || '없음'}
        </p>
      )}
    </Popover>
  );
}
