import { call, UserError } from './ipc';
import type { Source } from './source';

/** A row of `edit_list`, read by the file panel and by the save card on a terminal tab. */
export type ExternalEdit = {
  id: string;
  connectionId: string;
  profileId: string;
  uploadMode: string;
  remote: string;
  local: string;
  status: string;
  message: string;
  /** Whether the connection the edit is bound to is still open. */
  connectionLive: boolean;
};

export function savedEditor() {
  try {
    return localStorage.getItem('dachsterm.editor') ?? 'code';
  } catch {
    return 'code';
  }
}

export function savedEditorArgs() {
  try {
    const args: unknown = JSON.parse(localStorage.getItem('dachsterm.editorArgs') ?? '[]');
    return Array.isArray(args) && args.every((a) => typeof a === 'string')
      ? (args as string[])
      : [];
  } catch {
    return [];
  }
}

export function savedUploadMode() {
  try {
    const mode = localStorage.getItem('dachsterm.uploadMode');
    return mode === 'auto' || mode === 'manual' ? mode : 'ask';
  } catch {
    return 'ask';
  }
}

/** Keeps the choices of the edit dialog for the next file. `args` is the JSON text it validated. */
export function rememberEditor(editor: string, uploadMode: string, args: string) {
  try {
    localStorage.setItem('dachsterm.editor', editor);
    localStorage.setItem('dachsterm.uploadMode', uploadMode);
    localStorage.setItem('dachsterm.editorArgs', args);
  } catch {
    // Storage can be full or blocked. The edit still starts; only the next default is lost.
  }
}

/** Opens a file in the editor the user last chose in a file panel, without asking again. */
export function editExternally(source: Source, profileId: string, path: string) {
  const program = savedEditor();
  const args = savedEditorArgs();
  if (source.kind === 'local')
    return call('local_files_edit', { targetId: source.targetId, path, program, args });
  if (source.kind === 'ssh')
    return call('edit_start', {
      id: source.connectionId,
      profileId,
      path,
      program,
      args,
      uploadMode: savedUploadMode(),
    });
  return Promise.reject(new UserError('FTP 파일은 외부 편집기로 열 수 없습니다.'));
}

/** Whether a file from this source can go to the program this computer has for its type. */
export const opensByDefault = (source: Source) => source.kind !== 'ftp';

/**
 * Opens a file in the program this computer has for its type. A server file is fetched first and
 * watched like an external edit, so saving it there offers the upload.
 */
export function openByDefault(source: Source, profileId: string | undefined, path: string) {
  if (source.kind === 'local')
    return call('local_files_open_default', { targetId: source.targetId, path });
  if (source.kind === 'ssh' && profileId)
    return call('edit_open_default', {
      id: source.connectionId,
      profileId,
      path,
      uploadMode: savedUploadMode(),
    });
  return Promise.reject(
    new UserError(
      source.kind === 'ftp'
        ? 'FTP 파일은 다운로드한 뒤 여세요.'
        : '연결이 끊겨 파일을 가져올 수 없습니다.',
    ),
  );
}
