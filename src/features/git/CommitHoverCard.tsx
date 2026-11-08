import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/Icon';
import { commitMessage, fileTotals, placeCard, relativeTime } from './commitCard';
import { CommitRefPill } from './CommitGraphParts';
import type { GraphCommit } from './commitGraphModel';
import type { DetailState } from './useCommitGraph';

const copiedFor = 1200;

/** What a commit row shows on hover: the card a tree row has no room for. */
export function CommitHoverCard({
  commit,
  rect,
  state,
  copy,
  keep,
  hide,
  close,
}: {
  commit: GraphCommit;
  rect: DOMRect;
  /** The row already knows the subject, so the card opens before the rest arrives. */
  state: DetailState | undefined;
  copy: (text: string) => void;
  keep: () => void;
  hide: () => void;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const detail = state?.kind === 'ready' ? state.detail : null;
  useLayoutEffect(() => {
    const card = ref.current!;
    const place = placeCard(
      rect,
      { width: card.offsetWidth, height: card.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    card.style.left = `${place.x}px`;
    card.style.top = `${place.y}px`;
  }, [rect, detail]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), copiedFor);
    return () => clearTimeout(timer);
  }, [copied]);
  const { body, coAuthors } = commitMessage(detail?.message ?? commit.subject);
  const totals = detail && detail.files.length > 0 ? fileTotals(detail.files) : null;
  const when = new Date(commit.time * 1000).toLocaleString();
  return createPortal(
    <div
      ref={ref}
      className="git-commit-card"
      role="group"
      aria-label="커밋 정보"
      onPointerEnter={keep}
      onPointerLeave={hide}
    >
      <p className="git-commit-card-who">
        <strong>{commit.author}</strong>
        <span>
          {relativeTime(commit.time)} ({when})
        </span>
      </p>
      {coAuthors.map((name) => (
        <p key={name} className="git-commit-card-co">
          {name} <span>공동 작성자</span>
        </p>
      ))}
      <p className="git-commit-card-message">{body}</p>
      {totals && (
        <p className="git-commit-card-stat">
          파일 {totals.files.toLocaleString()}개 변경
          <span data-change="added"> +{totals.added.toLocaleString()}</span>
          <span data-change="deleted"> −{totals.removed.toLocaleString()}</span>
          {detail?.truncated && ' (일부)'}
        </p>
      )}
      {commit.refs.length > 0 && (
        <div className="git-commit-card-refs">
          {commit.refs.map((item) => (
            <CommitRefPill key={`${item.kind}:${item.name}`} item={item} named />
          ))}
        </div>
      )}
      <div className="git-commit-card-foot">
        <code>{commit.hash.slice(0, 7)}</code>
        <button
          type="button"
          className="git-view-tool"
          aria-label="해시 복사"
          data-tip={copied ? '복사했습니다' : `전체 해시 복사\n${commit.hash}`}
          onClick={() => {
            copy(commit.hash);
            setCopied(true);
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
