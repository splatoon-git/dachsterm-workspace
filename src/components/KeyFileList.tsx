import { useEffect, useRef, useState } from 'react';
import { call, errorText, type ForwardKey } from '../lib/ipc';
import { ContextMenu, anchorBelow, isMenuKey, type MenuPoint } from './ContextMenu';
import { Icon } from './Icon';
import { addProblem, fileName, keyDetail, MAX_FORWARD_KEYS, type KeyInfo } from './keyFiles';
import { NewSshKeyButton } from './NewSshKey';
import './keyFileList.css';

/** The public part of a key file, or why it could not be read. */
const read = (path: string) =>
  call<KeyInfo>('ssh_key_info', { path }).then(
    (info) => info,
    (error: unknown) => errorText(error),
  );

/**
 * Key files the app's agent offers: a session's keys to forward (DX.11) or the local tabs' keys
 * (DX.13). Rows show only the public part, read by `ssh_key_info`; a key is removed from its ⋯
 * menu or by right-click. Enter in the path field adds the key and submits nothing else.
 */
export function KeyFileList({
  keys,
  change,
  placeholder,
}: {
  keys: readonly ForwardKey[];
  change: (keys: ForwardKey[]) => void;
  placeholder: string;
}) {
  const [infos, setInfos] = useState<Record<string, KeyInfo | string>>({});
  const asked = useRef(new Set<string>());
  const [path, setPath] = useState('');
  const [problem, setProblem] = useState('');
  const [menu, setMenu] = useState<{ at: MenuPoint; key: ForwardKey } | null>(null);
  useEffect(() => {
    for (const key of keys) {
      if (asked.current.has(key.path)) continue;
      asked.current.add(key.path);
      void read(key.path).then((info) => setInfos((all) => ({ ...all, [key.path]: info })));
    }
  }, [keys]);
  async function add() {
    const value = path.trim();
    const blocked = addProblem(keys, value);
    if (blocked) return setProblem(blocked);
    const info = await read(value);
    if (typeof info === 'string') return setProblem(info);
    asked.current.add(value);
    setInfos((all) => ({ ...all, [value]: info }));
    change([...keys, { path: value }]);
    setPath('');
    setProblem('');
  }
  const open = (at: MenuPoint, key: ForwardKey) => setMenu({ at, key });
  return (
    <div className="key-files">
      <ul aria-label="추가 키">
        {keys.map((key) => {
          const name = fileName(key.path);
          return (
            <li
              key={key.path}
              title={key.path}
              onContextMenu={(e) => {
                e.preventDefault();
                open({ x: e.clientX, y: e.clientY }, key);
              }}
            >
              <span className="key-file-text">
                <strong>{name}</strong>
                <small>
                  {keyDetail(infos[key.path])}
                  {key.secretRef ? ' · Passphrase 저장됨' : ''}
                </small>
              </span>
              <button
                type="button"
                className="key-file-more"
                aria-label={`${name} 작업`}
                aria-haspopup="menu"
                onClick={(e) => open(anchorBelow(e.currentTarget), key)}
                onKeyDown={(e) => {
                  if (!isMenuKey(e)) return;
                  e.preventDefault();
                  open(anchorBelow(e.currentTarget), key);
                }}
              >
                <Icon name="more" size={16} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="key-file-add">
        <label>
          추가할 키 파일 경로
          <input
            value={path}
            disabled={keys.length >= MAX_FORWARD_KEYS}
            placeholder={placeholder}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              void add();
            }}
          />
        </label>
        <button
          type="button"
          disabled={!path.trim() || keys.length >= MAX_FORWARD_KEYS}
          onClick={() => void add()}
        >
          추가
        </button>
        <NewSshKeyButton
          disabled={keys.length >= MAX_FORWARD_KEYS}
          created={(key) => {
            const blocked = addProblem(keys, key.path);
            if (blocked) setProblem(blocked);
            else change([...keys, { path: key.path }]);
          }}
        />
      </div>
      {problem && <p role="alert">{problem}</p>}
      {menu && (
        <ContextMenu
          at={menu.at}
          label={`${fileName(menu.key.path)} 작업`}
          close={() => setMenu(null)}
          items={[
            {
              label: '빼기',
              danger: true,
              run: () => {
                change(keys.filter((key) => key.path !== menu.key.path));
                setMenu(null);
              },
            },
          ]}
        />
      )}
    </div>
  );
}
