import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Source } from '../../lib/source';
import { CodeEditor, DiffEditor } from './CodeEditor';
import { ConflictCard } from './ConflictCard';
import type { EditorHandle, Indent, LineBreak } from './editorTypes';
import { ConfirmDialog, SaveAsDialog } from './FileDialogs';
import { setFileDocument } from './fileDocuments';
import { isJson, isMarkdown, languageOf } from './fileKinds';
import type { FileRead } from './fileRead';
import { readCurrentText, useFileSave, type ServerText } from './fileSave';
import { SaveBanners } from './SaveBanners';
import { setFileStatus } from './fileStatus';
import { prettyJson, textFacts } from './fileText';

const MarkdownPreview = lazy(() => import('./MarkdownPreview'));

export type TextFile = Extract<FileRead, { kind: 'text' }>;

export function ViewSwitch<T extends string>({
  label,
  value,
  options,
  change,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  change: (value: T) => void;
}) {
  return (
    <div className="file-tab-switch" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={option} aria-pressed={value === option} onClick={() => change(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}

const markdownViews = [
  ['rendered', '미리보기'],
  ['source', '원문'],
] as const;
const jsonViews = [
  ['source', '원문'],
  ['rendered', '정리해서 보기'],
] as const;

export function FileTabBar({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <div className="file-tab-bar">
      <span className="file-tab-path" title={path}>
        {path}
      </span>
      {children}
    </div>
  );
}

type Discarding = { run: () => void };

/** One read of a text file: its views, its unsaved edits and saving them. */
export function TextDocument({
  id,
  file,
  source,
  path,
  name,
  live,
  chosenEncoding,
  chooseEncoding,
  reread,
  pin,
  moved,
}: {
  id: string;
  file: TextFile;
  source: Source;
  path: string;
  name: string;
  live: boolean;
  chosenEncoding: string | null;
  chooseEncoding: (encoding: string) => void;
  reread: () => void;
  /** The first edit keeps the tab, as a preview would be replaced by the next file opened. */
  pin: () => void;
  moved: (path: string) => void;
}) {
  const markdown = isMarkdown(name) && !file.large;
  const json = isJson(name) && !file.large;
  const [view, setView] = useState<'source' | 'rendered'>(markdown ? 'rendered' : 'source');
  // The editor mounts on first use and then stays, hidden, so the rendered view keeps its undo.
  const [sourceOpened, setSourceOpened] = useState(!markdown);
  const [renderedText, setRenderedText] = useState(file.text);
  const editor = useRef<EditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [facts, setFacts] = useState(() => textFacts(file.text));
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [discarding, setDiscarding] = useState<Discarding | null>(null);
  const [comparison, setComparison] = useState<{ server: ServerText; mine: string } | null>(null);
  const editable = live && !file.lossy && !file.large;
  const saving = useFileSave({
    source,
    path,
    encoding: file.encoding,
    hash: file.hash,
    editor,
    moved,
  });
  const { conflict } = saving;

  const pretty = useMemo(
    () => (json && view === 'rendered' ? prettyJson(renderedText) : null),
    [json, view, renderedText],
  );
  const untidy = json && view === 'rendered' && pretty === null;
  const language = file.large ? 'plaintext' : languageOf(name);
  const showRendered = view === 'rendered' && !untidy;

  const save = async () => {
    if (!editable) return 'failed' as const;
    if (!dirty) return 'saved' as const;
    const outcome = await saving.save();
    if (outcome === 'saved' && editor.current) setFacts(textFacts(editor.current.getValue()));
    return outcome;
  };
  const latest = useRef({ save, reload: () => {} });
  const guardDiscard = (run: () => void) => {
    if (dirty) setDiscarding({ run });
    else run();
  };
  const reload = () => guardDiscard(reread);
  useEffect(() => {
    latest.current = { save, reload };
  });
  useEffect(() => {
    setFileDocument(id, {
      dirty,
      canSave: editable,
      save: () => latest.current.save(),
      saveAs: () => {
        if (editable) setSaveAsOpen(true);
      },
      reload: () => latest.current.reload(),
    });
  }, [id, dirty, editable]);
  useEffect(() => () => setFileDocument(id, null), [id]);

  const editing = editable && ready;
  useEffect(() => {
    const refreshFacts = () => {
      if (editor.current) setFacts(textFacts(editor.current.getValue()));
    };
    setFileStatus(id, {
      ...facts,
      encoding: file.encoding,
      language,
      chooseEncoding: (encoding) => {
        if (dirty) setDiscarding({ run: () => chooseEncoding(encoding) });
        else chooseEncoding(encoding);
      },
      setLineBreak: editing
        ? (lineBreak: LineBreak) => {
            editor.current?.setLineBreak(lineBreak);
            refreshFacts();
          }
        : undefined,
      setIndent: editing
        ? (indent: Indent) => {
            void editor.current?.setIndent(indent).then(refreshFacts);
          }
        : undefined,
    });
    return () => setFileStatus(id, null);
  }, [id, file.encoding, language, facts, chooseEncoding, editing, dirty]);

  const changeView = (next: 'source' | 'rendered') => {
    if (next === 'source') setSourceOpened(true);
    else setRenderedText(editor.current?.getValue() ?? renderedText);
    setView(next);
  };
  const toggleComparison = () => {
    if (comparison) {
      setComparison(null);
      return;
    }
    if (!conflict) return;
    const mine = editor.current?.getValue() ?? file.text;
    void readCurrentText(source, conflict.path, chosenEncoding).then((server) =>
      setComparison({ server, mine }),
    );
  };
  return (
    <>
      <FileTabBar path={path}>
        {markdown && (
          <ViewSwitch label="보기 방식" value={view} options={markdownViews} change={changeView} />
        )}
        {json && (
          <ViewSwitch label="보기 방식" value={view} options={jsonViews} change={changeView} />
        )}
      </FileTabBar>
      {file.lossy && (
        <p className="file-tab-banner" role="alert">
          이 인코딩으로 그대로 저장할 수 없는 바이트가 있어 일부 글자가 깨져 보일 수 있습니다.
          원본을 망가뜨리지 않도록 편집을 막습니다. 상태바에서 인코딩을 바꿔 보세요.
        </p>
      )}
      {file.large && (
        <p className="file-tab-banner" role="status">
          큰 파일이라 읽기 전용으로 열고 구문 강조를 껐습니다.
        </p>
      )}
      {untidy && (
        <p className="file-tab-banner" role="status">
          JSON 형식이 아니어서 정리할 수 없습니다. 원문을 표시합니다.
        </p>
      )}
      <SaveBanners saving={saving} mixedLineBreaks={editable && facts.eol === '혼합'} />
      {conflict && (
        <ConflictCard
          key={conflict.path + conflict.hash}
          conflict={conflict}
          busy={saving.saving}
          comparing={comparison !== null}
          overwrite={() => {
            setComparison(null);
            void saving.overwrite(conflict);
          }}
          compare={toggleComparison}
          cancel={() => {
            setComparison(null);
            saving.dismissConflict();
          }}
        />
      )}
      {comparison?.server.kind === 'none' && (
        <p className="file-tab-banner" role="alert">
          {comparison.server.message}
        </p>
      )}
      {comparison?.server.kind === 'text' ? (
        <>
          <div className="file-diff-labels">
            <span>서버 내용</span>
            <span>지금 편집본</span>
          </div>
          <div className="file-tab-body">
            <DiffEditor
              original={comparison.server.text}
              modified={comparison.mine}
              language={language}
              layout="split"
              readOnly
              ariaLabel={`${name} 서버 내용과 비교`}
            />
          </div>
        </>
      ) : (
        showRendered && (
          <div className="file-tab-body">
            {markdown ? (
              <Suspense fallback={<p className="editor-loading">미리보기 준비 중…</p>}>
                <MarkdownPreview text={renderedText} />
              </Suspense>
            ) : (
              <CodeEditor
                value={pretty ?? renderedText}
                language={language}
                readOnly
                ariaLabel={`${name} 정리해서 보기`}
              />
            )}
          </div>
        )
      )}
      {sourceOpened && (
        <div className="file-tab-body" hidden={showRendered || comparison?.server.kind === 'text'}>
          <CodeEditor
            value={file.text}
            language={language}
            readOnly={!editable}
            ariaLabel={`${name} 내용`}
            onReady={(handle) => {
              editor.current = handle;
              setReady(true);
            }}
            onDirtyChange={(next) => {
              setDirty(next);
              if (next) pin();
            }}
            onSave={() => void save()}
          />
        </div>
      )}
      {saveAsOpen && (
        <SaveAsDialog
          path={path}
          close={() => setSaveAsOpen(false)}
          submit={(target) => {
            setSaveAsOpen(false);
            void saving.saveAs(target).then((outcome) => {
              if (outcome === 'saved' && editor.current) {
                setFacts(textFacts(editor.current.getValue()));
              }
            });
          }}
        />
      )}
      {discarding && (
        <ConfirmDialog
          title="저장 안 한 내용을 버립니다"
          action="버리고 다시 읽기"
          cancel={() => setDiscarding(null)}
          confirm={() => {
            setDiscarding(null);
            discarding.run();
          }}
        >
          <p>파일을 다시 읽으면 지금 편집한 내용을 잃습니다.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
