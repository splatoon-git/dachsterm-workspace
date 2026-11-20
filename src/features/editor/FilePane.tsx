import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { openByDefault, opensByDefault } from '../../lib/externalEdit';
import { formatBytes } from '../../lib/formatBytes';
import { errorText } from '../../lib/ipc';
import type { Source } from '../../lib/source';
import { DocumentPreview } from './DocumentPreview';
import { documentFormats, isDocumentFormat } from './documentFormats';
import { useFileRead, type FileRead } from './fileRead';
import { setFileDocument } from './fileDocuments';
import { ImageView } from './preview/ImageView';
import { TextDocument } from './TextDocument';
import './fileTab.css';

export type FilePaneProps = {
  id: string;
  source: Source;
  path: string;
  name: string;
  /** False once the connection the file came from has ended. */
  live: boolean;
  /** The saved session a server file belongs to. Fetching it for another program needs this. */
  profileId?: string;
  pin: () => void;
  /** A save under another name: the tab now shows that file. */
  renamed: (path: string) => void;
};

export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="file-tab-notice">
      <Icon name="file" size={32} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

type Shown = Extract<FileRead, { kind: 'image' | 'document' }>;

/** A picture or a document drawn in the tab. One that cannot be drawn says why instead. */
function Preview({
  file,
  path,
  name,
  open,
}: {
  file: Shown;
  path: string;
  name: string;
  /** Hands the file to this computer's program for it, where that is possible. */
  open: (() => void) | null;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const unknown = file.kind === 'document' && !isDocumentFormat(file.format);
  if (failure !== null || unknown)
    return (
      <Notice title="미리 볼 수 없습니다">
        {file.kind === 'document' && isDocumentFormat(file.format) && (
          <p>{documentFormats[file.format]}</p>
        )}
        <p role="alert">{failure ?? '이 문서 형식은 미리보기를 지원하지 않습니다.'}</p>
        {open && <button onClick={open}>기본 프로그램으로 열기</button>}
      </Notice>
    );
  const actions = open && (
    <button type="button" className="preview-open" onClick={open}>
      기본 프로그램으로 열기
    </button>
  );
  if (file.kind === 'image')
    return (
      <ImageView
        source={`data:${file.mime};base64,${file.data}`}
        name={name}
        path={path}
        actions={actions}
        fail={setFailure}
      />
    );
  return (
    isDocumentFormat(file.format) && (
      <DocumentPreview
        format={file.format}
        data={file.data}
        path={path}
        name={name}
        actions={actions}
        fail={setFailure}
      />
    )
  );
}

type Opening = { text: string; failed: boolean } | null;

/** A file shown in a tab: the first bytes decide the view, not the name alone. */
export function FilePane({ id, source, path, name, live, profileId, pin, renamed }: FilePaneProps) {
  const { state, openLarge, chooseEncoding, chosenEncoding, reload, adopt } = useFileRead(
    source,
    path,
  );
  const file = state.status === 'done' ? state.file : null;
  const size = file ? formatBytes(file.size) : '';
  const [opening, setOpening] = useState<Opening>(null);
  const reachable = source.kind === 'local' || (live && !!profileId);
  const open =
    opensByDefault(source) && reachable
      ? () => {
          setOpening(null);
          openByDefault(source, profileId, path).then(
            () =>
              // A program of this computer shows itself. A server file is a copy until it is saved.
              source.kind === 'ssh' &&
              setOpening({
                text: '서버 파일을 가져와 기본 프로그램으로 열었습니다. 거기서 저장하면 업로드 여부를 묻습니다.',
                failed: false,
              }),
            (e: unknown) => setOpening({ text: errorText(e), failed: true }),
          );
        }
      : null;
  // A tab that shows no text has nothing to save, but its entry keeps it reachable to reload.
  const textGeneration = state.status === 'done' && file?.kind === 'text' ? state.generation : null;
  useEffect(() => {
    if (textGeneration !== null || file === null) return;
    setFileDocument(id, {
      dirty: false,
      canSave: false,
      save: () => Promise.resolve('failed'),
      saveAs: () => {},
      reload,
    });
    return () => setFileDocument(id, null);
  }, [id, file, textGeneration, reload]);
  return (
    <section className="file-tab" aria-label={`파일 ${name}`} data-file-tab={path}>
      {!live && (
        <p className="file-tab-banner" role="status">
          연결이 끊겨 읽기 전용입니다. 저장하지 못한 내용은 복사해 두세요. 다시 연결한 뒤 파일을
          열면 새로 읽습니다.
        </p>
      )}
      {opening && (
        <p className="file-tab-banner" role={opening.failed ? 'alert' : 'status'}>
          {opening.text}
        </p>
      )}
      {state.status === 'loading' && (
        <div className="editor-loading" role="status">
          파일을 읽는 중…
        </div>
      )}
      {state.status === 'failed' && (
        <Notice title="파일을 열 수 없습니다">
          <p role="alert">{state.message}</p>
          <button onClick={reload}>다시 시도</button>
        </Notice>
      )}
      {file?.kind === 'text' && textGeneration !== null && (
        <TextDocument
          key={textGeneration}
          id={id}
          file={file}
          source={source}
          path={path}
          name={name}
          live={live}
          chosenEncoding={chosenEncoding}
          chooseEncoding={chooseEncoding}
          reread={reload}
          pin={pin}
          moved={(target) => {
            adopt(target);
            renamed(target);
          }}
        />
      )}
      {state.status === 'done' && (file?.kind === 'image' || file?.kind === 'document') && (
        <Preview key={state.generation} file={file} path={path} name={name} open={open} />
      )}
      {file?.kind === 'binary' && (
        <Notice title="바이너리 파일이라 열지 않았습니다">
          <p>
            {file.format} · {size}
          </p>
          {open && <button onClick={open}>기본 프로그램으로 열기</button>}
        </Notice>
      )}
      {file?.kind === 'large' && (
        <Notice title="크기가 커서 바로 열지 않았습니다">
          <p>{size} · 2MiB를 넘는 파일은 읽기 전용으로 구문 강조 없이 엽니다.</p>
          <button className="primary" onClick={openLarge}>
            크게 열기
          </button>
        </Notice>
      )}
      {file?.kind === 'tooLarge' && (
        <Notice title="이 파일은 탭에서 열 수 없습니다">
          <p>{size} · 탭에서는 32MiB까지 열 수 있습니다. 외부 편집기나 다운로드를 쓰세요.</p>
          {/* A server file goes through the same 32MiB fetch, so only a local one can be handed on. */}
          {source.kind === 'local' && open && (
            <button onClick={open}>기본 프로그램으로 열기</button>
          )}
        </Notice>
      )}
    </section>
  );
}
