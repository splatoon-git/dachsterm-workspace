import { useEffect, useState } from 'react';
import { FileTabBar } from '../TextDocument';
import { columnName, readWorkbook, sheetLimits, type Sheet } from './sheetModel';
import type { ViewerProps } from './viewer';
import './preview.css';

const limits = `${sheetLimits.rows.toLocaleString()}행 ${sheetLimits.columns}열`;

function Grid({ sheet }: { sheet: Sheet }) {
  if (!sheet.rows.length)
    return (
      <p className="preview-note">
        {sheet.clipped ? '이 시트는 너무 커서 미리 보지 않습니다.' : '빈 시트입니다.'}
      </p>
    );
  const columns = Array.from({ length: sheet.columns }, (_, index) => index);
  return (
    <table className="preview-sheet">
      <thead>
        <tr>
          <th aria-hidden="true" />
          {columns.map((column) => (
            <th key={column} scope="col">
              {columnName(column)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sheet.rows.map((row, at) => (
          <tr key={at}>
            <th scope="row">{at + 1}</th>
            {columns.map((column) => (
              <td key={column}>{row[column]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A spreadsheet's stored values, one sheet at a time. Nothing in it is worked out or run. */
export default function SheetView({ bytes, path, actions, fail }: ViewerProps) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    let alive = true;
    readWorkbook(bytes).then(
      (read) => {
        if (alive) setSheets(read);
      },
      () => {
        if (alive) fail('통합 문서를 읽지 못했습니다. 암호가 걸렸거나 손상된 파일일 수 있습니다.');
      },
    );
    return () => {
      alive = false;
    };
  }, [bytes, fail]);
  if (!sheets)
    return (
      <div className="editor-loading" role="status">
        통합 문서를 여는 중…
      </div>
    );
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  return (
    <>
      <FileTabBar path={path}>
        <span className="preview-count">값만 표시</span>
        {actions}
      </FileTabBar>
      {sheet.clipped && sheet.rows.length > 0 && (
        <p className="file-tab-banner" role="status">
          앞쪽 {limits}까지만 보여 줍니다.
        </p>
      )}
      <div className="preview-flow">
        <Grid sheet={sheet} />
      </div>
      <div className="preview-sheets" role="tablist" aria-label="시트">
        {sheets.map((item, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            aria-selected={item === sheet}
            onClick={() => setActive(index)}
          >
            {item.name}
          </button>
        ))}
      </div>
    </>
  );
}
