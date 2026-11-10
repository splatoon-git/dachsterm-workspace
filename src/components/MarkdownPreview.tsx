import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { call, errorText } from '../lib/ipc';
import { renderMarkdown } from '../lib/markdown';
import { Dialog } from './Dialog';
import './markdown.css';

const externalOf = (target: EventTarget) =>
  (target as Element).closest?.('[data-external]')?.getAttribute('data-external') ?? null;

/**
 * Rendered Markdown: a Markdown file's preview, and an agent's replies in a chat. Links open in the
 * browser only after the user agrees. `className` places it: the file tab's fills its tab.
 */
export default function MarkdownPreview({
  text,
  className = 'markdown-preview',
}: {
  text: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    host.current?.replaceChildren(renderMarkdown(text));
  }, [text]);
  const ask = (event: MouseEvent | KeyboardEvent) => {
    const url = externalOf(event.target);
    if (!url) return;
    event.preventDefault();
    setError('');
    setAsking(url);
  };
  async function open(url: string) {
    try {
      await call('url_open', { url });
      setAsking(null);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <>
      <div
        ref={host}
        className={`markdown ${className}`}
        onClick={ask}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') ask(e);
        }}
      />
      {asking !== null && (
        <Dialog title="브라우저로 열까요?" size="small" close={() => setAsking(null)}>
          <p className="markdown-open-url">{asking}</p>
          {error && <p role="alert">{error}</p>}
          <div className="form-actions">
            <button autoFocus onClick={() => setAsking(null)}>
              취소
            </button>
            <button className="primary" onClick={() => void open(asking)}>
              열기
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
