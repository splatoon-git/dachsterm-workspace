import { Icon } from '../../components/Icon';
import { modKey } from '../../lib/platform';

/** The message and the commit button, the two write controls that are always shown. */
export function GitCommitBox({
  draft,
  setDraft,
  stagedCount,
  busy,
  commit,
  more,
}: {
  draft: string;
  setDraft: (draft: string) => void;
  stagedCount: number;
  busy: boolean;
  commit: () => void;
  more: (anchor: HTMLElement) => void;
}) {
  const ready = !busy && stagedCount > 0 && !!draft.trim();
  const title = stagedCount ? undefined : '스테이지된 변경이 없습니다';
  return (
    <div className="git-commit">
      <textarea
        aria-label="커밋 메시지"
        placeholder={`메시지 · ${modKey('Enter')}`}
        rows={2}
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          if (ready) commit();
        }}
      />
      <div className="git-commit-actions">
        <button
          type="button"
          className="primary git-commit-button"
          disabled={!ready}
          title={title}
          onClick={commit}
        >
          <Icon name="check" size={14} />
          커밋
        </button>
        <button
          type="button"
          className="git-commit-more"
          aria-label="커밋 더 보기"
          title="커밋 더 보기"
          disabled={busy}
          onClick={(event) => more(event.currentTarget)}
        >
          <Icon name="chevron" size={12} />
        </button>
      </div>
    </div>
  );
}
