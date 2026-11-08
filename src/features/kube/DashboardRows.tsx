import { createContext, useContext, type ReactNode } from 'react';
import type { MenuPoint } from '../../components/ContextMenu';
import type { TreeTarget } from './treeReveal';

/** Right click on a dashboard row. The dashboard provides it; rows that have no target have no menu. */
export const TargetMenu = createContext<((target: TreeTarget, at: MenuPoint) => void) | null>(null);

export function ItemRow({
  target,
  reveal,
  className,
  children,
}: {
  target: TreeTarget | null;
  reveal: (target: TreeTarget) => void;
  className: string;
  children: ReactNode;
}) {
  const menu = useContext(TargetMenu);
  if (!target) return <div className={`kube-dash-row ${className}`}>{children}</div>;
  return (
    <button
      className={`kube-dash-row ${className}`}
      onClick={() => reveal(target)}
      onContextMenu={(event) => {
        if (!menu) return;
        event.preventDefault();
        menu(target, { x: event.clientX, y: event.clientY });
      }}
    >
      {children}
    </button>
  );
}
