import type { MouseEvent, KeyboardEvent } from 'react';
import { anchorBelow, isMenuKey, type MenuPoint } from '../../components/ContextMenu';
import { outcomeLabel, rowNote, type CheckRow } from './portCheck';

/** The results of a port check. `menu` adds the row's right-click actions. */
export function CheckRows({
  rows,
  menu,
}: {
  rows: CheckRow[];
  menu?: (row: CheckRow, at: MenuPoint) => void;
}) {
  const handlers = (row: CheckRow) =>
    menu && {
      tabIndex: 0,
      onContextMenu: (event: MouseEvent) => {
        event.preventDefault();
        menu(row, { x: event.clientX, y: event.clientY });
      },
      onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
        if (!isMenuKey(event)) return;
        event.preventDefault();
        menu(row, anchorBelow(event.currentTarget));
      },
    };
  return (
    <table className="tool-results">
      <thead>
        <tr>
          <th>결과</th>
          <th>대상</th>
          <th>포트</th>
          <th>근거</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.host}:${row.port}`} {...handlers(row)}>
            <td>
              <span className={`tool-outcome ${row.outcome}`}>{outcomeLabel[row.outcome]}</span>
            </td>
            <td>{row.host}</td>
            <td>{row.port}</td>
            <td className="tool-note">{rowNote(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
