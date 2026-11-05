import { useEffect, useRef, type ReactNode } from 'react';

/** Native disclosure: Tab visits actions, Escape/outside click closes and restores focus. */
export function ToolbarMenu({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return (
    <details
      ref={ref}
      className="toolbar-menu"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest('dialog')) return;
        if (e.key === 'Escape') {
          e.stopPropagation();
          ref.current!.open = false;
          ref.current!.querySelector('summary')?.focus();
        }
      }}
    >
      <summary>{label}</summary>
      <div className="toolbar-menu-items">{children}</div>
    </details>
  );
}
