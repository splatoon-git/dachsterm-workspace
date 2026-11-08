import { useEffect, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { formatBytes } from '../../lib/formatBytes';
import type { Source } from '../../lib/source';
import { useFileRead } from './fileRead';
import { setFileDocument } from './fileDocuments';
import { FileTabBar, TextDocument } from './TextDocument';
import './fileTab.css';

export type FilePaneProps = {
  id: string;
  source: Source;
  path: string;
  name: string;
  /** False once the connection the file came from has ended. */
  live: boolean;
  pin: () => void;
  /** A save under another name: the tab now shows that file. */
  renamed: (path: string) => void;
};

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="file-tab-notice">
      <Icon name="file" size={32} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** A file shown in a tab: the first bytes decide the view, not the name alone. */
export function FilePane({ id, source, path, name, live, pin, renamed }: FilePaneProps) {
  const { state, openLarge, chooseEncoding, chosenEncoding, reload, adopt } = useFileRead(
    source,
    path,
  );
  const file = state.status === 'done' ? state.file : null;
  const size = file ? formatBytes(file.size) : '';
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
      {file?.kind === 'image' && (
        <>
          <FileTabBar path={path} />
          <div className="file-tab-image">
            {/* Only ever an <img>: an SVG cannot run scripts or fetch anything this way. */}
            <img src={`data:${file.mime};base64,${file.data}`} alt={name} />
          </div>
        </>
      )}
      {file?.kind === 'binary' && (
        <Notice title="바이너리 파일이라 열지 않았습니다">
          <p>
            {file.format} · {size}
          </p>
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
        </Notice>
      )}
    </section>
  );
}
