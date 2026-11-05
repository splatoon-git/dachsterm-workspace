/** Unsigned seeds, including zero, are valid. No wall-clock or global random state. */
export function seedStreams(seed: number) {
  const mix = (salt: number) => {
    let n = (seed ^ salt) >>> 0;
    n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
    n = Math.imul(n ^ (n >>> 15), 0x735a2d97);
    return (n ^ (n >>> 15)) >>> 0 || salt;
  };
  return { spawn: mix(0x9e3779b9), drops: mix(0x243f6a88), cards: mix(0xb7e15162) };
}

export function nextRandom(state: number): { state: number; value: number } {
  let n = state;
  n ^= n << 13;
  n ^= n >>> 17;
  n ^= n << 5;
  return { state: n >>> 0, value: (n >>> 0) / 0x100000000 };
}
