const W = 300
const H = 64

/** Mini grafico dos ultimos 60 s (um balde por segundo), em SVG. */
export function Sparkline({ buckets }: { buckets: number[] }) {
  const max = Math.max(4, ...buckets)
  const pts = buckets.map(
    (v, i) => `${((i / (buckets.length - 1)) * W).toFixed(1)},${(H - 4 - (v / max) * (H - 10)).toFixed(1)}`,
  )
  return (
    <svg className="wall-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,${H} ${pts.join(' ')} ${W},${H}`} className="wall-spark-fill" />
      <polyline points={pts.join(' ')} className="wall-spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
