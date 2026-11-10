import { useId, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import type { Profile } from '../../lib/ipc';
import { folderProblem } from '../../lib/shell';
import { recentFolders } from './chatFolders';
import { chatPrograms, type ChatProgram } from './chatPlaces';

/** Asks where on the server the chat's agent works, offering the session's recent folders. */
export function ChatOpenDialog({
  profile,
  program: initial,
  open,
  close,
}: {
  profile: Profile;
  /** The agent picked last in the title bar's chat entry. */
  program: ChatProgram;
  open: (folder: string, program: ChatProgram) => void;
  close: () => void;
}) {
  const [recent] = useState(() => recentFolders(profile.id));
  const [folder, setFolder] = useState(recent[0] ?? '');
  const [program, setProgram] = useState(initial);
  const list = useId();
  const typed = folder.trim();
  const error = folderProblem(typed);
  return (
    <Dialog
      title="채팅으로 열기"
      description={`${profile.name} · 에이전트가 작업할 서버 폴더`}
      size="small"
      close={close}
    >
      <form
        className="chat-open"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error) open(typed, program);
        }}
      >
        <label>
          폴더
          <input
            value={folder}
            list={list}
            autoFocus
            placeholder="비우면 로그인 폴더"
            spellCheck={false}
            maxLength={4096}
            aria-invalid={!!error}
            onChange={(e) => setFolder(e.target.value)}
          />
          <datalist id={list}>
            {recent.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <span className={`field-help${error ? ' chat-open-error' : ''}`}>
            {error ?? '사이드바 파일 트리에서 폴더를 우클릭해 열 수도 있습니다.'}
          </span>
        </label>
        <label>
          에이전트
          <select value={program} onChange={(e) => setProgram(e.target.value as ChatProgram)}>
            {chatPrograms.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <span className="field-help">서버에 설치하고 로그인해 둔 프로그램을 실행합니다.</span>
        </label>
        <div className="form-actions">
          <button type="button" onClick={close}>
            취소
          </button>
          <button className="primary" disabled={!!error}>
            열기
          </button>
        </div>
      </form>
    </Dialog>
  );
}
