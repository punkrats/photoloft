import { describe, expect, it } from 'vitest'
import { autoTone, autoWhiteBalance, hasSettings } from '../src/auto'
import {
  colourParams, develop, linearToSrgb, srgbToLinear, type RGB
} from '../src/colour'
import { colourOf, NEUTRAL_EDIT, type Edit } from '../src/schema'

// Builds an RGBA buffer from perceptual (sRGB-encoded) colours.
function image(colours: RGB[]) {
  const data = new Uint8ClampedArray(colours.length * 4)
  colours.forEach(([r, g, b], i) => {
    data.set([r * 255, g * 255, b * 255, 255], i * 4)
  })
  return data
}

function ramp(n: number, lo = 0, hi = 1): RGB[] {
  return Array.from({ length: n }, (_, i) => {
    const v = lo + ((hi - lo) * i) / (n - 1)
    return [v, v, v]
  })
}

function cast(colours: RGB[], gains: RGB): RGB[] {
  return colours.map(c => c.map((v, i) => {
    return linearToSrgb(Math.min(1, srgbToLinear(v) * gains[i]))
  }) as RGB)
}

const PALETTE: RGB[] = [
  [0.7, 0.2, 0.2], [0.2, 0.6, 0.3], [0.2, 0.3, 0.7], [0.8, 0.7, 0.2]
]

function scene(): RGB[] {
  const greys = ramp(600, 0.05, 0.95)
  const colours = Array.from({ length: 400 }, (_, i) => PALETTE[i % 4])
  return [...greys, ...colours]
}

function sunny(): RGB[] {

  // Modelled on a well exposed camera JPEG: sky with the blue channel at
  // its limit, white clouds, warm sunlit pavement, foliage, shade.
  return [
    ...Array(200).fill([0.25, 0.62, 1]),
    ...Array(40).fill([0.96, 0.97, 0.98]),
    ...ramp(300, 0.45, 0.7).map(([v]) => [v + 0.04, v, v - 0.06] as RGB),
    ...Array(150).fill([0.3, 0.42, 0.12]),
    ...Array(150).fill([0.62, 0.6, 0.2]),
    ...ramp(160, 0.03, 0.3).map(([v]) => [v, v * 1.1, v * 0.8] as RGB)
  ]
}

function balance(colours: RGB[]) {
  const wb = autoWhiteBalance(image(colours))
  const params = colourParams({ ...colourOf(NEUTRAL_EDIT), ...wb })
  return { wb, out: colours.map(c => develop(c, params)) }
}

describe('autoTone', () => {
  it('leaves a neutral, well exposed image alone', () => {
    const tone = autoTone(image(ramp(1000)))
    expect(tone.exposure).toBe(0)
    expect(tone.blacks).toBe(0)
    expect(tone.whites).toBe(0)
    expect(tone.contrast).toBe(0)
  })

  it('leaves white balance to the user', () => {
    const tone = autoTone(image(cast(scene(), [0.8, 1, 1.3])))
    expect('temperature' in tone).toBe(false)
    expect('tint' in tone).toBe(false)
  })

  it('leaves a good sunny photo with a deep blue sky nearly alone', () => {
    const tone = autoTone(image(sunny()))
    expect(tone.exposure).toBe(0)
    expect(tone.whites).toBe(0)
    expect(tone.blacks).toBeGreaterThanOrEqual(-10)
  })

  it('brightens a dark image', () => {
    const dark = cast(ramp(1000), [0.2, 0.2, 0.2])
    expect(autoTone(image(dark)).exposure).toBeGreaterThan(0.5)
  })

  it('darkens a very bright image without stretching it back', () => {
    const tone = autoTone(image(ramp(1000, 0.55, 1)))
    expect(tone.exposure).toBeLessThan(0)
    expect(tone.whites).toBe(0)
  })

  it('stretches and lifts a flat image', () => {
    const tone = autoTone(image(ramp(1000, 0.3, 0.62)))
    expect(tone.blacks).toBeLessThan(0)
    expect(tone.whites).toBeGreaterThan(0)
    expect(tone.contrast).toBeGreaterThan(0)
  })

  it('adds a little vibrance to a muted image only', () => {
    const muted = autoTone(image(cast(ramp(1000), [1.05, 1, 0.95])))
    const vivid = autoTone(image(Array(1000).fill(PALETTE[2])))
    expect(muted.vibrance).toBeGreaterThan(0)
    expect(vivid.vibrance).toBe(0)
  })

  it('gives a photo holding its values the same values again', () => {
    const photos = [
      cast(ramp(1000), [0.2, 0.2, 0.2]),
      ramp(1000, 0.55, 1),
      ramp(1000, 0.3, 0.62),
      cast(ramp(1000), [1.05, 1, 0.95]),
      sunny()
    ]
    for (const colours of photos) {
      const rgba = image(colours)
      const first = autoTone(rgba)
      const edit: Edit = { ...NEUTRAL_EDIT, ...first }
      expect(autoTone(rgba, edit)).toEqual(first)
    }
  })

  it('judges by the white balance of an edit and nothing else', () => {
    const rgba = image(cast(ramp(1000), [1.05, 1, 0.95]))
    const warm = { temperature: 30, tint: 0 }
    const edit: Edit = {
      ...NEUTRAL_EDIT, ...warm, contrast: 40, blacks: -20, saturation: 50
    }
    expect(autoTone(rgba, edit)).toEqual(autoTone(rgba, warm))
    expect(autoTone(rgba, warm)).not.toEqual(autoTone(rgba))
  })

  it('copes with a black frame', () => {
    const tone = autoTone(image(Array(500).fill([0, 0, 0])))
    for (const value of Object.values(tone)) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})

describe('autoWhiteBalance', () => {
  it('leaves neutral images alone', () => {
    const wb = autoWhiteBalance(image(ramp(1000)))
    expect(Math.abs(wb.temperature)).toBeLessThanOrEqual(2)
    expect(Math.abs(wb.tint)).toBeLessThanOrEqual(2)
  })

  it('keeps warm pavement warm under white clouds', () => {
    const wb = autoWhiteBalance(image(sunny()))
    expect(Math.abs(wb.temperature)).toBeLessThanOrEqual(8)
    expect(Math.abs(wb.tint)).toBeLessThanOrEqual(8)
  })

  it('removes a blue cast from the greys', () => {
    const { wb, out } = balance(cast(scene(), [0.8, 1, 1.3]))
    expect(wb.temperature).toBeGreaterThan(20)
    for (const [r, , b] of out.slice(100, 500)) {
      expect(Math.abs(r - b)).toBeLessThan(0.03)
    }
  })

  it('removes a green cast with tint', () => {
    const { wb, out } = balance(cast(scene(), [0.85, 1.15, 0.85]))
    expect(wb.tint).toBeGreaterThan(10)
    for (const [r, g] of out.slice(100, 500)) {
      expect(Math.abs(r - g)).toBeLessThan(0.03)
    }
  })

  it('corrects a strong tungsten cast', () => {
    const { wb, out } = balance(cast(scene(), [1.5, 1, 0.6]))
    expect(wb.temperature).toBeLessThan(-30)
    for (const [r, , b] of out.slice(100, 400)) {
      expect(Math.abs(r - b)).toBeLessThan(0.04)
    }
  })

  it('is close to idempotent', () => {
    const { out } = balance(cast(scene(), [0.8, 1, 1.3]))
    const again = autoWhiteBalance(image(out))
    expect(Math.abs(again.temperature)).toBeLessThanOrEqual(3)
    expect(Math.abs(again.tint)).toBeLessThanOrEqual(3)
  })

  it('copes with a black frame', () => {
    expect(autoWhiteBalance(image(Array(500).fill([0, 0, 0])))).
      toEqual({ temperature: 0, tint: 0 })
  })
})

describe('hasSettings', () => {
  it('tells whether an edit holds every value given', () => {
    const values = { temperature: 0, exposure: 0.35, whites: 12 }
    const edit: Edit = { ...NEUTRAL_EDIT, ...values, saturation: 20, angle: 3 }
    expect(hasSettings(edit, values)).toBe(true)
    expect(hasSettings({ ...edit, whites: 11 }, values)).toBe(false)
    expect(hasSettings({ ...edit, temperature: 5 }, values)).toBe(false)
  })
})
