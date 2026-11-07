/** What a file dialog is called and what its main button says, for each file operation. */
export type OperationText = {
  title: string;
  /** The primary button. */
  action: string;
  /** The action deletes or replaces data, so the button is drawn as a warning. */
  danger?: boolean;
};

/**
 * Names the dialog after what it does ("새 폴더", "3개 항목 삭제") instead of a generic title.
 * `operation` is the file panel's operation; a queued transfer or a pending edit carries its id
 * after a colon, which does not change the text.
 */
export function operationText(operation: string, count: number): OperationText {
  switch (operation.split(':')[0]) {
    case 'mkdir':
      return { title: '새 폴더', action: '만들기' };
    case 'newfile':
      return { title: '새 파일', action: '만들기' };
    case 'rename':
      return { title: '이름 바꾸기', action: '바꾸기' };
    case 'chmod':
      return { title: count > 1 ? `${count}개 항목 권한 변경` : '권한 변경', action: '적용' };
    case 'compress':
      return { title: '압축', action: '압축' };
    case 'extract':
      return { title: '압축 풀기', action: '풀기' };
    case 'edit':
      return { title: '외부 편집기', action: '편집 시작' };
    case 'delete':
      return { title: count > 1 ? `${count}개 항목 삭제` : '삭제', action: '삭제', danger: true };
    case 'overwrite':
      return { title: '원격 파일 덮어쓰기', action: '덮어쓰기', danger: true };
    case 'saveAs':
      return { title: '다른 이름으로 업로드', action: '업로드' };
    case 'discard':
      return { title: '전송 기록 삭제', action: '삭제', danger: true };
    default:
      return { title: '파일 작업', action: '적용' };
  }
}
