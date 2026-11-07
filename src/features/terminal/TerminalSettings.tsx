import { Dialog } from '../../components/Dialog';
import { AgentHookGuide } from './AgentHookGuide';
import {
  fontSizeChoices,
  isMacPlatform,
  saveTerminalDisplay,
  saveTerminalPreferences,
  useTerminalDisplay,
  useTerminalPreferences,
} from './preferences';
import { useState } from 'react';

/** Settings shared by every terminal. Problems show inside the dialog, which has no pane. */
export function TerminalSettings({ close }: { close: () => void }) {
  const { fontSize, scrollback } = useTerminalDisplay();
  const preferences = useTerminalPreferences();
  const [message, setMessage] = useState('');
  const failed = () => setMessage('터미널 설정을 저장하지 못했습니다.');
  return (
    <Dialog title="터미널 설정" close={close}>
      <div className="terminal-preferences">
        {(
          [
            ['copyOnSelect', '마우스 선택 시 자동 복사'],
            ['rightClickPaste', '마우스 우클릭 붙여넣기'],
            ['followDirectory', '새 SFTP 탐색기의 터미널 경로 따라가기'],
            ['programGuide', 'vi·vim·less·tail 실행 중 조작표 자동 표시'],
            ['programStatus', '실행 중인 프로그램 상태를 탭에 표시'],
            ['clipboardWrite', '프로그램의 클립보드 복사 허용'],
            ['osNotifications', '다른 작업 중일 때 프로그램 상태를 OS 알림으로 표시'],
            ['bellNotifications', '터미널 벨도 OS 알림으로 표시'],
            ...(isMacPlatform ? ([['macOptionAsMeta', 'Option 키를 Meta로 사용']] as const) : []),
          ] as const
        ).map(([key, label]) => (
          <label className="checkbox" key={key}>
            <input
              type="checkbox"
              checked={preferences[key]}
              onChange={(e) => {
                try {
                  saveTerminalPreferences({ [key]: e.target.checked });
                } catch {
                  failed();
                }
              }}
            />
            {label}
          </label>
        ))}
        <label>
          Backspace 전송
          <select
            aria-label="Backspace 전송"
            value={preferences.backspace}
            onChange={(e) => {
              try {
                saveTerminalPreferences({ backspace: e.target.value as 'del' | 'bs' });
              } catch {
                failed();
              }
            }}
          >
            <option value="del">DEL · 표준 기본값</option>
            <option value="bs">Ctrl+H · 오래된 서버 호환</option>
          </select>
        </label>
        <label>
          글꼴 크기
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
        </label>
        <label>
          스크롤 기록
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
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted">
        마우스·키 설정은 열린 터미널과 새 창에도 적용됩니다. Ctrl/Cmd+Shift+C/V, Shift+Insert를
        사용할 수 있고, Ctrl/Cmd+스크롤로 글꼴 크기를 바꿉니다. 마우스를 사용하는 TUI에서는
        Shift+드래그/우클릭으로 선택·붙여넣기합니다. 방향키·Home/End·Delete·Tab·Ctrl+C는 터미널 표준
        모드를 따릅니다.
      </p>
      {message && <p role="status">{message}</p>}
      <AgentHookGuide notice={setMessage} />
    </Dialog>
  );
}
