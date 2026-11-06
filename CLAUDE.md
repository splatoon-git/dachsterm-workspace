# CLAUDE.md

프로젝트 지침의 정본은 `AGENTS.md`다. Codex도 같은 내용을 읽어야 하므로 프로젝트 내용은 여기가 아니라 `AGENTS.md`에 추가한다.

@AGENTS.md
@docs/engineering-rules.md

## Claude Code 전용

- 규칙을 `.claude/rules/`로 나누지 않는다. Codex가 읽지 못해 두 도구의 기준이 갈라진다. 규칙은 `docs/engineering-rules.md`에 둔다.
- 스킬은 `.agents/skills/`에 작성하고 `.claude/skills/<이름>/SKILL.md`에는 정본을 가리키는 포인터만 둔다.
