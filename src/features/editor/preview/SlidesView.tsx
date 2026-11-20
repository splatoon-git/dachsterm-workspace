import { useEffect, useState, type CSSProperties } from 'react';
import { FileTabBar } from '../TextDocument';
import { readSlides, type Slide, type SlideBlock } from './slidesModel';
import type { ViewerProps } from './viewer';
import './preview.css';

function Block({ block }: { block: SlideBlock }) {
  if (block.kind === 'image') return <img src={block.source} alt={block.label} loading="lazy" />;
  if (block.kind === 'table')
    return (
      <table className="preview-slide-table">
        <tbody>
          {block.rows.map((row, at) => (
            <tr key={at}>
              {row.map((cell, column) => (
                <td key={column}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  return (
    <p className="preview-slide-line" style={{ '--slide-level': block.level } as CSSProperties}>
      {block.text}
    </p>
  );
}

/** A presentation's text and pictures, slide by slide. It does not lay a slide out as designed. */
export default function SlidesView({ bytes, path, actions, fail }: ViewerProps) {
  const [slides, setSlides] = useState<Slide[] | null>(null);
  useEffect(() => {
    let alive = true;
    readSlides(bytes).then(
      (read) => {
        if (alive) setSlides(read);
      },
      () => {
        if (alive)
          fail('프레젠테이션을 읽지 못했습니다. 암호가 걸렸거나 손상된 파일일 수 있습니다.');
      },
    );
    return () => {
      alive = false;
    };
  }, [bytes, fail]);
  if (!slides)
    return (
      <div className="editor-loading" role="status">
        프레젠테이션을 여는 중…
      </div>
    );
  return (
    <>
      <FileTabBar path={path}>
        <span className="preview-count">슬라이드 {slides.length}장 · 글과 그림만 표시</span>
        {actions}
      </FileTabBar>
      <div className="preview-flow preview-slides">
        {slides.map((slide, index) => (
          <section key={index} className="preview-slide" aria-label={`슬라이드 ${index + 1}`}>
            <header>
              <span className="preview-slide-number">{index + 1}</span>
              <h3>{slide.title || '제목 없음'}</h3>
            </header>
            {slide.blocks.map((block, at) => (
              <Block key={at} block={block} />
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
