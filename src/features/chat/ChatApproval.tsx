import { useState } from 'react';
import type { ChatSession } from './chatSession';
import type { ChatEdit, ChatItem, ChatQuestion } from './chatState';
import { scopeText } from './chatText';

/** A file edit as removed and added lines. */
export function EditLines({ edit }: { edit: ChatEdit }) {
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

type Approval = Extract<ChatItem, { kind: 'approval' }>;

const titles: Record<string, string> = {
  Bash: '명령을 실행할까요?',
  Edit: '파일을 바꿀까요?',
  MultiEdit: '파일을 바꿀까요?',
  Write: '파일을 쓸까요?',
  NotebookEdit: '노트북을 바꿀까요?',
  WebFetch: '이 주소를 읽을까요?',
};

/** The agent's question tool: one choice per question, more where it allows several. */
function Questions({
  item,
  session,
  offline,
}: {
  item: Approval;
  session: ChatSession;
  offline: boolean;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const toggle = (question: ChatQuestion, label: string) =>
    setPicked((now) => {
      const was = now[question.question] ?? [];
      const next = question.multi
        ? was.includes(label)
          ? was.filter((l) => l !== label)
          : [...was, label]
        : [label];
      return { ...now, [question.question]: next };
    });
  const complete = item.questions.every((q) => picked[q.question]?.length);
  return (
    <>
      {item.questions.map((question) => (
        <fieldset key={question.question} className="chat-question">
          <legend>
            {question.header && <span className="chat-chip">{question.header}</span>}{' '}
            {question.question}
          </legend>
          {question.options.map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={picked[question.question]?.includes(option.label) ?? false}
              onClick={() => toggle(question, option.label)}
            >
              <b>{option.label}</b>
              {option.detail && <span className="chat-detail">{option.detail}</span>}
            </button>
          ))}
        </fieldset>
      ))}
      <div className="chat-approval-actions">
        <button
          type="button"
          className="primary"
          disabled={!complete || offline}
          onClick={() =>
            void session.answer(item.request, 'allow', {
              answers: Object.fromEntries(
                Object.entries(picked).map(([question, labels]) => [question, labels.join(', ')]),
              ),
            })
          }
        >
          답하기
        </button>
        <button
          type="button"
          disabled={offline}
          onClick={() => void session.answer(item.request, 'deny')}
        >
          답하지 않기
        </button>
      </div>
    </>
  );
}

const settled = {
  allowed: '허용함',
  denied: '거부함',
  expired: '답하기 전에 끝남',
} as const;

/** An approval the agent waits for, or, once answered, one line saying how. */
export function ApprovalCard({
  item,
  session,
  offline,
}: {
  item: Approval;
  session: ChatSession;
  /** The connection is lost; the agent still waits, and the card can be answered once back. */
  offline: boolean;
}) {
  const question = item.questions.length > 0;
  if (item.status !== 'pending')
    return (
      <li className={`chat-step quiet approval ${item.status}`}>
        {question
          ? item.status === 'allowed'
            ? `답함: ${item.answer}`
            : settled[item.status]
          : `${item.auto ? '자동 허용' : settled[item.status]} · ${item.tool} ${item.summary}`}
      </li>
    );
  return (
    <li className="chat-approval" role="group" aria-label={`${item.tool} 승인 요청`}>
      <p className="chat-approval-title">
        {question ? '에이전트가 묻습니다' : (titles[item.tool] ?? `${item.tool}을(를) 쓸까요?`)}
      </p>
      {!question && item.summary && <code className="chat-approval-what">{item.summary}</code>}
      {item.detail && <p className="chat-approval-detail">{item.detail}</p>}
      {item.edit && <EditLines edit={item.edit} />}
      {offline && (
        <p className="chat-approval-detail">
          연결이 끊어져 지금은 답할 수 없습니다. 다시 연결하면 이 요청에 이어서 답합니다.
        </p>
      )}
      {question ? (
        <Questions item={item} session={session} offline={offline} />
      ) : (
        <div className="chat-approval-actions">
          <button
            type="button"
            className="primary"
            disabled={offline}
            onClick={() => void session.answer(item.request, 'allow')}
          >
            이번만 허용
          </button>
          <button
            type="button"
            disabled={offline}
            onClick={() => void session.answer(item.request, 'chat')}
          >
            {scopeText(item.tool)}
          </button>
          <button
            type="button"
            disabled={offline}
            onClick={() => void session.answer(item.request, 'deny')}
          >
            거부
          </button>
        </div>
      )}
    </li>
  );
}
