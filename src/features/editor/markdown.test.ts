// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

function render(text: string) {
  const host = document.createElement('div');
  host.append(renderMarkdown(text));
  return host;
}

describe('renderMarkdown', () => {
  it('renders ordinary Markdown', () => {
    const host = render('# 제목\n\n**굵게** `code`\n\n- 항목\n\n| a |\n|---|\n| b |\n');
    expect(host.querySelector('h1')?.textContent).toBe('제목');
    expect(host.querySelector('strong')?.textContent).toBe('굵게');
    expect(host.querySelector('code')?.textContent).toBe('code');
    expect(host.querySelector('li')?.textContent).toBe('항목');
    expect(host.querySelector('td')?.textContent).toBe('b');
  });

  it.each([
    ['<script>alert(1)</script>', 'script'],
    ['<iframe src="https://x.test"></iframe>', 'iframe'],
    ['<object data="x"></object>', 'object'],
    ['<embed src="x">', 'embed'],
    ['<style>body{display:none}</style>', 'style'],
    ['<form action="https://x.test"><input name="a"></form>', 'form'],
    ['<svg onload="alert(1)"><circle /></svg>', 'svg'],
    ['<link rel="stylesheet" href="https://x.test/a.css">', 'link'],
    ['<meta http-equiv="refresh" content="0;url=https://x.test">', 'meta'],
    ['<base href="https://x.test/">', 'base'],
    ['<video src="https://x.test/a.mp4"></video>', 'video'],
  ])('removes %s', (html, selector) => {
    expect(render(html).querySelector(selector)).toBeNull();
  });

  it('removes event handlers and styles', () => {
    const host = render(
      '<p onclick="alert(1)" style="position:fixed" class="sidebar" id="x">a</p>',
    );
    const paragraph = host.querySelector('p')!;
    expect(paragraph.getAttributeNames()).toEqual([]);
    expect(paragraph.textContent).toBe('a');
  });

  it('does not let a link point at script', () => {
    const host = render('[x](javascript:alert(1))\n\n<a href="vbscript:x">y</a>');
    expect(host.querySelector('[href]')).toBeNull();
    expect(host.querySelector('[data-external]')).toBeNull();
  });

  it('marks web links to ask before opening, and removes the address the page could follow', () => {
    const host = render('[x](https://example.com/a) [m](mailto:a@example.com)');
    const links = host.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('data-external')).toBe('https://example.com/a');
    expect(links[1].getAttribute('data-external')).toBe('mailto:a@example.com');
    for (const link of links) {
      expect(link.hasAttribute('href')).toBe(false);
      expect(link.getAttribute('role')).toBe('link');
      expect(link.getAttribute('tabindex')).toBe('0');
    }
  });

  it('drops the target of a link inside the file', () => {
    const anchor = render('[x](#part)').querySelector('a')!;
    expect(anchor.hasAttribute('href')).toBe(false);
    expect(anchor.hasAttribute('data-external')).toBe(false);
  });

  it('never loads a remote image', () => {
    const host = render('![그림](https://example.com/a.png)');
    expect(host.querySelector('img')).toBeNull();
    const blocked = host.querySelector('.markdown-image-blocked')!;
    expect(blocked.textContent).toContain('그림');
    expect(blocked.getAttribute('data-external')).toBe('https://example.com/a.png');
  });

  it('shows an embedded image and refuses the rest', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo=';
    expect(render(`![a](${data})`).querySelector('img')?.getAttribute('src')).toBe(data);
    const relative = render('![b](./pic.png)');
    expect(relative.querySelector('img')).toBeNull();
    expect(relative.querySelector('.markdown-image-blocked')?.textContent).toContain('b');
    expect(relative.querySelector('[data-external]')).toBeNull();
  });

  it('keeps task lists but makes them read-only', () => {
    const box = render('- [x] 끝').querySelector('input')!;
    expect(box.type).toBe('checkbox');
    expect(box.disabled).toBe(true);
    expect(render('<input type="text" value="a">').querySelector('input')).toBeNull();
  });

  it('removes the srcset that would fetch despite the blocked src', () => {
    const host = render('<img src="data:image/png;base64,AA==" srcset="https://x.test/a.png 2x">');
    expect(host.querySelector('img')?.hasAttribute('srcset')).toBe(false);
  });
});
