import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from '../components/Dialog';
import { Icon, type IconName } from '../components/Icon';
import { AgentPresetSettings } from '../features/agents/AgentPresetSettings';
import { LocalAgentSettings } from '../features/agents/LocalAgentSettings';
import { MaintenancePanel } from '../features/settings/MaintenancePanel';
import { SessionManager } from '../features/sessions/SessionManager';
import { SessionTransfer } from '../features/sessions/SessionTransfer';
import { VaultPanel, vaultSummary } from '../features/sessions/VaultDialog';
import type { TerminalSession } from '../features/terminal/session';
import { TerminalSettingsPanel } from '../features/terminal/TerminalSettings';
import type { Snapshot } from '../lib/ipc';
import {
  onSettingsRequest,
  type SettingsRequest,
  type SettingsSection,
} from '../lib/settingsRequest';
import { ThemePicker } from '../themes/ThemePicker';
import { GitSettingsSection } from './GitSettingsSection';
import './settingsDialog.css';

type Entry = { id: SettingsSection; label: string; icon: IconName; summary: string };
const entries: Entry[] = [
  {
    id: 'appearance',
    label: '테마',
    icon: 'palette',
    summary: '고르는 즉시 화면과 열린 터미널에 적용하고 자동으로 저장합니다.',
  },
  {
    id: 'terminal',
    label: '터미널',
    icon: 'terminal',
    summary: '모든 터미널과 새 창에 바로 적용됩니다. 서버별 설정은 세션 편집에 있습니다.',
  },
  {
    id: 'git',
    label: 'Git',
    icon: 'branch',
    summary:
      '이 PC의 Git 위치, 앱 안의 Git 표시, 각 대상의 git config, HTTPS 자격 증명을 정합니다.',
  },
  {
    id: 'agents',
    label: '에이전트',
    icon: 'snippet',
    summary: 'CLI 에이전트의 시작 명령과 로컬 탭에서 쓸 SSH 키를 정합니다.',
  },
  { id: 'vault', label: '암호 보관함', icon: 'lock', summary: vaultSummary },
  {
    id: 'sessions',
    label: '세션 일괄 수정',
    icon: 'server',
    summary: '여러 세션의 같은 항목을 한 번에 바꾸고, 자주 쓰는 값은 템플릿으로 저장합니다.',
  },
  {
    id: 'transfer',
    label: '가져오기·내보내기',
    icon: 'download',
    summary: '세션을 파일로 옮기거나 다른 프로그램의 세션 파일을 가져옵니다.',
  },
  {
    id: 'recovery',
    label: '복구·진단',
    icon: 'archive',
    summary: '설정 복구본으로 지운 세션을 되살리고, 문제를 알릴 때 쓸 진단 파일을 저장합니다.',
  },
];

const storageKey = 'dachsterm.settings.section';
function readSection(): SettingsSection {
  try {
    const saved = localStorage.getItem(storageKey);
    return entries.find((e) => e.id === saved)?.id ?? 'appearance';
  } catch {
    // Storage can be blocked; settings then open on the first section.
    return 'appearance';
  }
}
function writeSection(section: SettingsSection) {
  try {
    localStorage.setItem(storageKey, section);
  } catch {
    // Remembering the section is a convenience only.
  }
}

/**
 * App settings in one window: categories at the left, the chosen one at the right. Nothing in
 * here opens another dialog; each category edits in place and saves as it changes.
 */
function SettingsWindow({
  snapshot,
  session,
  request,
  changed,
  close,
}: {
  snapshot: Snapshot;
  session: TerminalSession | undefined;
  request: SettingsRequest | null;
  /** Saved sessions changed (batch edit, import or restore). */
  changed: () => void;
  close: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(() => request?.section ?? readSection());
  const choose = (next: SettingsSection) => {
    setSection(next);
    writeSection(next);
  };
  const entry = entries.find((e) => e.id === section)!;
  const content: Record<SettingsSection, ReactNode> = {
    appearance: <ThemePicker />,
    terminal: <TerminalSettingsPanel openGit={() => choose('git')} />,
    git: <GitSettingsSection session={session} repo={request?.repo} />,
    agents: (
      <>
        <AgentPresetSettings />
        <LocalAgentSettings />
        <p className="field-help">
          HTTPS Git 자격 증명은{' '}
          <button type="button" className="link-button" onClick={() => choose('git')}>
            설정 → Git
          </button>
          에서 관리합니다.
        </p>
      </>
    ),
    vault: <VaultPanel />,
    sessions: <SessionManager snapshot={snapshot} changed={changed} />,
    transfer: <SessionTransfer changed={changed} profiles={snapshot.profiles} />,
    recovery: <MaintenancePanel restored={changed} />,
  };
  return (
    <Dialog title="설정" size="large" className="settings-window" close={close}>
      <nav
        className="settings-nav"
        role="tablist"
        aria-label="설정 분류"
        aria-orientation="vertical"
        onKeyDown={(e) => {
          const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
          const at = entries.findIndex((x) => x.id === section);
          const next =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? entries.length - 1
                : step
                  ? (at + step + entries.length) % entries.length
                  : -1;
          if (next < 0) return;
          e.preventDefault();
          choose(entries[next].id);
          document.getElementById(`settings-tab-${entries[next].id}`)?.focus();
        }}
      >
        {entries.map((e) => (
          <button
            key={e.id}
            id={`settings-tab-${e.id}`}
            role="tab"
            aria-selected={section === e.id}
            aria-controls="settings-panel"
            tabIndex={section === e.id ? 0 : -1}
            onClick={() => choose(e.id)}
          >
            <Icon name={e.icon} size={15} />
            {e.label}
          </button>
        ))}
      </nav>
      <section
        id="settings-panel"
        className="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${section}`}
      >
        <header className="settings-panel-heading">
          <h3>{entry.label}</h3>
          <p>{entry.summary}</p>
        </header>
        <div key={section}>{content[section]}</div>
      </section>
    </Dialog>
  );
}

/** Always mounted in the main window, so a link anywhere in the app can open a category. */
export function SettingsDialog({
  open,
  setOpen,
  snapshot,
  session,
  changed,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  snapshot: Snapshot;
  /** The selected tab, whose SSH server can be a Git settings target. */
  session: TerminalSession | undefined;
  changed: () => void;
}) {
  const [request, setRequest] = useState<SettingsRequest | null>(null);
  useEffect(
    () =>
      onSettingsRequest((next) => {
        setRequest(next);
        setOpen(true);
      }),
    [setOpen],
  );
  if (!open) return null;
  return (
    <SettingsWindow
      snapshot={snapshot}
      session={session}
      request={request}
      changed={changed}
      close={() => {
        setOpen(false);
        setRequest(null);
      }}
    />
  );
}
