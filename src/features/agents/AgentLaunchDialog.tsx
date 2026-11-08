import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import type { Profile, TerminalLaunch } from '../../lib/ipc';
import { startLine } from '../../lib/shell';
import { dangerWarning, isDangerousCommand } from './agentOptions';
import { folderProblem, nameProblem, needsName, presetCommand, readAgentPresets } from './presets';
import './agents.css';

/**
 * The last step before an agent starts: the folder, the preset and the exact text that will run.
 * Nothing reaches the server until the user presses Start, and the text runs only once.
 */
export function AgentLaunchDialog({
  profile,
  folder: fixedFolder,
  start,
  close,
}: {
  profile: Profile;
  /** A folder picked in the file tree. Without one the user may type a folder. */
  folder?: string;
  start: (launch: TerminalLaunch) => void;
  close: () => void;
}) {
  const [presets] = useState(readAgentPresets);
  const [index, setIndex] = useState(0);
  const [name, setName] = useState('');
  const [typedFolder, setTypedFolder] = useState('');
  const preset = presets[index] ?? presets[0];
  const folder = (fixedFolder ?? typedFolder).trim();
  const command = presetCommand(preset, name);
  const folderError = fixedFolder === undefined ? folderProblem(folder) : null;
  const launch = command && !folderError ? { folder, command } : null;
  const tmux = profile.tmuxSession;
  const danger = isDangerousCommand(preset.command);
  return (
    <Dialog
      title="에이전트 시작"
      description={`${profile.name} · 새 탭에서 새 연결로 시작합니다`}
      close={close}
    >
      <form
        className="agent-launch"
        onSubmit={(e) => {
          e.preventDefault();
          if (launch) start(launch);
        }}
      >
        {fixedFolder !== undefined ? (
          <div className="agent-launch-folder">
            <span>폴더</span>
            <code>{fixedFolder}</code>
          </div>
        ) : (
          <label>
            폴더
            <input
              value={typedFolder}
              placeholder="비우면 로그인 폴더"
              spellCheck={false}
              maxLength={4096}
              aria-invalid={!!folderError}
              onChange={(e) => setTypedFolder(e.target.value)}
            />
            {folderError && <span className="field-help agent-launch-error">{folderError}</span>}
          </label>
        )}
        <label>
          프리셋
          <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
            {presets.map((p, i) => (
              <option key={i} value={i}>
                {isDangerousCommand(p.command) ? `${p.name} (위험)` : p.name}
              </option>
            ))}
          </select>
        </label>
        {needsName(preset) && (
          <label>
            이름
            <input
              value={name}
              autoFocus
              spellCheck={false}
              maxLength={64}
              placeholder="예: fix-login"
              aria-invalid={!!name && !!nameProblem(name)}
              onChange={(e) => setName(e.target.value.trim())}
            />
            <span className={`field-help${name && nameProblem(name) ? ' agent-launch-error' : ''}`}>
              {(name && nameProblem(name)) || '명령의 {name} 자리에 들어갑니다.'}
            </span>
          </label>
        )}
        <div className={`agent-launch-command${danger ? ' danger' : ''}`}>
          <span id="agent-launch-command">{tmux ? '실행할 명령' : '입력할 줄'}</span>
          <pre aria-labelledby="agent-launch-command">
            {launch ? (tmux ? launch.command : startLine(launch)) : preset.command}
          </pre>
          {danger && (
            <span role="alert" className="field-help agent-launch-error">
              {dangerWarning}
            </span>
          )}
        </div>
        <p className="field-help">
          {tmux
            ? `tmux 세션(${tmux})을 새로 만들 때만 ${folder ? '이 폴더에서 ' : ''}실행합니다. 세션이 이미 있으면 붙기만 하고 실행하지 않습니다. 서버에 tmux가 없으면 일반 셸만 엽니다.`
            : '셸 프롬프트가 나타나면 한 번 입력하고 Enter를 누릅니다. 10초 안에 프롬프트를 찾지 못하면 입력하지 않고 명령을 보여 줍니다.'}{' '}
          재접속하면 다시 실행하지 않습니다.
        </p>
        <div className="form-actions">
          <button type="button" onClick={close}>
            취소
          </button>
          <button className="primary" disabled={!launch}>
            시작
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Shown when a plain shell never showed its prompt, so the user can run the line themselves. */
export function AgentNotTypedDialog({
  sessionName,
  line,
  copy,
  close,
}: {
  sessionName: string;
  line: string;
  copy: () => void;
  close: () => void;
}) {
  return (
    <Dialog title="명령을 입력하지 않았습니다" description={sessionName} size="small" close={close}>
      <p>
        10초 안에 셸 프롬프트를 찾지 못해 아무것도 입력하지 않았습니다. 프롬프트가 보이면 아래 줄을
        붙여넣어 실행하세요.
      </p>
      <pre className="agent-launch-line">{line}</pre>
      <div className="form-actions">
        <button type="button" onClick={close}>
          닫기
        </button>
        <button
          type="button"
          className="primary"
          autoFocus
          onClick={() => {
            copy();
            close();
          }}
        >
          복사
        </button>
      </div>
    </Dialog>
  );
}
