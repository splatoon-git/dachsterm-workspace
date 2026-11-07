import { useState, type ReactNode } from 'react';
import { Dialog } from '../components/Dialog';
import { Icon, type IconName } from '../components/Icon';
import { MaintenancePanel } from '../features/settings/MaintenancePanel';
import { SessionManager } from '../features/sessions/SessionManager';
import { SessionTransfer } from '../features/sessions/SessionTransfer';
import { VaultPanel, vaultSummary } from '../features/sessions/VaultDialog';
import { TerminalSettingsPanel } from '../features/terminal/TerminalSettings';
import type { Snapshot } from '../lib/ipc';
import { ThemePicker } from '../themes/ThemePicker';
import './settingsDialog.css';

export type SettingsSection =
  'appearance' | 'terminal' | 'vault' | 'sessions' | 'transfer' | 'recovery';

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
export function SettingsDialog({
  snapshot,
  changed,
  close,
}: {
  snapshot: Snapshot;
  /** Saved sessions changed (batch edit, import or restore). */
  changed: () => void;
  close: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(readSection);
  const choose = (next: SettingsSection) => {
    setSection(next);
    writeSection(next);
  };
  const entry = entries.find((e) => e.id === section)!;
  const content: Record<SettingsSection, ReactNode> = {
    appearance: <ThemePicker />,
    terminal: <TerminalSettingsPanel />,
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
