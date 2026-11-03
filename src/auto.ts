import {
  colourParams, develop, linearToSrgb, luma, srgbToLinear, wbFromRatios,
  type RGB
} from './colour'
import { colourOf, NEUTRAL_EDIT, type Colour } from './schema'

type Balance = { temperature: number, tint: number }
export type AutoTone = Omit<Colour, 'saturation' | keyof Balance>

const MAX_SAMPLES = 65536
const BAND = [0.36, 0.66]

// Exposure, contrast, highlights, shadows, whites, blacks and vibrance
// for an RGBA sample, judged with the photo's current white balance.
// White balance itself is left alone: the camera usually got it right,
// and a guess cannot tell a colour cast from the colour of the scene.
export function autoTone(
  rgba: Uint8ClampedArray, wb: Balance = { temperature: 0, tint: 0 }
): AutoTone {
  return tone(samplePixels(rgba), wb)
}

// Temperature and tint that neutralise a colour cast, for the white
// balance section's own Auto button.
export function autoWhiteBalance(rgba: Uint8ClampedArray): Balance {
  return whiteBalance(samplePixels(rgba))
}

function samplePixels(rgba: Uint8ClampedArray) {
  const count = rgba.length / 4
  const stride = Math.max(1, Math.ceil(count / MAX_SAMPLES))
  const pixels: RGB[] = []
  for (let i = 0; i < count; i += stride) {
    const o = i * 4
    pixels.push([rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255])
  }
  return pixels
}

// ─── White balance ───────────────────────────────────────────────────

const MID: Band = [0.15, 0.7]
const BRIGHT: Band = [0.7, 0.985]
const WB_DEADBAND = 0.08

type Band = [number, number]

// Camera JPEGs are usually balanced already, so a correction needs two
// witnesses that agree: the most neutral mid tones (grey walls, roads)
// and the most neutral bright tones (clouds, white paint). The smaller
// correction wins and small ones are skipped, so a warm pavement under
// white clouds stays warm.
function whiteBalance(pixels: RGB[]): Balance {
  const linear = pixels.map(p => p.map(srgbToLinear) as RGB)
  const estimates = [estimate(linear, MID), estimate(linear, BRIGHT)]
    .filter((e): e is Balance => e !== null)

  return {
    temperature: slider(agree(estimates.map(e => e.temperature))),
    tint: slider(agree(estimates.map(e => e.tint)))
  }
}

function agree(values: number[]) {
  if (values.length === 0) return 0
  if (!values.every(v => Math.sign(v) === Math.sign(values[0]))) return 0

  const smallest = Math.min(...values.map(Math.abs))
  return smallest < WB_DEADBAND ? 0 : smallest * Math.sign(values[0])
}

// Averages the most neutral half of the pixels in a brightness band,
// re-selecting after each correction. Bands without near-neutral pixels
// get a weaker correction, down to none.
function estimate(linear: RGB[], band: Band): Balance | null {
  let gains: RGB = [1, 1, 1]
  let strength = 1

  for (let pass = 0; pass < 3; pass++) {
    const neutral = mostNeutral(linear, gains, band)
    if (!neutral) return null

    const [r, g, b] = neutral.mean
    gains = [g / r, 1, g / b]
    if (pass === 0) strength = clamp((0.6 - neutral.chroma) / 0.25, 0, 1)
  }

  const ratios = [gains[0], gains[2]].map(v => Math.log2(v) * strength)
  return wbFromRatios(ratios[0], ratios[1])
}

function mostNeutral(linear: RGB[], gains: RGB, [lo, hi]: Band) {
  const found: { chroma: number, raw: RGB }[] = []

  for (const raw of linear) {
    if (Math.max(...raw) > 0.97) continue

    const c = raw.map((v, i) => v * gains[i]) as RGB
    const y = linearToSrgb(luma(c))
    if (y < lo || y > hi) continue

    // Measured on sRGB values: linear light exaggerates ordinary casts
    // and would make strong ones look like intentionally coloured scenes.
    const encoded = c.map(linearToSrgb)
    const max = Math.max(...encoded)
    found.push({ chroma: (max - Math.min(...encoded)) / max, raw })
  }

  const needed = Math.max(20, linear.length * 0.01)
  if (found.length < needed) return null

  found.sort((a, b) => a.chroma - b.chroma)
  const half = found.slice(0, Math.ceil(found.length / 2))
  const sum = (i: number) => half.reduce((s, p) => s + p.raw[i], 0)
  const mean: RGB = [sum(0), sum(1), sum(2)].map(v => v / half.length) as RGB
  const chroma = half.reduce((s, p) => s + p.chroma, 0) / half.length
  return { mean, chroma }
}

// ─── Tone ────────────────────────────────────────────────────────────

// Levels and highlights look at single colour channels: a deep blue sky
// can sit at the blue limit while its overall brightness reads as mid
// grey, and stretching on brightness alone would clip it further.
function tone(pixels: RGB[], wb: Balance) {
  const base = { ...colourOf(NEUTRAL_EDIT), ...wb }
  const exposure = exposureFor(developAll(pixels, base))

  const developed = developAll(pixels, { ...base, exposure })
  const ys = sorted(developed.map(luma))
  const highs = sorted(developed.map(c => Math.max(...c)))
  const lows = sorted(developed.map(c => Math.min(...c)))

  const low = percentile(lows, 0.005)
  const high = percentile(highs, 0.995)
  const clipped = highs.filter(v => v > 0.98).length / highs.length
  const quarter = percentile(ys, 0.25)
  const spread = percentile(ys, 0.75) - quarter
  const chroma = developed
    .reduce((s, c) => s + Math.max(...c) - Math.min(...c), 0) /
    Math.max(1, developed.length)

  // After darkening, raising whites would only undo it.
  const stretch = exposure >= 0 && high < 0.94

  return {
    exposure,
    blacks: low > 0.04 ? slider(-clamp(low / 0.15, 0, 0.4)) : 0,
    whites: stretch ? slider(clamp((1 - high) / 0.15, 0, 0.4)) : 0,
    highlights: clipped > 0.02 ? slider(-clamp(clipped * 4, 0, 0.4)) : 0,
    shadows: quarter < 0.2 ? slider(clamp((0.2 - quarter) * 2, 0, 0.4)) : 0,
    contrast: spread < 0.25 ? slider(clamp((0.25 - spread) * 2, 0, 0.3)) : 0,
    vibrance: slider(clamp((0.3 - chroma) * 0.8, 0, 0.25))
  }
}

// Brings the median into a comfortable band, damped, and leaves photos
// already inside it alone; frames that are black on purpose too. Never
// brightens past the point where the brightest colours would clip.
function exposureFor(pixels: RGB[]) {
  const median = percentile(sorted(pixels.map(luma)), 0.5)
  if (median < 0.02) return 0

  const target = clamp(median, BAND[0], BAND[1])
  const top = Math.max(0.01, percentile(sorted(pixels.map(maxOf)), 0.99))
  const room = Math.log2(srgbToLinear(0.97) / srgbToLinear(top))
  const wanted = Math.log2(srgbToLinear(target) / srgbToLinear(median)) * 0.8
  const ev = clamp(Math.min(wanted, Math.max(0, room)), -1.5, 1.5)
  if (Math.abs(ev) < 0.2) return 0

  return Math.round(ev * 20) / 20
}

function developAll(pixels: RGB[], colour: Colour) {
  const params = colourParams(colour)
  return pixels.map(p => develop(p, params))
}

function sorted(values: number[]) {
  return values.sort((a, b) => a - b)
}

function maxOf(c: RGB) {
  return Math.max(...c)
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0

  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[index]
}

function slider(v: number) {
  return clamp(Math.round(v * 100), -100, 100) || 0
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}
