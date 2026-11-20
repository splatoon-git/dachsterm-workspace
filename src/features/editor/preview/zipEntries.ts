// What a ZIP package says it holds, read from its directory without unpacking anything. Office and
// 한글 packages are ZIPs, and a small file can declare contents that fill the memory once unpacked,
// so a preview checks these sizes before a viewer unpacks it.

const END = 0x06054b50;
const ENTRY = 0x02014b50;
const ZIP64 = 0xffffffff;
/** The end record is the last thing in the file, after at most a 64KiB comment. */
const END_SEARCH = 22 + 0xffff;

export const unpackLimits = {
  /** Everything in the package together. */
  total: 512 * 1024 * 1024,
  /** One part read as text, such as a sheet's XML. */
  part: 96 * 1024 * 1024,
};

/** Each entry's name and declared unpacked size, or null when this is not a ZIP a viewer can read. */
export function declaredSizes(bytes: Uint8Array): Map<string, number> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - END_SEARCH); at -= 1) {
    if (view.getUint32(at, true) === END) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  // Sizes this large are stored elsewhere (ZIP64). No document a tab can show needs them.
  if (count === 0xffff || at === ZIP64) return null;
  const names = new TextDecoder();
  const sizes = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== ENTRY) return null;
    const size = view.getUint32(at + 24, true);
    if (size === ZIP64) return null;
    const nameLength = view.getUint16(at + 28, true);
    const next =
      at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (next > bytes.length) return null;
    sizes.set(names.decode(bytes.subarray(at + 46, at + 46 + nameLength)), size);
    at = next;
  }
  return sizes;
}

/** Why this package should not be unpacked for a preview, or null when it may be. */
export function unpackRefusal(bytes: Uint8Array) {
  const sizes = declaredSizes(bytes);
  if (!sizes) return '문서 묶음을 읽지 못했습니다. 파일이 손상됐을 수 있습니다.';
  let total = 0;
  for (const size of sizes.values()) total += size;
  return total > unpackLimits.total ? '압축을 풀면 너무 커서 미리 보지 않습니다.' : null;
}
