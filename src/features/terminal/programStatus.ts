/**
 * OSC 7501 Program Status Protocol, revision 0.4. A program reports what it is doing and the tab
 * shows it. Report contents come from the server, so they are checked in full before any record
 * changes and shown only as plain text. Nothing from a record is ever written back.
 */
export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export type ProgramKind = 'permission' | 'question' | 'auth';
export type ProgramRecord = {
  state: ProgramState;
  id: string;
  kind?: ProgramKind;
  app?: string;
  title?: string;
  msg?: string;
};
type Report = ProgramRecord | { state: 'clear'; id: string };
export type ProgramSummary = {
  state: Exclude<ProgramState, 'idle'>;
  kind?: ProgramKind;
  /** Plain text for a tooltip. Hidden and direction-control characters are already removed. */
  detail: string;
};

export const programStatusQueryReply = '\x1b]7501;?\x1b\\';
const states = new Set(['idle', 'working', 'done', 'blocked', 'error', 'clear']);
const kinds = new Set(['permission', 'question', 'auth']);
const maxSequence = 4096;
const maxKey = 16;
const maxRecords = 64;
const maxDetail = 200;
const textLimits = { msg: { encoded: 2732, decoded: 2048 }, title: { encoded: 256, decoded: 192 } };
const priority: Exclude<ProgramState, 'idle'>[] = ['blocked', 'error', 'working', 'done'];
const hiddenCharacters = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

function validId(id: string) {
  if (id.length > 128) return false;
  const segments = id.split('/');
  return segments.length <= 8 && segments.every((s) => /^[A-Za-z0-9_.+-]{1,32}$/.test(s));
}

/** Null means the report is invalid. The protocol discards an invalid report as a whole. */
function decodeText(encoded: string, limit: { encoded: number; decoded: number }) {
  if (encoded.length > limit.encoded) return null;
  try {
    const padded = encoded.replace(/=+$/, '');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    if (binary.length > limit.decoded) return null;
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex -- control characters are what this rejects.
    return /[\u0000-\u001f\u007f-\u009f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

/** Returns the report, or null to ignore it. The caller handles the `?` query. */
export function parseProgramReport(body: string): Report | null {
  if (body.length > maxSequence) return null;
  const pairs = new Map<string, string>();
  for (const raw of body.split(':')) {
    const at = raw.indexOf('=');
    if (at <= 0) continue;
    const key = raw.slice(0, at).trim();
    const value = raw.slice(at + 1).trim();
    if (!/^[a-z]+$/.test(key) || !/^[A-Za-z0-9_.,+/=-]*$/.test(value)) continue;
    if (key.length > maxKey) return null;
    pairs.set(key, value);
  }
  const state = pairs.get('state');
  if (!state || !states.has(state)) return null;
  const id = pairs.get('id') ?? '';
  if (pairs.has('id') && !validId(id)) return null;
  if (state === 'clear') return { state: 'clear', id };
  const record: ProgramRecord = { state: state as ProgramState, id };
  const kind = pairs.get('kind');
  if (state === 'blocked' && kind && kinds.has(kind)) record.kind = kind as ProgramKind;
  const app = pairs.get('app');
  if (app && /^[A-Za-z0-9_.+-]{1,32}$/.test(app)) record.app = app;
  for (const key of ['msg', 'title'] as const) {
    const encoded = pairs.get(key);
    if (encoded === undefined) continue;
    const text = decodeText(encoded, textLimits[key]);
    if (text === null) return null;
    record[key] = text;
  }
  return record;
}

function detailOf(record: ProgramRecord) {
  const text = [record.title, record.msg].filter(Boolean).join(' · ');
  return text.replace(hiddenCharacters, '').slice(0, maxDetail);
}

export class ProgramStatus {
  private records = new Map<string, ProgramRecord>();
  /** A finished state stays stored, but the user has seen it and the tab stops showing it. */
  private seen = new Set<string>();
  private summary: ProgramSummary | null = null;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.summary;
  private changed() {
    const shown = [...this.records.values()].filter((r) => !this.seen.has(r.id));
    const state = priority.find((s) => shown.some((r) => r.state === s));
    const top = state && shown.filter((r) => r.state === state).at(-1);
    const next = top && state ? { state, kind: top.kind, detail: detailOf(top) } : null;
    const same =
      next?.state === this.summary?.state &&
      next?.kind === this.summary?.kind &&
      next?.detail === this.summary?.detail;
    if (same) return;
    this.summary = next;
    this.listeners.forEach((listener) => listener());
  }
  report(body: string) {
    const report = parseProgramReport(body);
    if (!report) return;
    if (report.state === 'clear') {
      for (const id of [...this.records.keys()])
        if (!report.id || id === report.id || id.startsWith(`${report.id}/`)) {
          this.records.delete(id);
          this.seen.delete(id);
        }
    } else {
      // Reinserting keeps the map in update order, so its first key is the oldest record.
      this.records.delete(report.id);
      this.seen.delete(report.id);
      this.records.set(report.id, report);
      if (this.records.size > maxRecords) {
        const oldest = this.records.keys().next().value;
        if (oldest !== undefined) this.records.delete(oldest);
      }
    }
    this.changed();
  }
  /** Shell prompt or connection end: the running program is gone, and its result remains. */
  programEnded() {
    for (const [id, record] of this.records)
      if (record.state === 'working' || record.state === 'blocked') this.records.delete(id);
    this.changed();
  }
  /** The user is back. A program waiting for them keeps showing until it reports otherwise. */
  acknowledge() {
    for (const [id, record] of this.records)
      if (record.state === 'done' || record.state === 'error') this.seen.add(id);
    this.changed();
  }
  reset() {
    this.records.clear();
    this.seen.clear();
    this.changed();
  }
}

export const programStateLabels: Record<ProgramSummary['state'], string> = {
  working: '작업 중',
  blocked: '입력 대기',
  done: '완료',
  error: '오류',
};
