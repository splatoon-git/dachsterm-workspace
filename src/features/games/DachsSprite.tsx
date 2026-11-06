import atlas from '../../assets/brand/dachshund-adventure-atlas.png';

/** The shared G.4 atlas: idle, two run strides, jump, bite, hurt. */
export function DachsSprite({ frame, className = '' }: { frame: number; className?: string }) {
  return (
    <svg
      className={`dachs-sprite ${className}`}
      aria-hidden="true"
      x="-55"
      y="-84"
      width="110"
      height="110"
      viewBox={`${(frame % 3) * 512} ${Math.floor(frame / 3) * 512} 512 512`}
      overflow="hidden"
    >
      <image className="dachs-mascot" href={atlas} width="1536" height="1024" />
    </svg>
  );
}
