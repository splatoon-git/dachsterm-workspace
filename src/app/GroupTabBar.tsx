import {
  Fragment,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { tabKey, type GroupNode, type TabRef } from './workspaceLayout';

/** A tab with a title and an optional close button, for anything that is not a live session. */
export function PlainTab({
  tabKey: key,
  title,
  active,
  select,
  close,
  id,
  controls,
}: {
  tabKey?: string;
  title: string;
  active: boolean;
  select: () => void;
  close?: () => void;
  id?: string;
  controls?: string;
}) {
  return (
    <div className={`session-tab ${active ? 'selected' : ''}`} data-tab-key={key}>
      <button role="tab" id={id} aria-controls={controls} aria-selected={active} onClick={select}>
        {title}
      </button>
      {close && (
        <button aria-label={`${title} 탭 닫기`} onClick={close}>
          ×
        </button>
      )}
    </div>
  );
}

export function GroupTabBar({
  group,
  focused,
  style,
  renderTab,
  start,
  focusGroup,
  toggleZoom,
  nextGroup,
  onTabPointerDown,
}: {
  group: GroupNode;
  focused: boolean;
  style: CSSProperties;
  renderTab: (tab: TabRef, group: GroupNode) => ReactNode;
  /** The start page's own tab, while nothing else is open. */
  start?: ReactNode;
  focusGroup: () => void;
  toggleZoom: () => void;
  /** Present in a narrow window, where the other groups are off screen. */
  nextGroup?: () => void;
  onTabPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [group.active]);
  return (
    <div
      className={`tab-strip ${focused ? 'focused-group' : ''}`}
      ref={strip}
      role="tablist"
      aria-label="터미널 탭"
      data-group-id={group.id}
      data-focused-group={focused}
      style={style}
      onPointerDown={(e) => {
        focusGroup();
        onTabPointerDown?.(e);
      }}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) toggleZoom();
      }}
      onKeyDown={(e) => {
        if (
          !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) ||
          (e.target as HTMLElement).getAttribute('role') !== 'tab'
        )
          return;
        const buttons = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
        );
        const index = buttons.indexOf(e.target as HTMLButtonElement);
        const next =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buttons.length - 1
              : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        e.preventDefault();
        buttons[next]?.click();
        buttons[next]?.focus();
      }}
    >
      {start}
      {group.tabs.map((tab) => (
        <Fragment key={tabKey(tab)}>{renderTab(tab, group)}</Fragment>
      ))}
      {nextGroup && (
        <button className="next-group" aria-label="다음 칸" onClick={nextGroup}>
          ⇥
        </button>
      )}
    </div>
  );
}
