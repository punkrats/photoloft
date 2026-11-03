type Sized = { size: number }
type Encode<T> = (scale: number, quality: number) => Promise<T>

const MIN_QUALITY = 0.5
const SEARCH_STEPS = 5
const MAX_ROUNDS = 8
const MAX_STEP = 0.75

// Encodes at `quality`; when a byte limit is set and missed, searches
// the highest quality down to 0.5 that fits, then shrinks the image by
// the square root of the overshoot and repeats. Each shrink is at least
// 25 %, because near the encoder's fixed header size the file no longer
// scales with the pixel count.
export async function encodeWithin<T extends Sized>(
  encode: Encode<T>, quality: number, maxBytes: number | null, overhead = 0
) {
  const first = await encode(1, quality)
  const budget = (maxBytes ?? Infinity) - overhead
  if (first.size <= budget) {
    return { result: first, scale: 1, quality, fits: true }
  }

  let scale = 1
  let smallest = first
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const top = round === 0 ? first : await encode(scale, quality)
    if (top.size <= budget) return { result: top, scale, quality, fits: true }

    const floor = await encode(scale, MIN_QUALITY)
    if (floor.size <= budget) {
      return { ...(await search(encode, scale, quality, floor, budget)), scale }
    }

    smallest = floor
    scale *= Math.min(MAX_STEP, Math.sqrt(budget / floor.size) * 0.95)
    if (!(scale > 0.02)) break
  }
  return { result: smallest, scale, quality: MIN_QUALITY, fits: false }
}

async function search<T extends Sized>(
  encode: Encode<T>, scale: number, quality: number, floor: T, budget: number
) {
  let lo = MIN_QUALITY
  let hi = quality
  let best = floor

  for (let i = 0; i < SEARCH_STEPS; i++) {
    const mid = (lo + hi) / 2
    const result = await encode(scale, mid)
    if (result.size <= budget) {
      lo = mid
      best = result
    } else {
      hi = mid
    }
  }
  return { result: best, quality: lo, fits: true }
}
