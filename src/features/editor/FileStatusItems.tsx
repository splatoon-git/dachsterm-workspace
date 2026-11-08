import { useState } from 'react';
import { anchorBelow, ContextMenu, type MenuPoint } from '../../components/ContextMenu';
import type { Indent, LineBreak } from './editorTypes';
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

const lineBreaks: readonly LineBreak[] = ['LF', 'CRLF'];
const indents: readonly (readonly [Indent, string])[] = [
  [{ tabs: true, size: 4 }, '탭'],
  [{ tabs: false, size: 2 }, '공백 2'],
  [{ tabs: false, size: 4 }, '공백 4'],
];

type OpenMenu = { kind: 'encoding' | 'lineBreak' | 'indent'; at: MenuPoint };

/** The focused file tab's encoding, line ending, indentation and language. */
export function FileStatusItems({ id }: { id: string }) {
  const status = useFileStatus(id);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  if (!status) return null;
  const encoding = encodingNames[status.encoding] ?? status.encoding;
  const { setLineBreak, setIndent } = status;
  const close = () => setMenu(null);
  return (
    <span className="status-file" aria-label="파일 정보">
      <button
        className="status-tag"
        title="다른 인코딩으로 다시 읽기"
        aria-haspopup="menu"
        onClick={(e) => setMenu({ kind: 'encoding', at: anchorBelow(e.currentTarget) })}
      >
        {encoding}
      </button>
      {setLineBreak ? (
        <button
          className="status-tag"
          title="줄바꿈 변경"
          aria-haspopup="menu"
          onClick={(e) => setMenu({ kind: 'lineBreak', at: anchorBelow(e.currentTarget) })}
        >
          {status.eol}
        </button>
      ) : (
        <span className="status-tag" title="줄바꿈">
          {status.eol}
        </span>
      )}
      {setIndent ? (
        <button
          className="status-tag"
          title="들여쓰기 변경"
          aria-haspopup="menu"
          onClick={(e) => setMenu({ kind: 'indent', at: anchorBelow(e.currentTarget) })}
        >
          {status.indent}
        </button>
      ) : (
        <span className="status-tag" title="들여쓰기">
          {status.indent}
        </span>
      )}
      <span className="status-tag" title="언어">
        {status.language === 'plaintext' ? '일반 텍스트' : status.language}
      </span>
      {menu?.kind === 'encoding' && (
        <ContextMenu
          label="인코딩 선택"
          at={menu.at}
          close={close}
          items={encodings.map(([value, label]) => ({
            label,
            disabled: value === status.encoding,
            run: () => status.chooseEncoding(value),
          }))}
        />
      )}
      {menu?.kind === 'lineBreak' && setLineBreak && (
        <ContextMenu
          label="줄바꿈 선택"
          at={menu.at}
          close={close}
          items={lineBreaks.map((value) => ({
            label: value,
            disabled: value === status.eol,
            run: () => setLineBreak(value),
          }))}
        />
      )}
      {menu?.kind === 'indent' && setIndent && (
        <ContextMenu
          label="들여쓰기 선택"
          at={menu.at}
          close={close}
          items={indents.map(([value, label]) => ({
            label,
            disabled: label === status.indent,
            run: () => setIndent(value),
          }))}
        />
      )}
    </span>
  );
}
