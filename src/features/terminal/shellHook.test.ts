import { describe, expect, it } from 'vitest';
import { autoGuidePrograms, shellHook } from './shellHook';

describe('shell hook', () => {
  it('keeps each shell part inside one single-quoted eval', () => {
    // A single quote inside a part would end its eval early and run the rest as typed text.
    for (const guide of [true, false]) expect(shellHook({ guide }).match(/'/g)).toHaveLength(4);
  });

  it('adds program notices only when the guide is on', () => {
    const off = shellHook({ guide: false });
    expect(off).toContain('__dachsterm_cwd');
    expect(off).not.toContain('__dachsterm_run');
    expect(off).not.toContain('preexec_functions');
    const on = shellHook({ guide: true });
    expect(on).toContain('for __dachsterm_p in vi vim less tail;');
    expect(on).toContain('case $w in vi|vim|less|tail)');
    expect(autoGuidePrograms).not.toContain('cat');
  });

  it('wraps only plain programs, so an alias or a function keeps its name', () => {
    expect(shellHook({ guide: true })).toContain('if [ "$(type -t $__dachsterm_p)" = file ]');
  });

  it('sends a program name and nothing the user typed', () => {
    const notices = shellHook({ guide: true }).match(/printf "[^"]*DachsTerm;[^"]*"[^;]*/g);
    expect(notices).toEqual([
      'printf "\\033]777;DachsTerm;end\\007"',
      'printf "\\033]777;DachsTerm;program;%s\\007" "$p"',
      'printf "\\033]777;DachsTerm;end\\007"',
      'printf "\\033]777;DachsTerm;program;%s\\007" $w',
    ]);
  });
});
