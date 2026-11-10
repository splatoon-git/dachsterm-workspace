import {
  Fragment,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { anchorBelow, isMenuKey, type MenuPoint } from '../components/ContextMenu';
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
  hint,
  italic,
  dirty,
  badge,
  onDoubleClick,
}: {
  tabKey?: string;
  title: string;
  /** A state shown after the title, such as a chat waiting for an answer. */
  badge?: ReactNode;
  /** The tooltip, when the title alone is ambiguous. */
  hint?: string;
  /** A preview: the next file opened replaces it. */
  italic?: boolean;
  /** Has changes that are not saved. */
  dirty?: boolean;
  onDoubleClick?: () => void;
  active: boolean;
  select: () => void;
  close?: () => void;
  id?: string;
  controls?: string;
}) {
  return (
    <div
      className={`session-tab ${active ? 'selected' : ''} ${italic ? 'preview-tab' : ''}`}
      data-tab-key={key}
    >
      <button
        role="tab"
        id={id}
        aria-controls={controls}
        aria-selected={active}
        title={hint}
        aria-label={dirty ? `${title} 저장 안 됨` : undefined}
        onClick={select}
        onDoubleClick={onDoubleClick}
      >
        {dirty && (
          <span className="tab-dirty" aria-hidden="true">
            ●
          </span>
        )}
        {title}
        {badge}
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
  openMenu,
  mark,
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
  /** Opens a tab's menu. Right-click, Shift+F10, the menu key and the ⋯ button all use it. */
  openMenu?: (key: string, at: MenuPoint) => void;
  /** The group's part in the input scope, kept at the start of the bar. */
  mark?: ReactNode;
}) {
  const tabOf = (target: EventTarget) =>
    (target as HTMLElement).closest<HTMLElement>('[data-tab-key]')?.dataset.tabKey;
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
      onContextMenu={(e) => {
        const key = tabOf(e.target) ?? group.active;
        if (!openMenu || !key) return;
        e.preventDefault();
        openMenu(key, { x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        const key = tabOf(e.target);
        if (openMenu && key && isMenuKey(e)) {
          e.preventDefault();
          openMenu(key, anchorBelow(e.target as Element));
          return;
        }
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
      {mark}
      {start}
      {group.tabs.map((tab) => (
        <Fragment key={tabKey(tab)}>{renderTab(tab, group)}</Fragment>
      ))}
      {openMenu && group.active && (
        <button
          className="tab-menu-button"
          aria-label="탭 메뉴"
          aria-haspopup="menu"
          title="탭 메뉴 · Shift+F10"
          onClick={(e) => openMenu(group.active, anchorBelow(e.currentTarget))}
        >
          ⋯
        </button>
      )}
      {nextGroup && (
        <button className="next-group" aria-label="다음 칸" onClick={nextGroup}>
          ⇥
        </button>
      )}
    </div>
  );
}
