import type { LineRange } from './unifiedDiff';

/** One comment on a line range. The list lives in memory only and is gone when the tab closes. */
export type ReviewNote = LineRange & { id: string; path: string; text: string };

/**
 * Why a prompt was not filled in. The review never types into a terminal other than the one it
 * was opened for, and never into one that would pass the text on to other panes.
 */
export type Delivery = 'sent' | 'closed' | 'changed' | 'disconnected' | 'shared';
export const deliveryText: Record<Delivery, string> = {
  sent: '프롬프트에 넣었습니다. 내용을 확인한 뒤 Enter를 누르세요.',
  closed: '대상 터미널이 닫혀서 넣지 않았습니다. 복사해서 붙여넣으세요.',
  changed: '대상 터미널이 다시 연결되어 넣지 않았습니다. 복사해서 붙여넣으세요.',
  disconnected: '대상 터미널의 연결이 끊겨서 넣지 않았습니다. 복사해서 붙여넣으세요.',
  shared: '대상 터미널이 동시 입력 중이라 넣지 않았습니다. 복사해서 붙여넣으세요.',
};

/**
 * Server names and typed comments may hold control characters. An escape could end a bracketed
 * paste early and a line break would press Enter, so both become spaces.
 */
// eslint-disable-next-line no-control-regex
const control = /[\u0000-\u001f\u007f-\u009f]+/g;
const plain = (text: string) => text.replace(control, ' ').replace(/ {2,}/g, ' ').trim();

export function noteLocation(note: Pick<ReviewNote, 'path' | 'side' | 'start' | 'end'>) {
  const lines = note.start === note.end ? `${note.start}` : `${note.start}-${note.end}`;
  return `${plain(note.path)}:${lines}${note.side === 'old' ? ' (삭제된 줄)' : ''}`;
}

/**
 * `src/foo.ts:42-47 comment`, one note per line. Without bracketed paste a line break would run
 * the line, so the notes then share one line.
 */
export function promptText(notes: ReviewNote[], multiline: boolean) {
  const lines = notes.map((note) => `${noteLocation(note)} ${plain(note.text)}`.trim());
  return lines.join(multiline ? '\n' : ' / ');
}
