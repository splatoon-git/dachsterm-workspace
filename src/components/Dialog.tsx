import { useLayoutEffect, useRef, type ReactNode } from 'react';
export function Dialog({
  title,
  children,
  close,
  className,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    (
      dialog.querySelector<HTMLInputElement>('input:checked') ??
      dialog.querySelector<HTMLInputElement>('input')
    )?.focus();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button type="button" aria-label="대화상자 닫기" onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
