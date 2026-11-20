import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { declaredSizes, unpackLimits, unpackRefusal } from './zipEntries';

async function packageOf(files: Record<string, string>, comment?: string) {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', comment });
}

/** Rewrites the unpacked size an entry declares in the directory at the end of the file. */
function declare(bytes: Uint8Array, name: string, size: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wanted = new TextEncoder().encode(name);
  for (let at = 0; at + 46 + wanted.length <= bytes.length; at += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const found = bytes.subarray(at + 46, at + 46 + wanted.length);
    if (found.every((byte, index) => byte === wanted[index])) view.setUint32(at + 24, size, true);
  }
  return bytes;
}

describe('what a package declares', () => {
  it('lists every entry with its unpacked size, Korean names included', async () => {
    const bytes = await packageOf({ 'word/document.xml': 'a'.repeat(5000), '한글.txt': '가나다' });
    // The folder itself is an entry too, with nothing in it.
    expect(declaredSizes(bytes)).toEqual(
      new Map([
        ['word/', 0],
        ['word/document.xml', 5000],
        ['한글.txt', 9],
      ]),
    );
    expect(unpackRefusal(bytes)).toBeNull();
  });

  it('finds the directory behind a trailing comment', async () => {
    const bytes = await packageOf({ 'a.xml': 'abc' }, 'comment '.repeat(100));
    expect(declaredSizes(bytes)?.get('a.xml')).toBe(3);
  });

  it('refuses a package that would unpack past the limit', async () => {
    const whole = await packageOf({ 'a.xml': 'abc', 'b.xml': 'def' });
    const bytes = declare(whole, 'b.xml', unpackLimits.total);
    expect(unpackRefusal(bytes)).toBe('압축을 풀면 너무 커서 미리 보지 않습니다.');
  });

  it('does not read sizes kept in the 64-bit records', async () => {
    const bytes = declare(await packageOf({ 'a.xml': 'abc' }), 'a.xml', 0xffffffff);
    expect(declaredSizes(bytes)).toBeNull();
  });

  it('says so when the bytes are not a package or are cut short', async () => {
    expect(declaredSizes(new Uint8Array(0))).toBeNull();
    expect(
      declaredSizes(new TextEncoder().encode('PK\x03\x04 not a zip at all, only its start')),
    ).toBeNull();
    const whole = await packageOf({ 'a.xml': 'abc', 'b.xml': 'def' });
    // The end record survives while the directory it points at is gone.
    const cut = new Uint8Array([...whole.subarray(0, 10), ...whole.subarray(whole.length - 22)]);
    expect(declaredSizes(cut)).toBeNull();
    expect(unpackRefusal(cut)).toBe('문서 묶음을 읽지 못했습니다. 파일이 손상됐을 수 있습니다.');
  });
});
