import { describe, expect, it } from 'vitest';
import { addFiles, sizeText, withAttachments } from './chatAttachments';

describe('chat attachments', () => {
  it('adds each file once', () => {
    const once = addFiles(
      [],
      ['/a.txt', '/b.png'],
      [
        { name: 'a.txt', size: 3 },
        { name: 'b.png', size: 2048 },
      ],
    );
    const twice = addFiles(once, ['/a.txt'], [{ name: 'a.txt', size: 3 }]);
    expect(twice.map((a) => a.name)).toEqual(['a.txt', 'b.png']);
  });

  it('puts the paths after the words, or alone when there are none', () => {
    expect(withAttachments('봐 줘', ['/s/a.png'])).toBe('봐 줘\n\n첨부한 파일:\n- /s/a.png');
    expect(withAttachments('  ', ['/s/a.png'])).toBe('첨부한 파일:\n- /s/a.png');
    expect(withAttachments('그냥', [])).toBe('그냥');
  });

  it('reads sizes', () => {
    expect(sizeText(900)).toBe('900 B');
    expect(sizeText(2048)).toBe('2 KB');
    expect(sizeText(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
