import { Fragment, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { nextEnabled, placeMenu, type MenuPoint } from './menuPlacement';
export type { MenuPoint };
import './contextMenu.css';

export type MenuItem = {
  label: string;
  run: () => void;
  disabled?: boolean;
  /** Shown on the right, for the key that does the same thing. */
  shortcut?: string;
  /** Draws a line above the item, to group related items. */
  separated?: boolean;
  danger?: boolean;
};
export type MenuRequest = { at: MenuPoint; items: MenuItem[] };

/** Where a keyboard-opened menu appears: under the element that has focus. */
export function anchorBelow(element: Element): MenuPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

/**
 * Where the menu is drawn. A modal dialog makes the rest of the page inert, so a menu opened while
 * one is open belongs inside the topmost dialog; otherwise it could not be clicked.
 */
function menuHost(): HTMLElement {
  const open = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  return open[open.length - 1] ?? document.body;
}

/** Whether a key press asks for the focused element's context menu. */
export const isMenuKey = (event: { key: string; shiftKey: boolean }) =>
  event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');

/**
 * A context menu from data. It stays inside the window, closes on an outside press, Escape or Tab,
 * moves with the arrow keys, and gives focus back to where it was when it closes.
 */
export function ContextMenu({
  at,
  items,
  label,
  close,
}: {
  at: MenuPoint;
  items: MenuItem[];
  label: string;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [host] = useState(menuHost);
  const onClose = useEffectEvent(close);
  useLayoutEffect(() => {
    const menu = ref.current!;
    const opener = document.activeElement;
    const place = placeMenu(
      at,
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    menu.style.left = `${place.x}px`;
    menu.style.top = `${place.y}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      // Give focus back only if it is still in the menu; a press elsewhere has chosen a new place.
      const lost = !document.activeElement || document.activeElement === document.body;
      const inside = menu.contains(document.activeElement);
      if ((lost || inside) && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [at]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const resize = () => onClose();
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', resize);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', resize);
    };
  }, []);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="context-menu"
      style={{ left: at.x, top: at.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          close();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(ref.current!.querySelectorAll('button'));
        const next = nextEnabled(
          buttons.map((button) => button.disabled),
          buttons.indexOf(document.activeElement as HTMLButtonElement),
          event.key,
        );
        buttons[next]?.focus();
      }}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.separated && <div role="separator" className="context-menu-separator" />}
          <button
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            onClick={() => {
              close();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        </Fragment>
      ))}
    </div>,
    host,
  );
}
