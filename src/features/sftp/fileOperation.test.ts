import { describe, expect, it } from 'vitest';
import { operationText } from './fileOperation';

describe('operationText', () => {
  it('names each dialog after its operation', () => {
    expect(operationText('mkdir', 0)).toEqual({ title: '새 폴더', action: '만들기' });
    expect(operationText('rename', 1).title).toBe('이름 바꾸기');
    expect(operationText('edit', 1).action).toBe('편집 시작');
  });
  it('counts a multi-item delete and marks it dangerous', () => {
    expect(operationText('delete', 1)).toEqual({ title: '삭제', action: '삭제', danger: true });
    expect(operationText('delete', 3).title).toBe('3개 항목 삭제');
    expect(operationText('chmod', 2).title).toBe('2개 항목 권한 변경');
  });
  it('ignores the id after a colon', () => {
    expect(operationText('overwrite:abc', 1)).toMatchObject({ action: '덮어쓰기', danger: true });
    expect(operationText('saveAs:abc', 1).title).toBe('다른 이름으로 업로드');
    expect(operationText('discard:1', 0).title).toBe('전송 기록 삭제');
    expect(operationText('unknown', 0).title).toBe('파일 작업');
  });
});
