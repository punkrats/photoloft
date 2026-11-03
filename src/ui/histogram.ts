import { html, svg } from 'lit-html'

export type Histogram = { r: number[], g: number[], b: number[] }

const BINS = 64
const HEIGHT = 32

export function histogramOf(pixels: Uint8ClampedArray): Histogram {
  const counts = [0, 1, 2].map(() => new Array(BINS).fill(0))
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue
    for (let c = 0; c < 3; c++) counts[c][pixels[i + c] >> 2]++
  }

  // Square root keeps small peaks visible next to large ones.
  const peak = Math.sqrt(Math.max(1, ...counts.flat()))
  const [r, g, b] = counts.map(bins => bins.map(n => Math.sqrt(n) / peak))
  return { r, g, b }
}

export function histogramView(histogram: Histogram | null) {
  if (!histogram) return html`<div class="histogram"></div>`

  return html`
    <div class="histogram">
      <svg viewBox="0 0 ${BINS} ${HEIGHT}" preserveAspectRatio="none">
        ${(['r', 'g', 'b'] as const).map(channel => {
          const d = area(histogram[channel])
          return svg`<path class="histogram-${channel}" d=${d}></path>`
        })}
      </svg>
    </div>
  `
}

function area(bins: number[]) {
  const points = bins.map((v, i) => `L${i + 0.5},${HEIGHT * (1 - v)}`)
  return `M0,${HEIGHT} ${points.join(' ')} L${BINS},${HEIGHT} Z`
}
