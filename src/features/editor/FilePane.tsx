import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { formatBytes } from '../../lib/formatBytes';
import type { Source } from '../../lib/source';
import { CodeEditor } from './CodeEditor';
import { isJson, isMarkdown, languageOf } from './fileKinds';
import { useFileRead, type FileRead } from './fileRead';
import { setFileStatus } from './fileStatus';
import { prettyJson, textFacts } from './fileText';
import './fileTab.css';

const MarkdownPreview = lazy(() => import('./MarkdownPreview'));

type TextFile = Extract<FileRead, { kind: 'text' }>;
export type FilePaneProps = {
  id: string;
  source: Source;
  path: string;
  name: string;
  /** False once the connection the file came from has ended. */
  live: boolean;
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

function ViewSwitch<T extends string>({
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

function TextView({ file, name, path }: { file: TextFile; name: string; path: string }) {
  const markdown = isMarkdown(name) && !file.large;
  const json = isJson(name) && !file.large;
  const [view, setView] = useState<'source' | 'rendered'>(markdown ? 'rendered' : 'source');
  const pretty = useMemo(
    () => (json && view === 'rendered' ? prettyJson(file.text) : null),
    [json, view, file.text],
  );
  const untidy = json && view === 'rendered' && pretty === null;
  const language = file.large ? 'plaintext' : languageOf(name);
  return (
    <>
      <FileTabBar path={path}>
        {markdown && (
          <ViewSwitch label="보기 방식" value={view} options={markdownViews} change={setView} />
        )}
        {json && <ViewSwitch label="보기 방식" value={view} options={jsonViews} change={setView} />}
      </FileTabBar>
      {file.lossy && (
        <p className="file-tab-banner" role="alert">
          이 인코딩으로 읽을 수 없는 바이트가 있어 일부 글자가 깨져 보입니다. 원본을 망가뜨리지
          않도록 편집을 막습니다. 상태바에서 인코딩을 바꿔 보세요.
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
      <div className="file-tab-body">
        {markdown && view === 'rendered' ? (
          <Suspense fallback={<p className="editor-loading">미리보기 준비 중…</p>}>
            <MarkdownPreview text={file.text} />
          </Suspense>
        ) : (
          <CodeEditor
            value={pretty ?? file.text}
            language={language}
            readOnly
            ariaLabel={`${name} 내용`}
          />
        )}
      </div>
    </>
  );
}

function FileTabBar({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <div className="file-tab-bar">
      <span className="file-tab-path" title={path}>
        {path}
      </span>
      {children}
    </div>
  );
}

/** A file shown in a tab: the first bytes decide the view, not the name alone. */
export function FilePane({ id, source, path, name, live }: FilePaneProps) {
  const { state, openLarge, chooseEncoding, reload } = useFileRead(source, path);
  const file = state.status === 'done' ? state.file : null;
  const text = file?.kind === 'text' ? file : null;
  const facts = useMemo(() => (text ? textFacts(text.text) : null), [text]);
  useEffect(() => {
    if (!text || !facts) return;
    setFileStatus(id, {
      ...facts,
      encoding: text.encoding,
      language: text.large ? 'plaintext' : languageOf(name),
      chooseEncoding,
    });
    return () => setFileStatus(id, null);
  }, [id, name, text, facts, chooseEncoding]);
  const size = file ? formatBytes(file.size) : '';
  return (
    <section className="file-tab" aria-label={`파일 ${name}`} data-file-tab={path}>
      {!live && (
        <p className="file-tab-banner" role="status">
          연결이 끊겨 읽기 전용입니다. 다시 연결한 뒤 파일을 열면 새로 읽습니다.
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
      {text && <TextView key={text.hash} file={text} name={name} path={path} />}
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
