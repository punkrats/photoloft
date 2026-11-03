import { colourParams, develop } from './colour'
import type { Colour } from './schema'

export const LUT_SIZE = 33

// A .cube colour lookup table holding develop() for the whole RGB cube,
// red changing fastest, as ffmpeg's lut3d filter reads it. Videos are
// exported through it, so they get exactly the preview's colour maths.
export function cubeLut(colour: Colour, size = LUT_SIZE) {
  const params = colourParams(colour)
  const step = size - 1
  const lines = [`LUT_3D_SIZE ${size}`]

  for (let i = 0; i < size ** 3; i++) {
    const r = i % size
    const g = Math.floor(i / size) % size
    const b = Math.floor(i / size ** 2)
    const out = develop([r / step, g / step, b / step], params)
    lines.push(out.map(v => v.toFixed(6)).join(' '))
  }
  return lines.join('\n') + '\n'
}
