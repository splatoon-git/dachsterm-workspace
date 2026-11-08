/**
 * The session-only hook typed into Bash and Zsh. No dotfiles or server settings are written, and
 * nothing the user types, no command argument and no history ever leaves the shell: the guide part
 * only names a program from the list below when it starts and says when it ends.
 */

/** Programs whose guide appears on its own. `cat` ends at once, so it stays a manual pick. */
export const autoGuidePrograms = ['vi', 'vim', 'less', 'tail'] as const;
const names = autoGuidePrograms.join(' ');
const pattern = autoGuidePrograms.join('|');
const programStart = String.raw`printf "\033]777;DachsTerm;program;%s\007"`;
const programEnd = String.raw`printf "\033]777;DachsTerm;end\007"`;
const reportDirectory = String.raw`printf "\033]1337;CurrentDir=%s\007" "$PWD"`;
// OSC 133 command boundaries: the last exit code, then a new prompt. Only the code leaves the shell.
const commandEnd = String.raw`printf "\033]133;D;%s\007" "$s"`;
const promptStart = String.raw`printf "\033]133;A\007"`;

// Bash 3.2 (macOS) must parse every part. A scalar PROMPT_COMMAND is prepended, because Bash before
// 5.1 runs only element 0 of an array and a scalar may end in ";". The prompt function keeps $? for
// the commands after it, and Bash drops the line from its history. Everything sits in one
// single-quoted eval, so no part may contain a single quote.
const bashEnd = `__dachsterm_end() { if [ -n "$__dachsterm_prog" ]; then unset __dachsterm_prog; ${programEnd}; fi; }`;
const bashPrompt = `__dachsterm_cwd() { local s=$?; __dachsterm_end; ${commandEnd}; ${reportDirectory}; ${promptStart}; return $s; }`;
// Bash 4.4+ prints PS0 when a command starts and never for an empty line. Bash 3.2 ignores it, and
// the app takes the Enter typed at the prompt instead.
const bashCommandStart = String.raw`case "$PS0" in *133*) ;; *) PS0="\e]133;C\a$PS0";; esac`;
const bashPromptCommand = `case ";\${PROMPT_COMMAND[*]};" in *__dachsterm_cwd*) ;; *) if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then PROMPT_COMMAND+=(__dachsterm_cwd); else PROMPT_COMMAND="__dachsterm_cwd\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi;; esac`;
// A wrapper only replaces a plain program on PATH. An alias or a function the user made keeps
// working for that name alone, and a program that is not installed is left alone. Ctrl+C stops
// the wrapper before it says the program ended, so the prompt says it instead.
const bashGuide = [
  `__dachsterm_run() { local p=$1 r=0; shift; if [ -t 0 ] && [ -t 1 ]; then __dachsterm_prog=1; ${programStart} "$p"; fi; command "$p" "$@" || r=$?; __dachsterm_end; return $r; }`,
  String.raw`for __dachsterm_p in ${names}; do if [ "$(type -t $__dachsterm_p)" = file ]; then eval "$__dachsterm_p() { __dachsterm_run $__dachsterm_p \"\$@\"; }"; fi; done; unset __dachsterm_p`,
];
const bashHistory = String.raw`case "$(HISTTIMEFORMAT= builtin history 1)" in *__dachsterm_cwd*) builtin history -d "$(HISTTIMEFORMAT= builtin history 1 | { read -r n _; printf %s "$n"; })";; esac`;

// Zsh compares only the first word of the line with the list. `sudo vim` or `command vim` start
// with another word and get the general full-screen notice instead, and so does a pipeline, which
// the Bash wrapper also leaves out.
const zshEnd = `__dachsterm_end() { if [[ -n $__dachsterm_prog ]]; then unset __dachsterm_prog; ${programEnd}; fi }`;
// Zsh restores $? for each precmd function, so this sees the command's code wherever it runs.
const zshPrompt = `__dachsterm_cwd() { local s=$?; __dachsterm_end; ${commandEnd}; ${reportDirectory}; ${promptStart}; }`;
const zshPrecmd = `(( \${precmd_functions[(Ie)__dachsterm_cwd]} )) || precmd_functions+=(__dachsterm_cwd)`;
// Zsh runs preexec only for a command, never for an empty line.
const zshCommandStart = [
  String.raw`__dachsterm_start() { printf "\033]133;C\007"; }`,
  `(( \${preexec_functions[(Ie)__dachsterm_start]} )) || preexec_functions+=(__dachsterm_start)`,
];
const zshGuide = [
  `__dachsterm_pre() { [[ $1 == *\\|* ]] && return; local w=\${\${(z)1}[1]}; case $w in ${pattern}) if [[ -t 0 && -t 1 ]]; then __dachsterm_prog=1; ${programStart} $w; fi;; esac }`,
  `(( \${preexec_functions[(Ie)__dachsterm_pre]} )) || preexec_functions+=(__dachsterm_pre)`,
];

/**
 * The hook text for one line of input. `guide` adds the program notices to the folder reports.
 * `git` is the backend's line that hands the connection's HTTPS Git helper to this shell. It
 * holds single quotes, so it stays outside the evals.
 */
export function shellHook({ guide, git }: { guide: boolean; git?: string }) {
  const bash = [
    bashEnd,
    bashPrompt,
    bashPromptCommand,
    bashCommandStart,
    ...(guide ? bashGuide : []),
    bashHistory,
  ];
  const zsh = [zshEnd, zshPrompt, zshPrecmd, ...zshCommandStart, ...(guide ? zshGuide : [])];
  const hook = `if [ -n "$BASH_VERSION" ]; then eval '${bash.join('; ')}'; elif [ -n "$ZSH_VERSION" ]; then eval '${zsh.join('; ')}'; fi`;
  return git ? `${git}; ${hook}` : hook;
}
