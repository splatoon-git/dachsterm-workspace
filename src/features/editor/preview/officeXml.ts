// Reading the XML parts of an office package. Prefixes differ between the programs that write
// these files, so elements are matched by local name only.
import JSZip from 'jszip';
import { declaredSizes, unpackLimits } from './zipEntries';

export type Package = { zip: JSZip; sizes: Map<string, number> };

export async function openPackage(bytes: Uint8Array): Promise<Package> {
  const sizes = declaredSizes(bytes);
  if (!sizes) throw new Error('not a package');
  return { zip: await JSZip.loadAsync(bytes), sizes };
}

/** A part as text, or null when it is missing or too large to read as one string. */
export async function partText({ zip, sizes }: Package, name: string) {
  const file = zip.file(name);
  if (!file || (sizes.get(name) ?? 0) > unpackLimits.part) return null;
  return file.async('string');
}

export function parseXml(text: string | null) {
  if (text === null) return null;
  const parsed = new DOMParser().parseFromString(text, 'application/xml');
  return parsed.getElementsByTagName('parsererror').length ? null : parsed;
}

export async function partXml(source: Package, name: string) {
  return parseXml(await partText(source, name));
}

export const all = (node: Document | Element, name: string) =>
  Array.from(node.getElementsByTagNameNS('*', name));

export const children = (node: Element, name: string) =>
  Array.from(node.children).filter((child) => child.localName === name);

export const child = (node: Element, name: string) =>
  children(node, name)[0] as Element | undefined;

/** An attribute of the relationships namespace, such as `r:id` or `r:embed`, whatever its prefix. */
export function relationAttribute(node: Element, name: string) {
  for (const attribute of Array.from(node.attributes))
    if (attribute.localName === name && attribute.namespaceURI?.includes('relationships'))
      return attribute.value;
  return null;
}

/** The folder a part is in, with its trailing slash. */
const folderOf = (part: string) => part.slice(0, part.lastIndexOf('/') + 1);

/** A relationship target as a path inside the package. Targets are relative to the part's folder. */
export function resolveTarget(part: string, target: string) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = folderOf(part).split('/').filter(Boolean);
  for (const step of target.split('/')) {
    if (step === '..') parts.pop();
    else if (step && step !== '.') parts.push(step);
  }
  return parts.join('/');
}

/** A part's relationships by id, as paths inside the package. External links are left out. */
export async function relationships(source: Package, part: string) {
  const at = part.lastIndexOf('/') + 1;
  const xml = await partXml(source, `${part.slice(0, at)}_rels/${part.slice(at)}.rels`);
  const found = new Map<string, { target: string; type: string }>();
  if (!xml) return found;
  for (const relation of all(xml, 'Relationship')) {
    const id = relation.getAttribute('Id');
    const target = relation.getAttribute('Target');
    if (!id || !target || relation.getAttribute('TargetMode') === 'External') continue;
    found.set(id, {
      target: resolveTarget(part, target),
      type: (relation.getAttribute('Type') ?? '').split('/').pop() ?? '',
    });
  }
  return found;
}
