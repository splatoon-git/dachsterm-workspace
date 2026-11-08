import { useState } from 'react';
import { SettingGroup, SettingRow } from '../components/SettingRows';
import { gitStatusText, syncText, type GitRepo } from '../features/git/gitStatus';
import {
  saveTerminalPreferences,
  useTerminalPreferences,
  type TerminalPreferences,
} from '../features/terminal/preferences';
import '../features/sftp/files.css';
import { saveGitDisplay, useGitDisplay, type GitDisplay } from '../lib/gitDisplay';
import { badgeSuffix, badgeText } from './promptBadge';
import './gitDisplaySettings.css';

type TreeRow = { name: string; mark: 'M' | '?' | 'folder' };

/** A small repository shown the way the chosen settings would show it. */
function GitDisplayPreview({
  promptBranch,
  display,
}: {
  promptBranch: TerminalPreferences['promptBranch'];
  display: GitDisplay;
}) {
  const { detail, treeMarks, statusBar, untracked } = display;
  const newFiles = untracked === 'files' ? ['notes/할 일.txt', 'notes/회의.txt'] : ['notes/'];
  const repo: GitRepo = {
    kind: 'repo',
    root: '/srv/app',
    branch: 'main',
    oid: 'abc1234',
    upstream: 'origin/main',
    ahead: 1,
    behind: 2,
    truncated: false,
    entries: [
      { path: 'src/app.ts', mark: 'M' },
      ...newFiles.map((path) => ({ path, mark: '?' as const })),
    ],
  };
  const rows: TreeRow[] = [
    { name: 'src', mark: 'folder' },
    { name: 'src/app.ts', mark: 'M' },
    ...newFiles.map((name) => ({ name, mark: '?' as const })),
  ];
  const suffix = badgeSuffix(
    detail === 'branch' ? null : String(repo.entries.length),
    detail === 'sync' ? syncText(repo) : '',
  );
  return (
    <div className="git-preview" role="group" aria-label="표시 미리보기">
      <div className="git-preview-terminal">
        <code>dev@server:~/app$</code>
        {promptBranch !== 'off' && (
          <code data-testid="preview-badge">{badgeText('main', suffix)}</code>
        )}
      </div>
      <ul className="git-preview-tree" aria-label="미리보기 파일 목록">
        {rows.map((row) => (
          <li key={row.name}>
            <span data-git-name={treeMarks === 'letter' ? undefined : row.mark}>{row.name}</span>
            {treeMarks !== 'color' && (
              <small className="file-git-mark" data-mark={row.mark}>
                {row.mark === 'folder' ? '•' : row.mark}
              </small>
            )}
          </li>
        ))}
      </ul>
      <div className="git-preview-status" data-testid="preview-status">
        {statusBar ? gitStatusText(repo, detail) : '상태바에 표시하지 않음'}
      </div>
    </div>
  );
}

/** How Git shows up around the app. Applied as it changes, like the other settings here. */
export function GitDisplaySettings() {
  const preferences = useTerminalPreferences();
  const display = useGitDisplay();
  const [message, setMessage] = useState('');
  const failed = () => setMessage('표시 설정을 저장하지 못했습니다.');
  const saveTerminal = (patch: Partial<TerminalPreferences>) => {
    try {
      saveTerminalPreferences(patch);
    } catch {
      failed();
    }
  };
  const save = (patch: Partial<GitDisplay>) => {
    try {
      saveGitDisplay(patch);
    } catch {
      failed();
    }
  };
  return (
    <>
      <SettingGroup
        title="표시 방식"
        note="Git 자동 조회는 탭의 폴더가 바뀌거나 명령이 끝날 때 읽기 전용 git status를 실행합니다. SSH 탭은 서버의 git, 로컬 탭은 이 PC의 git, WSL 탭은 배포판 안의 git을 씁니다. 끄면 상태바의 Git 버튼으로만 조회합니다."
      >
        <SettingRow label="터미널 안 브랜치">
          <select
            aria-label="터미널 안 브랜치"
            value={preferences.promptBranch}
            onChange={(e) =>
              saveTerminal({ promptBranch: e.target.value as TerminalPreferences['promptBranch'] })
            }
          >
            <option value="right">프롬프트 줄 오른쪽</option>
            <option value="off">끔</option>
          </select>
        </SettingRow>
        <SettingRow label="표시 내용">
          <select
            aria-label="표시 내용"
            value={display.detail}
            onChange={(e) => save({ detail: e.target.value as GitDisplay['detail'] })}
          >
            <option value="branch">브랜치만</option>
            <option value="changes">변경 수</option>
            <option value="sync">앞섬·뒤처짐까지</option>
          </select>
        </SettingRow>
        <SettingRow label="파일 트리">
          <select
            aria-label="파일 트리"
            value={display.treeMarks}
            onChange={(e) => save({ treeMarks: e.target.value as GitDisplay['treeMarks'] })}
          >
            <option value="letter">글자 (M, ?)</option>
            <option value="color">파일 이름 색</option>
            <option value="both">둘 다</option>
          </select>
        </SettingRow>
        <SettingRow label="상태바 표시">
          <input
            type="checkbox"
            className="switch"
            checked={display.statusBar}
            onChange={(e) => save({ statusBar: e.target.checked })}
          />
        </SettingRow>
        <SettingRow label="Git 상태 자동 조회">
          <input
            type="checkbox"
            className="switch"
            checked={preferences.gitStatus}
            onChange={(e) => saveTerminal({ gitStatus: e.target.checked })}
          />
        </SettingRow>
        <SettingRow label="추적 안 함 파일 (상태바·파일 트리)">
          <select
            aria-label="추적 안 함 파일"
            value={display.untracked}
            onChange={(e) => save({ untracked: e.target.value as GitDisplay['untracked'] })}
          >
            <option value="folders">폴더로 묶어서</option>
            <option value="files">파일 하나씩</option>
          </select>
        </SettingRow>
      </SettingGroup>
      <GitDisplayPreview promptBranch={preferences.promptBranch} display={display} />
      {message && <p role="status">{message}</p>}
    </>
  );
}
