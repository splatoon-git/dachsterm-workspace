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
    expect(off).not.toContain('__dachsterm_pre()');
    const on = shellHook({ guide: true });
    expect(on).toContain('for __dachsterm_p in vi vim less tail;');
    expect(on).toContain('case $w in vi|vim|less|tail)');
    expect(autoGuidePrograms).not.toContain('cat');
  });

  it('wraps only plain programs, so an alias or a function keeps its name', () => {
    expect(shellHook({ guide: true })).toContain('if [ "$(type -t $__dachsterm_p)" = file ]');
  });

  it('marks command boundaries with the exit code only', () => {
    for (const guide of [true, false]) {
      const hook = shellHook({ guide });
      // Bash and Zsh: the code and a new prompt at every prompt, after the program end notice.
      expect(
        hook.match(/__dachsterm_end; printf "\\033]133;D;%s\\007" "\$s"; printf/g),
      ).toHaveLength(2);
      expect(hook.match(/printf "\\033]133;A\\007"/g)).toHaveLength(2);
      // Command starts: Bash 4.4+ through PS0, added once; Zsh through preexec.
      expect(hook).toContain('case "$PS0" in *133*) ;; *) PS0="\\e]133;C\\a$PS0";; esac');
      expect(hook).toContain('preexec_functions+=(__dachsterm_start)');
      expect(hook).toContain('__dachsterm_start() { printf "\\033]133;C\\007"; }');
    }
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
