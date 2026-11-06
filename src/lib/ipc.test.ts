import { describe, expect, it } from 'vitest';
import { errorText, UserError } from './ipc';
describe('errorText', () => {
  it('shows backend strings and user errors as written', () => {
    expect(errorText('서버 오류')).toBe('서버 오류');
    expect(errorText(new UserError('값을 입력하세요.'))).toBe('값을 입력하세요.');
  });
  it('does not expose internal errors', () => {
    const generic = '작업에 실패했습니다. 다시 시도하세요.';
    expect(errorText(new TypeError('x is undefined'))).toBe(generic);
    expect(errorText(undefined)).toBe(generic);
  });
});
