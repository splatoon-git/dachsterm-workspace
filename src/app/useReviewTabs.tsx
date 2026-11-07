import { useState } from 'react';
import { ReviewPane } from '../features/git/ReviewPane';
import type { Delivery } from '../features/git/review';
import { inputReach } from '../features/terminal/broadcastStatus';
import type { TerminalSession } from '../features/terminal/session';
import { sessionKind } from '../features/terminal/sessionKind';
import { PlainTab } from './GroupTabBar';
import type { Workspace } from './useWorkspaceLayout';
import { groupOfTab, tabKey, type TabRef } from './workspaceLayout';

/** The terminal a review was opened from. Its comments go there and nowhere else. */
type Review = { id: string; tabId: string; connectionId: string; name: string; folder: string };
type ReviewRef = Extract<TabRef, { kind: 'review' }>;

const refOf = (review: Review): ReviewRef => ({ kind: 'review', id: review.id });
const sessionKey = (tabId: string) => tabKey({ kind: 'session', tabId });

/**
 * Whether the tab can open a review: null for tabs without one (not SSH), false while it cannot
 * yet (not connected, or the shell's folder is unknown).
 */
export function reviewable(session: TerminalSession | undefined) {
  if (!session || sessionKind(session) !== 'ssh') return null;
  const { status, directory } = session.snapshot();
  return status === 'connected' && !!directory;
}

/**
 * Change review tabs (DX.6), and the link from a review to its terminal's prompt. The review
 * itself knows nothing of terminals; this is where the two features meet.
 */
export function useReviewTabs({
  workspace,
  sessions,
  narrow,
}: {
  workspace: Workspace;
  sessions: TerminalSession[];
  narrow: boolean;
}) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const open = (session: TerminalSession) => {
    if (!reviewable(session)) return;
    const folder = session.snapshot().directory!;
    const existing = reviews.find(
      (r) =>
        r.tabId === session.tabId && r.connectionId === session.connectionId && r.folder === folder,
    );
    if (existing) return workspace.open(refOf(existing));
    const review: Review = {
      id: crypto.randomUUID(),
      tabId: session.tabId,
      connectionId: session.connectionId,
      name: session.profile.name,
      folder,
    };
    setReviews((old) => [...old, review]);
    // Beside its terminal, so the comments and the prompt they fill are in view together.
    const group = groupOfTab(workspace.layout.root, sessionKey(session.tabId));
    workspace.open(
      refOf(review),
      group && !narrow ? { groupId: group.id, side: 'right' } : undefined,
    );
  };
  /** Pastes without Enter, and only into the same live connection the review was opened for. */
  const deliver = (review: Review, format: (multiline: boolean) => string): Delivery => {
    const session = sessions.find((t) => t.tabId === review.tabId);
    if (!session) return 'closed';
    if (session.connectionId !== review.connectionId) return 'changed';
    if (session.snapshot().status !== 'connected') return 'disconnected';
    if (inputReach(session.connectionId) > 1) return 'shared';
    // Without bracketed paste a line break would run the line, so the text stays on one line.
    session.terminal.paste(format(session.terminal.modes.bracketedPasteMode));
    const key = sessionKey(session.tabId);
    const group = groupOfTab(workspace.layout.root, key);
    if (group) workspace.select(group.id, key);
    requestAnimationFrame(() => session.terminal.focus());
    return 'sent';
  };
  const find = (tab: ReviewRef) => reviews.find((r) => r.id === tab.id);
  /** Closes a review tab and forgets its list. False for a key that is not a review. */
  const close = (key: string) => {
    const review = reviews.find((r) => tabKey(refOf(r)) === key);
    if (!review) return false;
    setReviews((old) => old.filter((r) => r !== review));
    workspace.close(key);
    return true;
  };
  return {
    order: reviews.map(refOf),
    open,
    close,
    renderTab: (tab: ReviewRef, active: boolean, select: () => void) => {
      const review = find(tab);
      return (
        review && (
          <PlainTab
            tabKey={tabKey(tab)}
            title={`변경 검토 · ${review.name}`}
            active={active}
            select={select}
            close={() => close(tabKey(tab))}
          />
        )
      );
    },
    renderCell: (tab: ReviewRef) => {
      const review = find(tab);
      return (
        review && (
          <ReviewPane
            connectionId={review.connectionId}
            folder={review.folder}
            target={review.name}
            send={(format) => deliver(review, format)}
          />
        )
      );
    },
  };
}
