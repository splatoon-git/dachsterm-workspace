type Name =
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
  | 'close';
const paths: Record<Name, string> = {
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
  close: 'M6 6l12 12 M18 6L6 18',
};
export function Icon({ name, size = 18 }: { name: Name; size?: number }) {
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
