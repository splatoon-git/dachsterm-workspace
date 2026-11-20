// @vitest-environment jsdom
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseXml, resolveTarget } from './officeXml';
import { readSlides, slideContent } from './slidesModel';

const spaces =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const slide = (shapes: string) =>
  `<p:sld ${spaces}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
const shape = (paragraphs: string, placeholder = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs}</p:txBody></p:sp>`;
const line = (text: string, level = 0) =>
  `<a:p><a:pPr lvl="${level}"/><a:r><a:t>${text}</a:t></a:r></a:p>`;
const picture = (id: string, description: string) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="4" name="그림" descr="${description}"/></p:nvPicPr><p:blipFill><a:blip r:embed="${id}"/></p:blipFill></p:pic>`;
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (letter) => letter.charCodeAt(0),
);
const titled = '<p:ph type="title"/>';

describe('paths inside a package', () => {
  it('resolves a relationship target from the part that names it', () => {
    expect(resolveTarget('ppt/slides/slide1.xml', '../media/image1.png')).toBe(
      'ppt/media/image1.png',
    );
    expect(resolveTarget('ppt/presentation.xml', 'slides/slide1.xml')).toBe(
      'ppt/slides/slide1.xml',
    );
    expect(resolveTarget('xl/workbook.xml', '/xl/worksheets/sheet1.xml')).toBe(
      'xl/worksheets/sheet1.xml',
    );
    // A target cannot climb out of the package.
    expect(resolveTarget('a.xml', '../../etc/passwd')).toBe('etc/passwd');
  });
});

describe('one slide', () => {
  it('takes the title from its placeholder and keeps the rest in file order', () => {
    const table =
      '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody>' +
      line('항목') +
      '</a:txBody></a:tc><a:tc><a:txBody>' +
      line('값') +
      line('둘째 줄') +
      '</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
    const xml = parseXml(
      slide(
        shape(line('분기 보고'), titled) +
          shape(line('매출 증가') + line('국내 12%', 1) + '<a:p><a:endParaRPr/></a:p>') +
          picture('rId2', '매출 그래프') +
          table,
      ),
    )!;
    expect(slideContent(xml)).toEqual({
      title: '분기 보고',
      blocks: [
        { kind: 'text', level: 0, text: '매출 증가' },
        { kind: 'text', level: 1, text: '국내 12%' },
        { kind: 'picture', id: 'rId2', label: '매출 그래프' },
        { kind: 'table', rows: [['항목', '값\n둘째 줄']] },
      ],
    });
  });

  it('reads shapes inside a group, line breaks and fields', () => {
    const paragraph =
      '<a:p><a:r><a:t>첫 줄</a:t></a:r><a:br/><a:r><a:t>둘째 줄</a:t></a:r>' +
      '<a:fld type="slidenum"><a:t>7</a:t></a:fld></a:p>';
    const xml = parseXml(slide(`<p:grpSp>${shape(paragraph)}</p:grpSp>`))!;
    expect(slideContent(xml)).toEqual({
      title: '',
      blocks: [{ kind: 'text', level: 0, text: '첫 줄\n둘째 줄7' }],
    });
  });

  it('keeps a second title placeholder as text', () => {
    const centered = '<p:ph type="ctrTitle"/>';
    const xml = parseXml(slide(shape(line('하나'), centered) + shape(line('둘'), centered)))!;
    expect(slideContent(xml)).toEqual({
      title: '하나',
      blocks: [{ kind: 'text', level: 0, text: '둘' }],
    });
  });
});

describe('a whole presentation', () => {
  const rels = (items: string) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
  const type = (name: string) =>
    `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${name}`;

  it('follows the slide order of the presentation, not the file names', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/presentation.xml',
      `<p:presentation ${spaces}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      rels(
        `<Relationship Id="rId2" Type="${type('slide')}" Target="slides/slide1.xml"/>` +
          `<Relationship Id="rId3" Type="${type('slide')}" Target="slides/slide2.xml"/>`,
      ),
    );
    zip.file('ppt/slides/slide1.xml', slide(shape(line('둘째'), titled)));
    zip.file(
      'ppt/slides/slide2.xml',
      slide(
        shape(line('첫째'), titled) +
          picture('rId1', '점') +
          picture('rId2', '벡터') +
          picture('rId9', '없음'),
      ),
    );
    zip.file(
      'ppt/slides/_rels/slide2.xml.rels',
      rels(
        `<Relationship Id="rId1" Type="${type('image')}" Target="../media/image1.png"/>` +
          `<Relationship Id="rId2" Type="${type('image')}" Target="../media/image2.emf"/>` +
          `<Relationship Id="rId3" Type="${type('hyperlink')}" Target="https://example.com" TargetMode="External"/>`,
      ),
    );
    zip.file('ppt/media/image1.png', png);
    zip.file('ppt/media/image2.emf', new Uint8Array([1, 2, 3]));
    const slides = await readSlides(await zip.generateAsync({ type: 'uint8array' }));
    expect(slides.map((item) => item.title)).toEqual(['첫째', '둘째']);
    // A vector picture and a missing one are left out; the rest of the slide is still shown.
    expect(slides[0].blocks).toEqual([
      {
        kind: 'image',
        label: '점',
        source: expect.stringMatching(/^data:image\/png;base64,iVBOR/),
      },
    ]);
  });

  it('refuses what is not a presentation', async () => {
    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<a/>');
    await expect(readSlides(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow();
  });
});
