import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { call, errorText } from '../../lib/ipc';
import { isMac } from '../../lib/platform';
import './editorPicker.css';

/** A known editor found on this computer, as `editor_list` reports it. */
export type InstalledEditor = { id: string; name: string; path: string };

/** The last two parts of a path, enough to tell installs apart without a wide column. */
const shortPath = (path: string) => path.split(/[\\/]/).slice(-2).join('/');
const isPath = (program: string) => /[\\/]/.test(program);

/**
 * Chooses the external editor: the known editors installed here as cards, a program the user
 * picked before, and a file dialog for any other program. The value is an editor id from the
 * list or a program path, which the backend resolves the same way when it launches.
 */
export function EditorPicker({
  value,
  change,
  fail,
}: {
  value: string;
  change: (program: string) => void;
  fail: (message: string) => void;
}) {
  const [installed, setInstalled] = useState<InstalledEditor[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    call<InstalledEditor[]>('editor_list')
      .then((list) => {
        if (!current) return;
        setInstalled(list);
        // A remembered id that is not installed here (the first default is code) falls back to
        // the first editor found. A program path the user chose is kept.
        if (list.length && !isPath(value) && !list.some((e) => e.id === value)) change(list[0].id);
      })
      .catch((e) => {
        if (!current) return;
        setInstalled([]);
        setError(errorText(e));
      });
    return () => {
      current = false;
    };
    // Only the first value matters for the fallback; later choices come from this picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const custom = !!value && !!installed && !installed.some((e) => e.id === value);
  const browse = () =>
    void call<string | null>('editor_pick')
      .then((path) => {
        if (path) change(path);
      })
      .catch((e) => fail(errorText(e)));
  return (
    <fieldset className="editor-picker">
      <legend>편집기</legend>
      {!installed && <p className="editor-note">설치된 편집기를 찾는 중…</p>}
      <div className="editor-options" role="radiogroup" aria-label="편집기">
        {installed?.map((editor) => (
          <label key={editor.id} className="editor-option" title={editor.path}>
            <input
              type="radio"
              name="editor"
              checked={value === editor.id}
              onChange={() => change(editor.id)}
            />
            <span className="editor-mark" aria-hidden="true">
              {editor.name[0]}
            </span>
            <span className="editor-text">
              <strong>{editor.name}</strong>
              <small>{shortPath(editor.path)}</small>
            </span>
          </label>
        ))}
        {custom && (
          <label className="editor-option" title={value}>
            <input type="radio" name="editor" checked onChange={() => {}} />
            <span className="editor-mark" aria-hidden="true">
              <Icon name="file" size={14} />
            </span>
            <span className="editor-text">
              <strong>직접 고른 프로그램</strong>
              <small>{shortPath(value)}</small>
            </span>
          </label>
        )}
        <button type="button" className="editor-option editor-browse" onClick={browse}>
          <span className="editor-mark" aria-hidden="true">
            <Icon name="folder" size={14} />
          </span>
          <span className="editor-text">
            <strong>다른 프로그램…</strong>
            <small>실행 파일 선택</small>
          </span>
        </button>
      </div>
      <details className="editor-typed">
        <summary>경로 직접 입력</summary>
        <input
          aria-label="프로그램 경로"
          spellCheck={false}
          placeholder={isMac ? '/Applications/…' : 'C:\\Program Files\\…\\editor.exe'}
          value={value}
          onChange={(e) => change(e.target.value)}
        />
      </details>
      {installed?.length === 0 && (
        <p className="editor-note">
          {error || '알려진 편집기를 찾지 못했습니다.'} 다른 프로그램…으로 실행 파일을 고르세요.
        </p>
      )}
    </fieldset>
  );
}
