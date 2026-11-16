import { useEffect, useState } from 'react';
import { call, desktop, errorText, type Profile, type SerialSettings } from '../../lib/ipc';
import { defaultSerial } from './protocol';

type PortInfo = { name: string; description: string | null };

/** Speeds consoles commonly use. Another speed can still be typed. */
const speeds = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/**
 * A serial session's device and line settings (CG.5). The list shows what this PC has now; a
 * name from another PC or an unlisted device can be typed.
 */
export function SerialFields({
  profile,
  change,
}: {
  profile: Profile;
  change: (update: (p: Profile) => Profile) => void;
}) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [note, setNote] = useState('');
  const settings = profile.serial ?? defaultSerial;
  const set = (patch: Partial<SerialSettings>) =>
    change((p) => ({ ...p, serial: { ...(p.serial ?? defaultSerial), ...patch } }));
  const load = () => {
    if (!desktop) return;
    call<PortInfo[]>('serial_ports')
      .then((list) => {
        setPorts(list);
        setNote(list.length ? '' : '연결된 시리얼 장치가 없습니다. 케이블을 확인하세요.');
      })
      .catch((e) => setNote(errorText(e)));
  };
  useEffect(load, []);
  return (
    <>
      <label className="wide">
        장치
        <span className="serial-device">
          <input
            required
            list="serial-ports"
            spellCheck={false}
            maxLength={140}
            placeholder="COM3 또는 /dev/cu.usbserial-1410"
            value={profile.host}
            onChange={(e) => change((p) => ({ ...p, host: e.target.value.trim() }))}
          />
          <button type="button" onClick={load}>
            다시 찾기
          </button>
        </span>
        <datalist id="serial-ports">
          {ports.map((p) => (
            <option key={p.name} value={p.name}>
              {p.description ?? ''}
            </option>
          ))}
        </datalist>
        {note && <small>{note}</small>}
      </label>
      <label>
        통신 속도
        <input
          required
          type="number"
          list="serial-speeds"
          min={50}
          max={4000000}
          value={settings.baud}
          onChange={(e) => set({ baud: Number(e.target.value) })}
        />
        <datalist id="serial-speeds">
          {speeds.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </label>
      <label>
        데이터 비트
        <select
          value={settings.dataBits}
          onChange={(e) => set({ dataBits: Number(e.target.value) as SerialSettings['dataBits'] })}
        >
          {[8, 7, 6, 5].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <label>
        패리티
        <select
          value={settings.parity}
          onChange={(e) => set({ parity: e.target.value as SerialSettings['parity'] })}
        >
          <option value="none">없음</option>
          <option value="even">짝수</option>
          <option value="odd">홀수</option>
        </select>
      </label>
      <label>
        정지 비트
        <select
          value={settings.stopBits}
          onChange={(e) => set({ stopBits: Number(e.target.value) as SerialSettings['stopBits'] })}
        >
          <option>1</option>
          <option>2</option>
        </select>
      </label>
      <label className="wide">
        흐름 제어
        <select
          value={settings.flow}
          onChange={(e) => set({ flow: e.target.value as SerialSettings['flow'] })}
        >
          <option value="none">없음</option>
          <option value="software">소프트웨어 (XON/XOFF)</option>
          <option value="hardware">하드웨어 (RTS/CTS)</option>
        </select>
      </label>
    </>
  );
}
