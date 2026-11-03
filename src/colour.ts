import type { Colour } from './schema'

// Reference implementation of shaders/develop.frag. Both must stay in
// step; the end-to-end test compares them pixel by pixel.

export type RGB = [number, number, number]

export type Params = {
  gains: RGB
  exposure: number
  shoulder: number
  lo: number
  hi: number
  shadows: number
  highlights: number
  contrast: number
  vibrance: number
  saturation: number
}

const LUMA: RGB = [0.2126, 0.7152, 0.0722]
const WB_TEMP = 0.75
const WB_TINT = 0.5
const LEVEL = 0.15

export function colourParams(c: Colour): Params {
  return {
    gains: wbGains(c.temperature / 100, c.tint / 100),
    exposure: 2 ** c.exposure,
    shoulder: 1 - 0.25 * clamp(c.exposure, 0, 1),
    lo: (-LEVEL * c.blacks) / 100,
    hi: 1 - (LEVEL * c.whites) / 100,
    shadows: c.shadows / 100,
    highlights: c.highlights / 100,
    contrast: c.contrast / 100,
    vibrance: c.vibrance / 100,
    saturation: c.saturation / 100
  }
}

export function develop(rgb: RGB, p: Params): RGB {
  const linear = rgb.map((v, i) => srgbToLinear(v) * p.gains[i] * p.exposure)
  const encoded = linear.map(v => shoulder(linearToSrgb(v), p.shoulder))
  const levelled = encoded.map(v => clamp01((v - p.lo) / (p.hi - p.lo)))

  const ratio = toneRatio(luma(levelled as RGB), p.shadows, p.highlights)
  const toned = levelled.map(v => contrast(clamp01(v * ratio), p.contrast))

  const vivid = vibrance(toned as RGB, p.vibrance)
  return scaleChroma(vivid, 1 + p.saturation).map(clamp01) as RGB
}

// ─── White balance ───────────────────────────────────────────────────

// Temperature and tint (-1..1) as RGB gains that keep grey's
// brightness. In log2: red gains WB_TEMP * t, blue loses it, green
// loses WB_TINT * g.
export function wbGains(t: number, g: number): RGB {
  const raw: RGB = [
    2 ** (WB_TEMP * t), 2 ** (-WB_TINT * g), 2 ** (-WB_TEMP * t)
  ]
  const norm = luma(raw)
  return raw.map(v => v / norm) as RGB
}

// Inverse of wbGains from log2(R/G) and log2(B/G) gain ratios.
export function wbFromRatios(redRatio: number, blueRatio: number) {
  return {
    temperature: (redRatio - blueRatio) / (2 * WB_TEMP),
    tint: (redRatio + blueRatio) / (2 * WB_TINT)
  }
}

// ─── Tone ────────────────────────────────────────────────────────────

// Strengths per direction are the largest that keep the curves
// monotone on 0..1.
export function shadowHighlight(y: number, s: number, h: number) {
  const ks = s > 0 ? 2 : 1
  const kh = h < 0 ? 2 : 1
  const lifted = y + s * ks * y * (1 - y) ** 2
  return lifted + h * kh * lifted ** 2 * (1 - lifted)
}

function toneRatio(y: number, s: number, h: number) {
  const clamped = clamp01(y)
  if (clamped < 1e-5) return 1 + s * (s > 0 ? 2 : 1)

  return shadowHighlight(clamped, s, h) / clamped
}

function shoulder(x: number, start: number) {
  if (start >= 1 || x <= start) return x

  const room = 1 - start
  return start + room * (1 - Math.exp(-(x - start) / room))
}

function contrast(x: number, c: number) {
  if (c < 0) return 0.5 + (x - 0.5) * (1 + 0.5 * c)

  const g = 1 + 1.2 * c
  return x < 0.5 ? 0.5 * (2 * x) ** g : 1 - 0.5 * (2 * (1 - x)) ** g
}

// ─── Presence ────────────────────────────────────────────────────────

function vibrance(rgb: RGB, v: number): RGB {
  const sat = Math.max(...rgb) - Math.min(...rgb)
  const weight = v > 0 ? (1 - sat) ** 2 * (1 - 0.6 * skin(rgb)) : 1 - sat
  return scaleChroma(rgb, 1 + v * weight)
}

// 1 for typical skin hues (orange, 5 to 45 degrees), fading to 0.
function skin([r, g, b]: RGB) {
  if (!(r >= g && g >= b) || r - b < 0.05) return 0

  const hue = (60 * (g - b)) / (r - b)
  return 1 - smoothstep(Math.abs(hue - 25) / 20)
}

function scaleChroma(rgb: RGB, factor: number): RGB {
  const y = luma(rgb)
  return rgb.map(v => y + (v - y) * factor) as RGB
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function srgbToLinear(v: number) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

export function linearToSrgb(v: number) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
}

export function luma(rgb: RGB) {
  return rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2]
}

function smoothstep(t: number) {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function clamp01(v: number) {
  return clamp(v, 0, 1)
}
