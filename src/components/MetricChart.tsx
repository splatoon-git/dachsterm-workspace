/** A line of recent samples. A `null` sample leaves a gap instead of joining its neighbours. */
export function MetricChart({
  values,
  label,
  unit,
  max,
  color,
}: {
  values: (number | null)[];
  label: string;
  unit: string;
  max: number;
  color: number;
}) {
  const points = values.map((n, i) =>
    n === null
      ? null
      : `${(i * 300) / Math.max(1, values.length - 1)},${68 - Math.min(1, n / Math.max(1, max)) * 60}`,
  );
  const segments: string[] = [];
  let current: string[] = [];
  for (const p of points) {
    if (p === null) {
      if (current.length) segments.push(current.join(' '));
      current = [];
    } else current.push(p);
  }
  if (current.length) segments.push(current.join(' '));
  return (
    <div className="metric-chart">
      <div>
        <span>{label}</span>
        <strong>{values.at(-1) == null ? '측정 중' : `${values.at(-1)!.toFixed(1)}${unit}`}</strong>
      </div>
      <svg
        viewBox="0 0 300 80"
        role="img"
        aria-label={`${label} 최근 ${values.length}개 샘플`}
        preserveAspectRatio="none"
      >
        <path
          d="M0 8H300 M0 38H300 M0 68H300"
          stroke="var(--chart-grid)"
          fill="none"
          strokeWidth=".5"
        />
        {segments.map((p, i) => (
          <polyline
            key={i}
            points={p}
            fill="none"
            stroke={`var(--chart-series-${color})`}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}
