// Turns Markdown from a file into nodes that are safe to show. Everything is built as DOM and never
// parsed again after sanitizing, so nothing can change meaning on the way to the screen.
import DOMPurify, { type Config } from 'dompurify';
import { marked } from 'marked';

const SAFE_LINK = /^(https?:|mailto:)/i;
const REMOTE_IMAGE = /^https?:/i;
const EMBEDDED_IMAGE = /^data:image\//i;

const options: Config & { RETURN_DOM_FRAGMENT: true } = {
  USE_PROFILES: { html: true },
  // Forms and media can act or fetch on their own. Style and class could dress a document up as
  // the app's own controls.
  FORBID_TAGS: ['style', 'form', 'button', 'select', 'textarea', 'video', 'audio', 'source'],
  FORBID_ATTR: ['style', 'class', 'id', 'name', 'srcset', 'target', 'ping'],
  RETURN_DOM_FRAGMENT: true,
};

function placeholder(label: string, url?: string) {
  const element = document.createElement(url ? 'a' : 'span');
  element.className = 'markdown-image-blocked';
  element.textContent = label;
  if (url) markExternal(element, url);
  return element;
}

/** Links are opened by the preview after asking, so the page itself never navigates. */
function markExternal(element: Element, url: string) {
  element.setAttribute('data-external', url);
  element.setAttribute('role', 'link');
  element.setAttribute('tabindex', '0');
}

function blockImages(root: DocumentFragment) {
  for (const image of Array.from(root.querySelectorAll('img'))) {
    const source = image.getAttribute('src') ?? '';
    if (EMBEDDED_IMAGE.test(source)) continue;
    const alt = image.getAttribute('alt') ?? '';
    image.replaceWith(
      REMOTE_IMAGE.test(source)
        ? placeholder(`원격 이미지 · ${alt || source}`, source)
        : placeholder(`표시하지 않은 이미지 · ${alt || source}`),
    );
  }
}

function neutralizeLinks(root: DocumentFragment) {
  for (const link of Array.from(root.querySelectorAll('a[href]'))) {
    const href = link.getAttribute('href') ?? '';
    link.removeAttribute('href');
    if (SAFE_LINK.test(href)) markExternal(link, href);
  }
}

function disableCheckboxes(root: DocumentFragment) {
  for (const input of Array.from(root.querySelectorAll('input'))) {
    if (input.type === 'checkbox') input.setAttribute('disabled', '');
    else input.remove();
  }
}

export function renderMarkdown(text: string): DocumentFragment {
  const html = marked.parse(text, { async: false, gfm: true }) as string;
  const root = DOMPurify.sanitize(html, options);
  blockImages(root);
  neutralizeLinks(root);
  disableCheckboxes(root);
  return root;
}
