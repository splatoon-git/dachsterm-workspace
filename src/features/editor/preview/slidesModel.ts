// A presentation as an outline: each slide's title, text, tables and pictures in the order the file
// stores them. Positions, themes and animations are not read, so this is not how the slide looks.
import {
  all,
  child,
  children,
  openPackage,
  partXml,
  relationAttribute,
  relationships,
  type Package,
} from './officeXml';

export type SlideBlock =
  | { kind: 'text'; level: number; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'image'; source: string; label: string };

export type Slide = { title: string; blocks: SlideBlock[] };

/** Pictures a web view draws. Vector formats of older office programs are left out. */
const pictureTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
};
const pictureLimit = 8 * 1024 * 1024;
/** Pictures of the whole presentation together, so a deck of photos cannot fill the memory. */
const picturesLimit = 64 * 1024 * 1024;

/** One paragraph's text. A line break inside it is a new line, and a tab stays a tab. */
function paragraphText(paragraph: Element) {
  let text = '';
  for (const node of Array.from(paragraph.children)) {
    if (node.localName === 'r' || node.localName === 'fld')
      text += child(node, 't')?.textContent ?? '';
    else if (node.localName === 'br') text += '\n';
  }
  return text;
}

const levelOf = (paragraph: Element) =>
  Number(child(paragraph, 'pPr')?.getAttribute('lvl') ?? 0) || 0;

const isTitle = (shape: Element) =>
  ['title', 'ctrTitle'].includes(all(shape, 'ph')[0]?.getAttribute('type') ?? '');

function tableRows(table: Element) {
  return children(table, 'tr').map((row) =>
    children(row, 'tc').map((cell) => all(cell, 'p').map(paragraphText).filter(Boolean).join('\n')),
  );
}

/** A slide's own content, in file order, with pictures named by their relationship id. */
export function slideContent(xml: Document) {
  const tree = all(xml, 'spTree')[0];
  const blocks: (SlideBlock | { kind: 'picture'; id: string; label: string })[] = [];
  let title = '';
  const visit = (group: Element) => {
    for (const shape of Array.from(group.children)) {
      if (shape.localName === 'grpSp') visit(shape);
      else if (shape.localName === 'pic') {
        const blip = all(shape, 'blip')[0];
        const id = blip && relationAttribute(blip, 'embed');
        const label = all(shape, 'cNvPr')[0]?.getAttribute('descr') ?? '';
        if (id) blocks.push({ kind: 'picture', id, label });
      } else if (shape.localName === 'graphicFrame') {
        for (const table of all(shape, 'tbl'))
          blocks.push({ kind: 'table', rows: tableRows(table) });
      } else if (shape.localName === 'sp') {
        const body = child(shape, 'txBody');
        const lines = (body ? children(body, 'p') : [])
          .map((paragraph) => ({ level: levelOf(paragraph), text: paragraphText(paragraph) }))
          .filter((line) => line.text.trim());
        if (isTitle(shape) && !title) title = lines.map((line) => line.text).join(' ');
        else blocks.push(...lines.map((line) => ({ kind: 'text' as const, ...line })));
      }
    }
  };
  if (tree) visit(tree);
  return { title, blocks };
}

const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

async function slideOf(source: Package, part: string, budget: { left: number }): Promise<Slide> {
  const xml = await partXml(source, part);
  if (!xml)
    return {
      title: '',
      blocks: [{ kind: 'text', level: 0, text: '이 슬라이드는 읽지 못했습니다.' }],
    };
  const { title, blocks } = slideContent(xml);
  const relations = await relationships(source, part);
  const shown: SlideBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== 'picture') {
      shown.push(block);
      continue;
    }
    const target = relations.get(block.id)?.target ?? '';
    const type = pictureTypes[target.split('.').pop()?.toLowerCase() ?? ''];
    const size = source.sizes.get(target) ?? Infinity;
    const file = source.zip.file(target);
    if (!type || !file || size > pictureLimit || size > budget.left) continue;
    budget.left -= size;
    shown.push({
      kind: 'image',
      source: `data:${type};base64,${base64(await file.async('uint8array'))}`,
      label: block.label,
    });
  }
  return { title, blocks: shown };
}

export async function readSlides(bytes: Uint8Array): Promise<Slide[]> {
  const source = await openPackage(bytes);
  const part = 'ppt/presentation.xml';
  const presentation = await partXml(source, part);
  if (!presentation) throw new Error('no presentation');
  const relations = await relationships(source, part);
  const budget = { left: picturesLimit };
  const slides: Slide[] = [];
  for (const entry of all(presentation, 'sldId')) {
    const relation = relations.get(relationAttribute(entry, 'id') ?? '');
    if (relation) slides.push(await slideOf(source, relation.target, budget));
  }
  if (!slides.length) throw new Error('no slides');
  return slides;
}
