export type IconName =
  | 'server'
  | 'game'
  | 'folder'
  | 'file'
  | 'terminal'
  | 'plus'
  | 'search'
  | 'settings'
  | 'upload'
  | 'download'
  | 'refresh'
  | 'chevron'
  | 'grid'
  | 'tunnel'
  | 'activity'
  | 'arrow'
  | 'close'
  | 'up'
  | 'folderPlus'
  | 'filePlus'
  | 'uploadFolder'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'edit'
  | 'rename'
  | 'lock'
  | 'key'
  | 'archive'
  | 'extract'
  | 'trash'
  | 'sidebar'
  | 'keyboard'
  | 'snippet'
  | 'tools'
  | 'star'
  | 'clock'
  | 'more'
  | 'palette'
  | 'branch'
  | 'gitFetch'
  | 'gitPull'
  | 'gitPush'
  | 'target'
  | 'minus'
  | 'kube'
  | 'undo'
  | 'check'
  | 'cloud'
  | 'tag'
  | 'react'
  | 'gear'
  | 'flask'
  | 'image';
const paths: Record<IconName, string> = {
  game: 'M7 7h10c3 0 4 3 4 7s-2 5-4 3l-2-2H9l-2 2c-2 2-4 1-4-3s1-7 4-7z M8 10v5 M5.5 12.5h5 M16 11h.01 M18 14h.01',
  server: 'M4 3h16v7H4z M4 14h16v7H4z M7 6.5h.01 M7 17.5h.01 M11 6.5h6 M11 17.5h6',
  folder: 'M3 7V5h6l2 2h10v13H3z',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6',
  terminal: 'M3 4h18v16H3z M7 9l3 3-3 3 M13 15h4',
  plus: 'M12 5v14 M5 12h14',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
  download: 'M12 3v13 M7 11l5 5 5-5 M4 16v5h16v-5',
  refresh: 'M20 10a8 8 0 1 0-1 8 M20 4v6h-6',
  chevron: 'M9 5l7 7-7 7',
  grid: 'M3 3h18v18H3z M12 3v18 M3 12h18',
  tunnel: 'M3 8h6v8H3z M15 8h6v8h-6z M9 12h6 M6 5V3 M18 19v2',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
  arrow: 'M5 12h14 M14 7l5 5-5 5',
  palette:
    'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-2 0-3h3a4 4 0 0 0 4-4c0-5-4-9-9-9z M7.5 11h.01 M10 7.5h.01 M14.5 7.5h.01',
  close: 'M6 6l12 12 M18 6L6 18',
  up: 'M12 19V5 M6 11l6-6 6 6',
  folderPlus: 'M3 7V5h6l2 2h10v13H3z M12 11v5 M9.5 13.5h5',
  filePlus: 'M5 3h9l5 5v13H5z M14 3v6h5 M12 12v6 M9 15h6',
  uploadFolder: 'M3 7V5h6l2 2h10v13H3z M12 17v-6 M9.5 13.5l2.5-2.5 2.5 2.5',
  copy: 'M9 9h11v12H9z M5 15H4V3h12v2',
  cut: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M8.5 7.5L20 19 M8.5 16.5L20 5',
  paste: 'M9 3h6v3H9z M9 5H5v16h14V5h-4',
  edit: 'M4 20l1-4L16 5l3 3L8 19z M14 7l3 3',
  rename: 'M12 4v16 M9 4h6 M9 20h6 M4 8v8 M20 8v8',
  lock: 'M6 11h12v10H6z M8.5 11V7a3.5 3.5 0 0 1 7 0v4',
  key: 'M8 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 12h9 M18 12v3 M21 12v2',
  archive: 'M3 4h18v5H3z M5 9v11h14V9 M10 13h4',
  extract: 'M3 4h18v5H3z M5 9v11h14V9 M12 12v5 M9.5 14.5l2.5 2.5 2.5-2.5',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14 M10 11v6 M14 11v6',
  sidebar: 'M3 4h18v16H3z M9 4v16',
  keyboard: 'M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M7 14h10',
  snippet:
    'M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1 M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1',
  tools:
    'M14.5 6.5a4 4 0 0 0-5.3 5.3L3.5 17.5l3 3 5.7-5.7a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.3-.6-.6-2.3z',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  branch:
    'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 9a9 9 0 0 1-9 9',
  gitFetch: 'M12 3v11 M7 9l5 5 5-5 M4 20h3 M10.5 20h3 M17 20h3',
  gitPull: 'M12 3v11 M7 9l5 5 5-5 M5 20h14',
  gitPush: 'M12 21V10 M7 15l5-5 5 5 M5 4h14',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  minus: 'M5 12h14',
  kube: 'M12 2.5l8 4v9l-8 6-8-6v-9z M12 8.5v7 M6.5 9.5l5.5 3 5.5-3',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  check: 'M5 12.5l4.5 4.5L19 7',
  cloud: 'M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9.5a4.2 4.2 0 0 1-.5 8.5z',
  tag: 'M3 12V4h8l10 10-8 8z M7.5 8.5h.01',
  react:
    'M2 12a10 4 0 1 0 20 0a10 4 0 1 0 -20 0 M7 3.34a10 4 60 1 0 10 17.32a10 4 60 1 0 -10 -17.32 M17 3.34a10 4 120 1 0 -10 17.32a10 4 120 1 0 10 -17.32 M12 12h.01',
  gear: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9L7 7 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1',
  flask: 'M9 3h6 M10 3v6l-5.5 10a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3 M7.5 15h9',
  image: 'M3 4h18v16H3z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 20',
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
