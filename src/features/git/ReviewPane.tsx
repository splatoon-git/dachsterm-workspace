import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { call, errorText } from '../../lib/ipc';
import { DiffView, type RowSelection } from './DiffView';
import {
  changeLabel,
  changeMark,
  refLabel,
  sizeText,
  terminalCommand,
  type DiffFile,
} from './gitDiff';
import { deliveryText, promptText, type Delivery, type ReviewNote } from './review';
import { NoteComposer, NoteList } from './ReviewNotes';
import { parseUnifiedDiff, selectionRange, splitRows, unifiedRows, type Row } from './unifiedDiff';
import { useReviewData, type ReviewData } from './useReviewData';
import './review.css';

/** Below this width the old and new lines stack in one column. */
const SPLIT_WIDTH = 900;
/** Below this width the file list becomes a drop-down above the diff. */
const LIST_WIDTH = 640;

const counts = (file: DiffFile) =>
  file.binary ? '바이너리' : file.added === null ? '' : `+${file.added} −${file.removed}`;
const fileName = (file: DiffFile) => (file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const element = ref.current!;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function FileList({ data, compact }: { data: ReviewData; compact: boolean }) {
  const { files, current, choose } = data;
  if (compact)
    return (
      <select
        className="review-file-select"
        aria-label="변경 파일"
        value={current?.path ?? ''}
        onChange={(e) => {
          const file = files.find((f) => f.path === e.target.value);
          if (file) choose(file);
        }}
      >
        {files.map((file) => (
          <option key={file.path} value={file.path}>
            {changeMark[file.change]} {fileName(file)} {counts(file)}
          </option>
        ))}
      </select>
    );
  return (
    <ul className="review-files" aria-label="변경 파일">
      {files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            aria-current={file === current ? 'true' : undefined}
            title={`${changeLabel[file.change]} · ${fileName(file)}`}
            onClick={() => choose(file)}
          >
            <span className="review-mark" data-change={file.change}>
              {changeMark[file.change]}
            </span>
            <span className="review-path">{fileName(file)}</span>
            <span className="review-counts">{counts(file)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Why a file has no diff to show, with the command that shows it in a terminal. */
function Unshown({
  data,
  reason,
  copy,
}: {
  data: ReviewData;
  reason: string;
  copy: (text: string) => void;
}) {
  const command = data.current && terminalCommand(data.base, data.current);
  return (
    <div className="review-empty">
      <p>{reason}</p>
      {command && (
        <p>
          터미널에서 보기: <code>{command}</code>{' '}
          <button type="button" onClick={() => copy(command)}>
            명령 복사
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * The changes of the repository the target terminal's shell is in, and the comments that go to
 * its prompt. Read-only: nothing here changes the repository.
 */
export function ReviewPane({
  connectionId,
  folder,
  target,
  send,
}: {
  connectionId: string;
  folder: string;
  /** The terminal the comments go to, fixed when the review opened. */
  target: string;
  /** Pastes into the target without Enter, given the text for its paste mode. */
  send: (format: (multiline: boolean) => string) => Delivery;
}) {
  const data = useReviewData(connectionId, folder);
  const { ref, width } = useWidth();
  const split = width >= SPLIT_WIDTH;
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const [selection, setSelection] = useState<(RowSelection & { rows: Row[] }) | null>(null);
  const file = data.file?.state === 'ready' ? data.file.value : null;
  const parsed = useMemo(
    () => (file?.kind === 'text' ? parseUnifiedDiff(file.text) : null),
    [file],
  );
  const rows = useMemo(
    () => (parsed ? (split ? splitRows : unifiedRows)(parsed) : []),
    [parsed, split],
  );
  // A selection belongs to the rows it was made on; another file or layout drops it.
  const picked = selection?.rows === rows ? selection : null;
  const range = picked && selectionRange(rows, picked.from, picked.to);
  const copy = (text: string) =>
    void call('clipboard_write_text', { text })
      .then(() => setMessage({ text: '복사했습니다.', alert: false }))
      .catch((e) => setMessage({ text: errorText(e), alert: true }));
  const refs = data.refs.state === 'ready' ? data.refs.value : null;
  const list = data.list?.state === 'ready' ? data.list.value : null;
  const total = data.files.reduce(
    (sum, f) => ({ added: sum.added + (f.added ?? 0), removed: sum.removed + (f.removed ?? 0) }),
    { added: 0, removed: 0 },
  );
  const failure =
    data.refs.state === 'error'
      ? data.refs.message
      : data.list?.state === 'error'
        ? data.list.message
        : null;

  const body = () => {
    // A failure shows once, above; an empty list under it would read as "no changes".
    if (failure) return null;
    if (data.refs.state === 'loading' || data.list?.state === 'loading' || !data.list)
      return <p className="review-empty">변경 목록을 읽는 중…</p>;
    if (list?.kind === 'stopped')
      return (
        <p className="review-empty">
          변경 목록이 {list.reason === 'timeout' ? '10초 안에 오지 않아' : '너무 커서'} 멈췄습니다.
          터미널에서 <code>git status</code>로 확인하세요.
        </p>
      );
    if (!data.files.length) return <p className="review-empty">변경이 없습니다.</p>;
    const current = data.current;
    let content;
    if (!current) content = <p className="review-empty">파일을 고르세요.</p>;
    else if (!current.readable)
      content = (
        <p className="review-empty">이름을 UTF-8로 읽을 수 없는 파일이라 내용을 열지 않습니다.</p>
      );
    else if (!data.file || data.file.state === 'loading')
      content = <p className="review-empty">diff를 읽는 중…</p>;
    else if (data.file.state === 'error')
      content = (
        <p className="review-empty" role="alert">
          {data.file.message}
        </p>
      );
    else if (file?.kind === 'tooLarge')
      content = (
        <Unshown
          data={data}
          copy={copy}
          reason={`파일이 커서${file.size === null ? '' : `(${sizeText(file.size)})`} 표시하지 않습니다. 2 MB까지 표시합니다.`}
        />
      );
    else if (file?.kind === 'timedOut')
      content = <Unshown data={data} copy={copy} reason="diff가 10초 안에 오지 않았습니다." />;
    else if (parsed?.binary)
      content = (
        <Unshown data={data} copy={copy} reason="바이너리 변경입니다. 내용은 표시하지 않습니다." />
      );
    else if (parsed && !rows.length)
      content = (
        <p className="review-empty">{parsed.meta.join(' · ') || '내용 변경이 없습니다.'}</p>
      );
    else
      content = (
        <>
          {parsed && parsed.meta.length > 0 && (
            <p className="review-meta">{parsed.meta.join(' · ')}</p>
          )}
          <DiffView
            rows={rows}
            label={`${current.path} diff`}
            selection={picked}
            select={(index, extend) =>
              setSelection(
                extend && picked ? { ...picked, to: index } : { rows, from: index, to: index },
              )
            }
          />
          {range && (
            <NoteComposer
              key={`${current.path}:${picked!.from}`}
              path={current.path}
              range={range}
              cancel={() => setSelection(null)}
              add={(text) => {
                setNotes((old) => [
                  ...old,
                  { id: crypto.randomUUID(), path: current.path, ...range, text },
                ]);
                setSelection(null);
              }}
            />
          )}
        </>
      );
    return (
      <div className={`review-body ${width < LIST_WIDTH ? 'compact' : ''}`}>
        <FileList data={data} compact={width < LIST_WIDTH} />
        <div className="review-file">{content}</div>
      </div>
    );
  };

  return (
    <div className="review-pane" ref={ref}>
      <div className="review-bar">
        <label>
          기준
          <select
            value={data.base.kind === 'branch' ? data.base.ref : ''}
            onChange={(e) =>
              data.chooseBase(
                e.target.value ? { kind: 'branch', ref: e.target.value } : { kind: 'workingTree' },
              )
            }
          >
            <option value="">HEAD · 커밋하지 않은 변경</option>
            {refs?.refs.map((name) => (
              <option key={name} value={name}>
                {refLabel(name)}에서 갈라진 뒤
              </option>
            ))}
          </select>
        </label>
        {refs && refs.worktrees.length > 1 && (
          <label>
            작업 폴더
            <select value={data.root} onChange={(e) => data.chooseRoot(e.target.value)}>
              {refs.worktrees.map((tree) => (
                <option key={tree.path} value={tree.path}>
                  {tree.path}
                  {tree.branch ? ` · ${refLabel(tree.branch)}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {list?.kind === 'files' && (
          <span className="review-summary">
            파일 {data.files.length}
            {list.truncated ? '+' : ''}개 · +{total.added} −{total.removed}
          </span>
        )}
        <button
          type="button"
          className="review-refresh"
          aria-label="새로 고침"
          title="새로 고침"
          onClick={data.refresh}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {failure && (
        <p className="review-message" role="alert">
          {failure}
        </p>
      )}
      {body()}
      {message && (
        <p className="review-message" role={message.alert ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      {notes.length > 0 && (
        <NoteList
          notes={notes}
          target={target}
          remove={(id) => setNotes((old) => old.filter((n) => n.id !== id))}
          clear={() => setNotes([])}
          copy={() => copy(promptText(notes, true))}
          send={() => {
            const result = send((multiline) => promptText(notes, multiline));
            setMessage({ text: deliveryText[result], alert: result !== 'sent' });
          }}
        />
      )}
    </div>
  );
}
