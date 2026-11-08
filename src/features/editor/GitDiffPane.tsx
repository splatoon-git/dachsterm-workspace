import { useEffect, useRef, useState } from 'react';
import type { Source } from '../../lib/source';
import { DiffEditor } from './CodeEditor';
import { ConflictCard } from './ConflictCard';
import type { DiffLayout, EditorHandle } from './editorTypes';
import { ConfirmDialog } from './FileDialogs';
import { fileDocument, setFileDocument } from './fileDocuments';
import { languageOf } from './fileKinds';
import { Notice } from './FilePane';
import { readCurrentText, useFileSave, type ServerText } from './fileSave';
import { textFacts } from './fileText';
import {
  editsWorktree,
  readDiffLayout,
  saveDiffLayout,
  sideLabels,
  unshownReason,
  useGitFileDiff,
  type DiffSide,
  type GitDiffTarget,
  type GitFileDiff,
} from './gitFileDiff';
import { SaveBanners } from './SaveBanners';
import { FileTabBar, ViewSwitch } from './TextDocument';
import './fileTab.css';

export type GitDiffPaneProps = {
  id: string;
  source: Source;
  target: GitDiffTarget;
  /** The file's full path, which is where a save goes. */
  path: string;
  name: string;
  /** False once the connection the file came from has ended. */
  live: boolean;
  pin: () => void;
};

const layouts = [
  ['split', '좌우'],
  ['inline', '한 줄'],
] as const;
const textOf = (side: DiffSide) => (side.kind === 'text' ? side.text : '');
const lossy = (side: DiffSide) => side.kind === 'text' && side.lossy;
const notMoved = () => {};

/** One read of a file's two sides. The right side is a real editor when it is the working tree. */
function GitDiffDocument({
  id,
  source,
  target,
  path,
  name,
  live,
  pin,
  diff,
  reread,
  adopt,
}: GitDiffPaneProps & {
  diff: GitFileDiff;
  reread: () => void;
  adopt: (hash: string, text: string) => void;
}) {
  const { original, modified } = diff;
  const editor = useRef<EditorHandle | null>(null);
  const [layout, setLayout] = useState<DiffLayout>(readDiffLayout);
  const [dirty, setDirty] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [server, setServer] = useState<ServerText | null>(null);
  // Fixed for this editor's life: text typed while a save runs must not be replaced by what it
  // saved. A different right side comes with a new `generation`, and so a new editor.
  const [modifiedText] = useState(() => textOf(modified));
  const worktree = modified.kind === 'text' && editsWorktree(target.compare) ? modified : null;
  const editable = live && !!worktree && !worktree.lossy;
  const saving = useFileSave({
    source,
    path,
    encoding: worktree?.encoding ?? 'utf-8',
    hash: worktree?.hash ?? '',
    editor,
    moved: notMoved,
    saved: adopt,
  });
  const { conflict } = saving;
  const [mixedLineBreaks] = useState(
    () => modified.kind === 'text' && textFacts(modified.text).eol === '혼합',
  );

  const save = async () => {
    if (!editable) return 'failed' as const;
    return dirty ? saving.save() : ('saved' as const);
  };
  const reload = () => (dirty ? setDiscarding(true) : reread());
  const latest = useRef({ save, reload });
  useEffect(() => {
    latest.current = { save, reload };
  });
  useEffect(() => {
    setFileDocument(id, {
      dirty,
      canSave: editable,
      save: () => latest.current.save(),
      // A diff is tied to its file in the repository, so it has no other name to save under.
      saveAs: () => {},
      reload: () => latest.current.reload(),
    });
  }, [id, dirty, editable]);
  useEffect(() => () => setFileDocument(id, null), [id]);

  const toggleServer = () => {
    if (server) setServer(null);
    else if (conflict) void readCurrentText(source, conflict.path, null).then(setServer);
  };
  const comparing = server?.kind === 'text';
  const [left, right] = comparing ? ['서버 내용', '지금 편집본'] : sideLabels(target.compare);
  return (
    <>
      <FileTabBar path={path}>
        <ViewSwitch
          label="diff 보기 방식"
          value={layout}
          options={layouts}
          change={(next) => {
            setLayout(next);
            saveDiffLayout(next);
          }}
        />
      </FileTabBar>
      {(lossy(original) || lossy(modified)) && (
        <p className="file-tab-banner" role="alert">
          UTF-8로 읽을 수 없는 바이트가 있어 일부 글자가 깨져 보일 수 있습니다. 원본을 망가뜨리지
          않도록 이 탭에서는 편집을 막습니다.
        </p>
      )}
      <SaveBanners saving={saving} mixedLineBreaks={editable && mixedLineBreaks} />
      {conflict && (
        <ConflictCard
          key={conflict.path + conflict.hash}
          conflict={conflict}
          busy={saving.saving}
          comparing={comparing}
          overwrite={() => {
            setServer(null);
            void saving.overwrite(conflict);
          }}
          compare={toggleServer}
          cancel={() => {
            setServer(null);
            saving.dismissConflict();
          }}
        />
      )}
      {server?.kind === 'none' && (
        <p className="file-tab-banner" role="alert">
          {server.message}
        </p>
      )}
      <div className="file-diff-labels" data-diff-labels="">
        {layout === 'split' ? (
          <>
            <span>{left}</span>
            <span>{right}</span>
          </>
        ) : (
          <span>
            {left} ↔ {right}
          </span>
        )}
      </div>
      <div className="file-tab-body">
        <DiffEditor
          original={comparing ? server.text : textOf(original)}
          modified={modifiedText}
          language={languageOf(name)}
          layout={layout}
          readOnly={!editable}
          ariaLabel={`${name} 비교`}
          onReady={(handle) => {
            editor.current = handle;
          }}
          onDirtyChange={(next) => {
            setDirty(next);
            if (next) pin();
          }}
          onSave={() => void save()}
        />
      </div>
      {discarding && (
        <ConfirmDialog
          title="저장 안 한 내용을 버립니다"
          action="버리고 다시 읽기"
          cancel={() => setDiscarding(false)}
          confirm={() => {
            setDiscarding(false);
            reread();
          }}
        >
          <p>파일을 다시 읽으면 지금 편집한 내용을 잃습니다.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** A changed file in a tab: what Git holds beside what it is compared with. */
export function GitDiffPane(props: GitDiffPaneProps) {
  const { id, source, target, path, name, live } = props;
  const { state, reload, adopt } = useGitFileDiff(
    source,
    target,
    () => fileDocument(id)?.dirty ?? false,
  );
  const reason = state.status === 'done' ? unshownReason(state.diff) : null;
  // A tab with no editor has nothing to save, but its entry keeps it reachable to reload.
  useEffect(() => {
    if (!reason) return;
    setFileDocument(id, {
      dirty: false,
      canSave: false,
      save: () => Promise.resolve('failed'),
      saveAs: () => {},
      reload,
    });
    return () => setFileDocument(id, null);
  }, [id, reason, reload]);
  return (
    <section className="file-tab" aria-label={`diff ${name}`} data-diff-tab={path}>
      {!live && (
        <p className="file-tab-banner" role="status">
          연결이 끊겨 읽기 전용입니다. 저장하지 못한 내용은 복사해 두세요. 다시 연결한 뒤 diff를
          열면 새로 읽습니다.
        </p>
      )}
      {state.status === 'loading' && (
        <div className="editor-loading" role="status">
          diff를 읽는 중…
        </div>
      )}
      {state.status === 'failed' && (
        <Notice title="diff를 열 수 없습니다">
          <p role="alert">{state.message}</p>
          <button onClick={reload}>다시 시도</button>
        </Notice>
      )}
      {reason === 'binary' && (
        <Notice title="바이너리 파일이라 비교하지 않습니다">
          <p>외부 편집기나 파일 탭으로 내용을 확인하세요.</p>
        </Notice>
      )}
      {reason === 'tooLarge' && (
        <Notice title="크기가 커서 비교하지 않습니다">
          <p>2MiB를 넘는 파일은 diff 탭에서 비교하지 않습니다.</p>
        </Notice>
      )}
      {state.status === 'done' && !reason && (
        <GitDiffDocument
          key={state.generation}
          {...props}
          diff={state.diff}
          reread={reload}
          adopt={adopt}
        />
      )}
    </section>
  );
}
