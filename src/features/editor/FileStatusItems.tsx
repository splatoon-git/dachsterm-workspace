import { useState } from 'react';
import { anchorBelow, ContextMenu, type MenuPoint } from '../../components/ContextMenu';
import { useFileStatus } from './fileStatus';

const encodings = [
  ['utf-8', 'UTF-8'],
  ['euc-kr', 'CP949 / EUC-KR'],
  ['shift_jis', 'Shift_JIS'],
  ['gbk', 'GBK'],
  ['big5', 'Big5'],
  ['windows-1252', 'Windows-1252'],
] as const;

const encodingNames: Record<string, string> = {
  ...Object.fromEntries(encodings),
  'utf-8-bom': 'UTF-8 BOM',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
};

/** The focused file tab's encoding, line ending, indentation and language. */
export function FileStatusItems({ id }: { id: string }) {
  const status = useFileStatus(id);
  const [menu, setMenu] = useState<MenuPoint | null>(null);
  if (!status) return null;
  const encoding = encodingNames[status.encoding] ?? status.encoding;
  return (
    <span className="status-file" aria-label="파일 정보">
      <button
        className="status-tag"
        title="다른 인코딩으로 다시 읽기"
        aria-haspopup="menu"
        onClick={(e) => setMenu(anchorBelow(e.currentTarget))}
      >
        {encoding}
      </button>
      <span className="status-tag" title="줄바꿈">
        {status.eol}
      </span>
      <span className="status-tag" title="들여쓰기">
        {status.indent}
      </span>
      <span className="status-tag" title="언어">
        {status.language === 'plaintext' ? '일반 텍스트' : status.language}
      </span>
      {menu && (
        <ContextMenu
          label="인코딩 선택"
          at={menu}
          close={() => setMenu(null)}
          items={encodings.map(([value, label]) => ({
            label,
            disabled: value === status.encoding,
            run: () => status.chooseEncoding(value),
          }))}
        />
      )}
    </span>
  );
}
