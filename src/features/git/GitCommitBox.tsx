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
  const tip = busy
    ? 'Git 명령을 실행하는 중입니다'
    : !stagedCount
      ? '스테이지된 변경이 없습니다'
      : !draft.trim()
        ? '커밋 메시지를 입력하세요'
        : `스테이지한 파일 ${stagedCount.toLocaleString()}개 커밋 (${modKey('Enter')})`;
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
        {/* On the wrapper: a disabled button gets no pointer events, and that is when it matters. */}
        <span className="git-commit-tip" data-tip={tip}>
          <button
            type="button"
            className="primary git-commit-button"
            disabled={!ready}
            onClick={commit}
          >
            <Icon name="check" size={14} />
            커밋
          </button>
        </span>
        <button
          type="button"
          className="git-commit-more"
          aria-label="커밋 더 보기"
          data-tip="커밋 옵션: 이전 커밋 고치기(--amend)"
          disabled={busy}
          onClick={(event) => more(event.currentTarget)}
        >
          <Icon name="chevron" size={12} />
        </button>
      </div>
    </div>
  );
}
