import type { CSSProperties } from 'react';
export function ResizeHandle({
  value,
  min,
  max,
  onChange,
  label,
  reverse = false,
  horizontal = false,
  style,
  className = '',
  onReset,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  reverse?: boolean;
  horizontal?: boolean;
  style?: CSSProperties;
  className?: string;
  /** Double click: return to the default size. */
  onReset?: () => void;
}) {
  return (
    <div
      className={`resize-handle ${horizontal ? 'horizontal' : ''} ${className}`}
      style={style}
      onDoubleClick={onReset}
      role="separator"
      aria-label={label}
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={(e) => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          onChange(
            Math.max(
              min,
              Math.min(max, value + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -10 : 10)),
            ),
          );
        }
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const start = horizontal ? e.clientY : e.clientX;
        const target = e.currentTarget;
        const move = (event: PointerEvent) =>
          onChange(
            Math.max(
              min,
              Math.min(
                max,
                value + ((horizontal ? event.clientY : event.clientX) - start) * (reverse ? -1 : 1),
              ),
            ),
          );
        const end = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', end);
          target.removeEventListener('pointercancel', end);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', end);
        target.addEventListener('pointercancel', end);
      }}
    />
  );
}
