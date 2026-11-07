import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import './dialog.css';

/**
 * Widths every dialog picks from: small for a question or one field, medium for a form, large
 * for a list beside its detail (settings, tunnels, commands).
 */
export type DialogSize = 'small' | 'medium' | 'large';

/**
 * The one dialog frame. The title (and a one-line description) sit in a fixed header, the
 * content scrolls, and a trailing `.form-actions` row stays pinned to the bottom as the footer.
 * Errors use `role="alert"` and show as a banner; see dialog.css for the rest of the layout.
 */
export function Dialog({
  title,
  description,
  size = 'medium',
  children,
  close,
  className,
}: {
  title: string;
  description?: ReactNode;
  size?: DialogSize;
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    (
      dialog.querySelector<HTMLElement>('[autofocus]') ??
      dialog.querySelector<HTMLInputElement>('.dialog-body input:checked') ??
      dialog.querySelector<HTMLInputElement>('.dialog-body input')
    )?.focus();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog-${size}${className ? ` ${className}` : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      aria-label={title}
      aria-describedby={description ? `${id}-description` : undefined}
    >
      <header className="dialog-heading">
        <div className="dialog-title">
          <h2>{title}</h2>
          {description && <p id={`${id}-description`}>{description}</p>}
        </div>
        <button type="button" className="dialog-close" aria-label="대화상자 닫기" onClick={close}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
