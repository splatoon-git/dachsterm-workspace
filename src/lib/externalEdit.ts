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

function savedUploadMode() {
  try {
    const mode = localStorage.getItem('dachsterm.uploadMode');
    return mode === 'auto' || mode === 'manual' ? mode : 'ask';
  } catch {
    return 'ask';
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
