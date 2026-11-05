export const games = [
  { id: 'blocks', title: '블록 퍼즐' },
  { id: 'snake', title: '스네이크' },
  { id: 'tiles', title: '2048' },
  { id: 'mines', title: '지뢰찾기' },
  { id: 'snack', title: '닥스의 간식 타임' },
  { id: 'adventure', title: '닥스의 모험' },
  { id: 'survivor', title: '닥스의 서바이버' },
] as const;

export type GameId = (typeof games)[number]['id'];
