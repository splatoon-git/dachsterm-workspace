/** The documents a tab draws itself, by the id `file_read` gives them (`file_read/format.rs`). */
export const documentFormats = {
  pdf: 'PDF 문서',
  docx: 'Word 문서',
  xlsx: 'Excel 통합 문서',
  pptx: 'PowerPoint 프레젠테이션',
  hwp: '한글 문서',
  hwpx: '한글 문서',
} as const;

export type DocumentFormat = keyof typeof documentFormats;

export const isDocumentFormat = (value: string): value is DocumentFormat =>
  Object.hasOwn(documentFormats, value);

/** The bytes `file_read` sent as base64. */
export function bytesOf(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
