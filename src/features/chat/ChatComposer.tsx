import { useRef, useState } from 'react';
import { useFileDrop } from '../../lib/fileDrop';
import { call, errorText } from '../../lib/ipc';
import {
  addFiles,
  sizeText,
  type AttachItem,
  type ChatAttachment,
  type ClipboardImage,
} from './chatAttachments';
import type { ChatSession } from './chatSession';
import { AgentsPanel, ContextPanel, ModelPanel, ModePanel, UsagePanel } from './ChatPanels';
import {
  canSend,
  commandMatches,
  effortLabel,
  limitLabel,
  modeLabel,
  modelLabel,
  permissionModes,
  type ChatState,
} from './chatState';

type Panel = 'model' | 'context' | 'agents' | 'mode' | 'usage' | null;

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

/**
 * The prompt box with its row of controls, as an editor's chat has them: commands, subagents,
 * permission mode, usage, context, model with effort, and send or stop.
 */
export function ChatComposer({ session, chat }: { session: ChatSession; chat: ChatState }) {
  const [draft, setDraft] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const working = chat.phase === 'working';
  const ended = chat.phase === 'ended';
  const remote = session.place.kind === 'ssh';
  const empty = !draft.trim() && !attachments.length;
  /** A server receives at most 20 MiB a file; this PC's files are only named. */
  const addPaths = async (paths: string[]) => {
    if (!paths.length) return;
    setAttachError('');
    try {
      const items = await call<AttachItem[]>('prompt_files_inspect', { paths, upload: remote });
      setAttachments((list) => addFiles(list, paths, items));
    } catch (e) {
      setAttachError(errorText(e));
    }
  };
  const dropping = useFileDrop(form, (paths) => void addPaths(paths), !ended);
  const pasteImage = async () => {
    setAttachError('');
    try {
      const image = await call<ClipboardImage | null>('prompt_clipboard_inspect');
      if (image)
        setAttachments((list) => [
          ...list,
          { id: crypto.randomUUID(), kind: 'clipboard', digest: image.digest, ...image.item },
        ]);
    } catch (e) {
      setAttachError(errorText(e));
    }
  };
  const known = !!chat.account;
  const commands = dismissed === draft ? [] : commandMatches(chat, draft).slice(0, 8);
  const running = chat.agents.filter((a) => a.status === 'running').length;
  const agentsText = running ? `에이전트 ${running}개 실행 중` : `에이전트 ${chat.agents.length}`;
  const risky = permissionModes.find((m) => m.value === chat.permissionMode)?.risky;
  const shortLimit = chat.limits.find((l) => l.name === 'five_hour') ?? chat.limits[0];
  const toggle = (next: Panel) => setPanel((open) => (open === next ? null : next));
  const close = () => setPanel(null);
  const submit = async () => {
    const text = draft;
    const sending = attachments;
    if (empty || !canSend(chat)) return;
    setDraft('');
    setAttachments([]);
    if (!(await session.send(text, sending))) {
      setDraft(text);
      setAttachments(sending);
    }
  };
  const chooseCommand = (name: string) => {
    setDraft(`/${name} `);
    setPick(0);
    box.current?.focus();
  };
  const chip = (name: Exclude<Panel, null>, label: string, children: React.ReactNode) => (
    <button
      type="button"
      className="chat-chip"
      aria-label={label}
      aria-expanded={panel === name}
      disabled={ended}
      onClick={() => toggle(name)}
    >
      {children}
    </button>
  );
  return (
    <form
      ref={form}
      className={`chat-composer${dropping ? ' dropping' : ''}`}
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
      {panel === 'model' && <ModelPanel session={session} chat={chat} close={close} />}
      {panel === 'mode' && <ModePanel session={session} chat={chat} close={close} />}
      {panel === 'usage' && <UsagePanel chat={chat} close={close} />}
      {panel === 'context' && <ContextPanel chat={chat} close={close} />}
      {panel === 'agents' && <AgentsPanel chat={chat} close={close} />}
      {(attachments.length > 0 || attachError) && (
        <ul className="chat-attachments" aria-label="첨부">
          {attachments.map((a) => (
            <li key={a.id}>
              <span className="chat-attachment-name">{a.name}</span>
              <span className="chat-detail">{sizeText(a.size)}</span>
              <button
                type="button"
                className="chat-icon"
                aria-label={`첨부 빼기: ${a.name}`}
                onClick={() => setAttachments((list) => list.filter((x) => x !== a))}
              >
                ×
              </button>
            </li>
          ))}
          {attachError && (
            <li className="chat-attach-error" role="alert">
              {attachError}
            </li>
          )}
        </ul>
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
        onPaste={(e) => {
          // An image goes as an attachment; text pastes as usual.
          const image = Array.from(e.clipboardData.files).some((f) => f.type.startsWith('image/'));
          if (!image) return;
          e.preventDefault();
          void pasteImage();
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
          aria-label="파일 첨부"
          title="파일 첨부 · 끌어다 놓기 · 이미지 붙여넣기"
          disabled={ended}
          onClick={() =>
            void call<string[]>('chat_pick_files').then(addPaths, (e) =>
              setAttachError(errorText(e)),
            )
          }
        >
          +
        </button>
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
        {known && chip('agents', agentsText, agentsText)}
        <span className="chat-spacer" />
        {chat.permissionMode &&
          chip(
            'mode',
            `권한 모드 ${modeLabel(chat.permissionMode)}`,
            <span className={risky ? 'chat-risky' : undefined}>
              {modeLabel(chat.permissionMode)}
            </span>,
          )}
        {shortLimit &&
          chip(
            'usage',
            `사용량 ${limitLabel(shortLimit.name)} ${Math.round(shortLimit.percent)}%`,
            `${limitLabel(shortLimit.name)} ${Math.round(shortLimit.percent)}%`,
          )}
        {chat.context &&
          chip(
            'context',
            `컨텍스트 ${chat.context.percentage}% 사용`,
            <>
              <ContextRing percentage={chat.context.percentage} />
              {chat.context.percentage}%
            </>,
          )}
        {(chat.model || chat.chosen) &&
          chip(
            'model',
            `모델 ${modelLabel(chat)}`,
            [
              modelLabel(chat),
              chat.effort && effortLabel(chat.effort),
              chat.ultracode && 'Ultracode',
            ]
              .filter(Boolean)
              .join(' · '),
          )}
        {working && empty ? (
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
            disabled={!canSend(chat) || empty}
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
