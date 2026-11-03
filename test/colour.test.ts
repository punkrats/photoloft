import { describe, expect, it } from 'vitest'
import {
  colourParams, develop, linearToSrgb, luma, shadowHighlight, srgbToLinear,
  wbFromRatios, wbGains, type RGB
} from '../src/colour'
import { colourOf, NEUTRAL_EDIT, type Colour } from '../src/schema'

const neutral = colourOf(NEUTRAL_EDIT)

function run(rgb: RGB, change: Partial<Colour>) {
  return develop(rgb, colourParams({ ...neutral, ...change }))
}

function chroma([r, g, b]: RGB) {
  return Math.max(r, g, b) - Math.min(r, g, b)
}

describe('transfer functions', () => {
  it('round-trips sRGB', () => {
    for (let v = 0; v <= 1; v += 0.05) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 9)
    }
  })

  it('puts 18 % grey near 0.46', () => {
    expect(linearToSrgb(0.18)).toBeCloseTo(0.461, 3)
  })
})

describe('neutral settings', () => {
  it('leave every colour unchanged', () => {
    const steps = [0, 0.1, 0.33, 0.5, 0.77, 0.95, 1]
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const out = run([r, g, b], {})
      out.forEach((v, i) => expect(v).toBeCloseTo([r, g, b][i], 6))
    }
  })
})

describe('white balance', () => {
  it('warms with positive temperature', () => {
    const [r, , b] = run([0.5, 0.5, 0.5], { temperature: 50 })
    expect(r).toBeGreaterThan(b)
  })

  it('cools with negative temperature', () => {
    const [r, , b] = run([0.5, 0.5, 0.5], { temperature: -50 })
    expect(b).toBeGreaterThan(r)
  })

  it('adds magenta with positive tint', () => {
    const [r, g, b] = run([0.5, 0.5, 0.5], { tint: 50 })
    expect(g).toBeLessThan(r)
    expect(g).toBeLessThan(b)
  })

  it('keeps the brightness of grey', () => {
    const before = srgbToLinear(0.5)
    const out = run([0.5, 0.5, 0.5], { temperature: 60, tint: -40 })
    const after = luma(out.map(srgbToLinear) as RGB)
    expect(after).toBeCloseTo(before, 2)
  })

  it('inverts: gains back to slider values', () => {
    const [r, g, b] = wbGains(0.4, -0.3)
    const back = wbFromRatios(Math.log2(r / g), Math.log2(b / g))
    expect(back.temperature).toBeCloseTo(0.4, 9)
    expect(back.tint).toBeCloseTo(-0.3, 9)
  })
})

describe('exposure', () => {
  it('doubles linear light per stop in the shadows', () => {
    const out = run([0.2, 0.2, 0.2], { exposure: 1 })
    expect(srgbToLinear(out[0])).toBeCloseTo(2 * srgbToLinear(0.2), 6)
  })

  it('rolls highlights off smoothly instead of clipping', () => {
    const a = run([0.85, 0.85, 0.85], { exposure: 1 })[0]
    const b = run([0.95, 0.95, 0.95], { exposure: 1 })[0]
    expect(a).toBeLessThan(1)
    expect(b).toBeLessThan(1)
    expect(b).toBeGreaterThan(a)
  })

  it('darkens with negative values', () => {
    expect(run([0.6, 0.6, 0.6], { exposure: -1 })[0]).toBeLessThan(0.6)
  })
})

describe('blacks and whites', () => {
  it('crushes blacks with negative values', () => {
    expect(run([0.05, 0.05, 0.05], { blacks: -100 })[0]).toBe(0)
  })

  it('lifts blacks with positive values', () => {
    expect(run([0, 0, 0], { blacks: 100 })[0]).toBeGreaterThan(0.1)
  })

  it('clips whites with positive values', () => {
    expect(run([0.9, 0.9, 0.9], { whites: 100 })[0]).toBe(1)
  })
})

describe('shadows and highlights', () => {
  it('lifts dark tones and leaves black and white in place', () => {
    expect(run([0.15, 0.15, 0.15], { shadows: 100 })[0]).toBeGreaterThan(0.25)
    expect(run([0, 0, 0], { shadows: 100 })[0]).toBe(0)
    expect(run([1, 1, 1], { shadows: 100 })[0]).toBeCloseTo(1, 9)
  })

  it('recovers bright tones', () => {
    expect(run([0.85, 0.85, 0.85], { highlights: -100 })[0]).
      toBeLessThan(0.75)
  })

  it('stays monotone at every extreme', () => {
    for (const s of [-1, 1]) for (const h of [-1, 1]) {
      let last = -1
      for (let y = 0; y <= 1.0001; y += 0.01) {
        const out = shadowHighlight(y, s, h)
        expect(out).toBeGreaterThanOrEqual(last - 1e-12)
        last = out
      }
    }
  })

  it('keeps the hue of a colour', () => {
    const [r, g, b] = run([0.3, 0.15, 0.1], { shadows: 80 })
    expect(r / g).toBeCloseTo(0.3 / 0.15, 6)
    expect(g / b).toBeCloseTo(0.15 / 0.1, 6)
  })
})

describe('contrast', () => {
  it('spreads tones around mid grey', () => {
    expect(run([0.3, 0.3, 0.3], { contrast: 60 })[0]).toBeLessThan(0.3)
    expect(run([0.7, 0.7, 0.7], { contrast: 60 })[0]).toBeGreaterThan(0.7)
    expect(run([0.5, 0.5, 0.5], { contrast: 60 })[0]).toBeCloseTo(0.5, 9)
  })

  it('flattens with negative values', () => {
    expect(run([0.1, 0.1, 0.1], { contrast: -100 })[0]).toBeCloseTo(0.3, 6)
  })
})

describe('saturation and vibrance', () => {
  it('removes all colour at -100 saturation', () => {
    const [r, g, b] = run([0.8, 0.3, 0.2], { saturation: -100 })
    expect(r).toBeCloseTo(g, 9)
    expect(g).toBeCloseTo(b, 9)
  })

  it('boosts colour with positive saturation', () => {
    const rgb: RGB = [0.6, 0.4, 0.3]
    expect(chroma(run(rgb, { saturation: 50 }))).toBeGreaterThan(chroma(rgb))
  })

  it('boosts muted colours more than strong ones', () => {
    const muted: RGB = [0.4, 0.45, 0.55]
    const strong: RGB = [0.1, 0.3, 0.9]
    const gain = (rgb: RGB) => chroma(run(rgb, { vibrance: 80 })) / chroma(rgb)
    expect(gain(muted)).toBeGreaterThan(gain(strong))
  })

  it('protects skin tones', () => {
    const skin: RGB = [0.8, 0.6, 0.5]
    const sky: RGB = [0.5, 0.6, 0.8]
    const gain = (rgb: RGB) => chroma(run(rgb, { vibrance: 80 })) / chroma(rgb)
    expect(gain(skin)).toBeLessThan(gain(sky))
  })

  it('leaves greys grey', () => {
    const [r, g, b] = run([0.4, 0.4, 0.4], { vibrance: 100, saturation: 100 })
    expect(r).toBeCloseTo(g, 9)
    expect(g).toBeCloseTo(b, 9)
  })
})

describe('output', () => {
  it('always lands in 0..1', () => {
    const extreme = {
      exposure: 4, contrast: 100, whites: 100, saturation: 100, vibrance: 100
    }
    for (const v of run([0.9, 0.2, 0.05], extreme)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})
