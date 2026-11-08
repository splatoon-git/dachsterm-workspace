import type { ReactNode } from 'react';
import './settingRows.css';

/** A titled block of settings, one per row. */
export function SettingGroup({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="dialog-section terminal-settings-group" aria-label={title}>
      <h3>{title}</h3>
      {note && <p>{note}</p>}
      <div className="setting-rows">{children}</div>
    </section>
  );
}

/** One setting: its name at the left and the control at the right. */
export function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="setting-row">
      <span>{label}</span>
      {children}
    </label>
  );
}
