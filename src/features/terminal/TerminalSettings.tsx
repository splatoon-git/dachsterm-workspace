import { Dialog } from '../../components/Dialog';
import { AgentHookGuide } from './AgentHookGuide';
import {
  fontSizeChoices,
  isMacPlatform,
  longCommandChoices,
  saveTerminalDisplay,
  saveTerminalPreferences,
  useTerminalDisplay,
  useTerminalPreferences,
  type TerminalPreferences,
} from './preferences';
import { useState, type ReactNode } from 'react';
import './terminalSettings.css';

type Toggle = keyof {
  [K in keyof TerminalPreferences as TerminalPreferences[K] extends boolean ? K : never]: true;
};

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="dialog-section terminal-settings-group" aria-label={title}>
      <h3>{title}</h3>
      {note && <p>{note}</p>}
      <div className="setting-rows">{children}</div>
    </section>
  );
}

/** One setting: its name at the left and the control at the right. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="setting-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Terminal settings on their own, for a detached window that has no app settings. */
export function TerminalSettings({ close }: { close: () => void }) {
  return (
    <Dialog
      title="터미널 설정"
      description="모든 터미널과 새 창에 바로 적용됩니다."
      className="terminal-settings-dialog"
      close={close}
    >
      <TerminalSettingsPanel />
    </Dialog>
  );
}

/**
 * Settings shared by every terminal, grouped by what they act on. Settings that belong to one
 * connection stay in its session form, and the session log and a pinned guide stay in the tab menu.
 * Problems show inside the dialog, which has no pane.
 */
export function TerminalSettingsPanel() {
  const { fontSize, scrollback } = useTerminalDisplay();
  const preferences = useTerminalPreferences();
  const [message, setMessage] = useState('');
  const failed = () => setMessage('터미널 설정을 저장하지 못했습니다.');
  const save = (patch: Partial<TerminalPreferences>) => {
    try {
      saveTerminalPreferences(patch);
    } catch {
      failed();
    }
  };
  const toggles = (items: (readonly [Toggle, string])[]) =>
    items.map(([key, label]) => (
      <Row key={key} label={label}>
        <input
          type="checkbox"
          className="switch"
          checked={preferences[key]}
          onChange={(e) => save({ [key]: e.target.checked })}
        />
      </Row>
    ));
  return (
    <>
      <Group title="표시">
        <Row label="글꼴 크기">
          <select
            aria-label="글꼴 크기"
            value={fontSize}
            onChange={(e) => {
              try {
                saveTerminalDisplay({ fontSize: Number(e.target.value) });
              } catch {
                failed();
              }
            }}
          >
            {fontSizeChoices(fontSize).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </Row>
        <Row label="스크롤 기록">
          <select
            aria-label="스크롤백"
            value={scrollback}
            onChange={(e) => {
              try {
                saveTerminalDisplay({ scrollback: Number(e.target.value) });
              } catch {
                failed();
              }
            }}
          >
            {[1000, 5000, 10000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}줄
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group
        title="마우스·키보드"
        note="Ctrl/Cmd+Shift+C/V, Shift+Insert를 사용할 수 있고, Ctrl/Cmd+스크롤로 글꼴 크기를 바꿉니다. 마우스를 사용하는 TUI에서는 Shift+드래그/우클릭으로 선택·붙여넣기합니다. 방향키·Home/End·Delete·Tab·Ctrl+C는 터미널 표준 모드를 따릅니다."
      >
        {toggles([
          ['copyOnSelect', '마우스 선택 시 자동 복사'],
          ['rightClickPaste', '마우스 우클릭 붙여넣기'],
          ...(isMacPlatform ? ([['macOptionAsMeta', 'Option 키를 Meta로 사용']] as const) : []),
        ])}
        <Row label="Backspace 전송">
          <select
            aria-label="Backspace 전송"
            value={preferences.backspace}
            onChange={(e) => save({ backspace: e.target.value as 'del' | 'bs' })}
          >
            <option value="del">DEL · 표준 기본값</option>
            <option value="bs">Ctrl+H · 오래된 서버 호환</option>
          </select>
        </Row>
      </Group>
      <Group
        title="프로그램 연동"
        note="경로 따라가기와 조작표 자동 표시는 Bash·Zsh에 지금 세션에만 함수를 더합니다. 이 함수는 명령 경계(프롬프트 이동, 실패한 명령 표시)와 종료 코드도 알립니다. 셸 설정 파일은 바꾸지 않고 입력한 키, 명령 인자, 이력은 수집하지 않습니다. 둘 다 끄면 아무것도 넣지 않으며, 켜면 새로 여는 셸부터 적용됩니다. Git 자동 조회는 SSH 탭의 폴더가 바뀌거나 명령이 끝날 때 서버에서 읽기 전용 git status를 실행합니다. 끄면 상태바의 Git 버튼으로만 조회합니다."
      >
        {toggles([
          ['programGuide', 'vi·vim·less·tail 실행 중 조작표 자동 표시'],
          ['followDirectory', '새 파일 패널에서 터미널 경로 따라가기'],
          ['programStatus', '실행 중인 프로그램 상태를 탭에 표시'],
          ['clipboardWrite', '프로그램의 클립보드 복사 허용'],
          ['gitStatus', 'SSH 폴더의 Git 상태 자동 조회'],
        ])}
      </Group>
      <Group title="알림">
        {toggles([
          ['osNotifications', '다른 작업 중일 때 프로그램 상태를 OS 알림으로 표시'],
          ['bellNotifications', '터미널 벨도 OS 알림으로 표시'],
        ])}
        <Row label="긴 명령 완료 알림 (다른 작업 중일 때)">
          <select
            aria-label="긴 명령 완료 알림"
            value={preferences.longCommandNotify}
            onChange={(e) => save({ longCommandNotify: Number(e.target.value) })}
          >
            {longCommandChoices.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds === 0
                  ? '끔'
                  : seconds < 60
                    ? `${seconds}초 이상`
                    : `${seconds / 60}분 이상`}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <section className="dialog-section" aria-label="CLI 에이전트">
        <h3>CLI 에이전트</h3>
        <AgentHookGuide notice={setMessage} />
      </section>
      {message && <p role="status">{message}</p>}
    </>
  );
}
