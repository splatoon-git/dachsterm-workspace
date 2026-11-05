export type Snippet = {
  id: string;
  name: string;
  description: string;
  body: string;
  group: string;
  tags: string;
};
export type Library = { revision: number; items: Snippet[] };
export const emptySnippet = (): Snippet => ({
  id: crypto.randomUUID(),
  name: '',
  description: '',
  body: '',
  group: '',
  tags: '',
});
export function variables(body: string): string[] {
  return [...new Set(Array.from(body.matchAll(/\{\{([\p{L}\p{N}_-]{1,40})\}\}/gu), (m) => m[1]))];
}
export function expand(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{([\p{L}\p{N}_-]{1,40})\}\}/gu, (_, name: string) => {
    if (!Object.hasOwn(values, name) || !values[name])
      throw new Error(`자리표시자 ${name} 값을 입력하세요.`);
    return values[name];
  });
}
export function matchesSnippet(s: Snippet, query: string) {
  const text = [s.name, s.description, s.body, s.group, s.tags].join(' ').toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .every((part) => text.includes(part));
}
