import { UserError } from '../../lib/ipc';
import { commands, type CommandExample } from './guideData';
import { matchesSnippet, type Snippet } from './snippets';

/** The parts of a basic command that the user replaces, highlighted and turned into variables. */
export const placeholders = /(파일명|프로그램명|검색어|제외어|문구1|문구2|경로|원본|대상|호스트)/g;

/** A basic command as a snippet body: each part to replace becomes a {{variable}}. */
export const snippetBody = (command: string) => command.replace(placeholders, '{{$1}}');

export type Section<T> = { title: string; items: T[] };

/** Items under their group, in the order the groups first appear. */
function bySection<T>(items: T[], title: (item: T) => string): Section<T>[] {
  const sections: Section<T>[] = [];
  for (const item of items) {
    const name = title(item);
    const section = sections.find((s) => s.title === name);
    if (section) section.items.push(item);
    else sections.push({ title: name, items: [item] });
  }
  return sections;
}

export const NO_GROUP = '그룹 없음';

/** Saved snippets that match the search, grouped and sorted by group and then name. */
export function snippetSections(items: Snippet[], query: string): Section<Snippet>[] {
  const sorted = items
    .filter((s) => matchesSnippet(s, query))
    .sort(
      (a, b) =>
        Number(!a.group) - Number(!b.group) ||
        a.group.localeCompare(b.group) ||
        a.name.localeCompare(b.name),
    );
  return bySection(sorted, (s) => s.group.trim() || NO_GROUP);
}

/** Basic commands that match every word of the search, under their category. */
export function basicSections(query: string): Section<CommandExample>[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/);
  return bySection(
    commands.filter((c) => {
      const text = `${c.group} ${c.title} ${c.command} ${c.note ?? ''}`.toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    }),
    (c) => c.group,
  );
}

/** What a snippet sends once every variable has a value, checked against the send limits. */
export function checkedBody(body: string): string {
  if (!body.trim() || new TextEncoder().encode(body).length > 16384)
    throw new UserError('명령은 비어 있지 않은 16KiB 이하 본문이어야 합니다.');
  if (
    Array.from(body).some(
      (c) => (c.charCodeAt(0) < 32 && !'\t\n\r'.includes(c)) || c.charCodeAt(0) === 127,
    )
  )
    throw new UserError('Tab·줄바꿈 이외 제어문자는 보낼 수 없습니다.');
  return body;
}

export type BodyPart = { text: string; variable?: string; filled?: boolean };
/**
 * A snippet body cut into text and variables for the preview, with each variable shown as its
 * value when one was typed and as its name otherwise.
 */
export function previewParts(body: string, values: Record<string, string>): BodyPart[] {
  const parts: BodyPart[] = [];
  let last = 0;
  for (const match of body.matchAll(/\{\{([\p{L}\p{N}_-]{1,40})\}\}/gu)) {
    if (match.index > last) parts.push({ text: body.slice(last, match.index) });
    const value = values[match[1]];
    parts.push({ text: value || match[1], variable: match[1], filled: !!value });
    last = match.index + match[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}
