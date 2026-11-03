import type { Aspect, Crop, Edit, Rotation } from './schema'

export type Size = { w: number, h: number }
export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

// Row-major 3x3 affine matrix: [a, b, c, d, e, f, 0, 0, 1].
export type Matrix = number[]

const MIN_SIZE = 0.02
const EPS = 1e-9
const MAX_ANGLE = 45

const RATIOS: Record<Exclude<Aspect, 'free' | 'original'>, number> = {
  '1:1': 1,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9
}

export function orientedSize(w: number, h: number, rotate: Rotation): Size {
  return rotate === 90 || rotate === 270 ? { w: h, h: w } : { w, h }
}

export function outputSize(region: Crop, size: Size): Size {
  const w = Math.max(1, Math.round(region.w * size.w))
  const h = Math.max(1, Math.round(region.h * size.h))
  return { w, h }
}

// ─── Crop fitting ────────────────────────────────────────────────────

// Largest centred rectangle with the pixel ratio `ratio` that stays
// inside the image after straightening by `angle` degrees.
export function autoCrop(size: Size, angle: number, ratio: number): Crop {
  const rad = (angle * Math.PI) / 180
  const c = Math.abs(Math.cos(rad))
  const s = Math.abs(Math.sin(rad))
  const halfW = size.w / 2
  const halfH = size.h / 2

  const b = Math.min(halfW / (ratio * c + s), halfH / (ratio * s + c))
  const a = ratio * b
  return {
    x: (halfW - a) / size.w,
    y: (halfH - b) / size.h,
    w: (2 * a) / size.w,
    h: (2 * b) / size.h
  }
}

export function cropFits(crop: Crop, size: Size, angle: number) {
  const rad = (angle * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  const halfW = size.w / 2
  const halfH = size.h / 2
  const xs = [crop.x, crop.x + crop.w].map(x => x * size.w - halfW)
  const ys = [crop.y, crop.y + crop.h].map(y => y * size.h - halfH)

  return xs.every(x => ys.every(y => {
    const px = c * x + s * y
    const py = -s * x + c * y
    return Math.abs(px) <= halfW + EPS && Math.abs(py) <= halfH + EPS
  }))
}

// The valid crops form a convex set, so the largest valid step from
// `valid` toward `wanted` is found by bisection.
export function clampCrop(
  valid: Crop, wanted: Crop, size: Size, angle: number
): Crop {
  if (cropFits(wanted, size, angle)) return wanted

  let lo = 0
  let hi = 1
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (cropFits(lerpCrop(valid, wanted, mid), size, angle)) lo = mid
    else hi = mid
  }
  return lerpCrop(valid, wanted, lo)
}

export function fitCrop(crop: Crop, size: Size, angle: number) {
  if (cropFits(crop, size, angle)) return crop

  const ratio = (crop.w * size.w) / (crop.h * size.h)
  return clampCrop(autoCrop(size, angle, ratio), crop, size, angle)
}

export function effectiveCrop(edit: Edit, source: Size): Crop {
  const size = orientedSize(source.w, source.h, edit.rotate)
  if (!edit.crop) return autoCrop(size, edit.angle, size.w / size.h)

  return fitCrop(edit.crop, size, edit.angle)
}

export function bboxRegion(size: Size, angle: number): Crop {
  const rad = (angle * Math.PI) / 180
  const c = Math.abs(Math.cos(rad))
  const s = Math.abs(Math.sin(rad))
  const w = (size.w * c + size.h * s) / size.w
  const h = (size.w * s + size.h * c) / size.h
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

function lerpCrop(a: Crop, b: Crop, t: number): Crop {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t
  }
}

// ─── Crop editing ────────────────────────────────────────────────────

// dx and dy are fractions of the oriented width and height; `ratio` is
// the locked pixel ratio or null for a free crop.
export function resizeCrop(
  crop: Crop, handle: Handle, dx: number, dy: number,
  ratio: number | null, size: Size
): Crop {
  if (handle === 'move') return { ...crop, x: crop.x + dx, y: crop.y + dy }

  let left = crop.x
  let top = crop.y
  let right = crop.x + crop.w
  let bottom = crop.y + crop.h
  if (handle.includes('w')) left = Math.min(left + dx, right - MIN_SIZE)
  if (handle.includes('e')) right = Math.max(right + dx, left + MIN_SIZE)
  if (handle.includes('n')) top = Math.min(top + dy, bottom - MIN_SIZE)
  if (handle.includes('s')) bottom = Math.max(bottom + dy, top + MIN_SIZE)

  const free = { x: left, y: top, w: right - left, h: bottom - top }
  if (ratio === null) return free

  return lockRatio(crop, free, handle, ratio, size)
}

function lockRatio(
  crop: Crop, free: Crop, handle: Handle, ratio: number, size: Size
): Crop {
  const fromW = free.w * size.w
  const fromH = free.h * size.h * ratio
  const current = crop.w * size.w
  const vertical = handle === 'n' || handle === 's'
  const horizontal = handle === 'e' || handle === 'w'

  let px = Math.abs(fromW - current) >= Math.abs(fromH - current)
    ? fromW
    : fromH
  if (vertical) px = fromH
  if (horizontal) px = fromW

  const minPx = Math.max(MIN_SIZE * size.w, MIN_SIZE * size.h * ratio)
  px = Math.max(px, minPx)
  const w = px / size.w
  const h = px / ratio / size.h

  let x = handle.includes('w') ? crop.x + crop.w - w : crop.x
  let y = handle.includes('n') ? crop.y + crop.h - h : crop.y
  if (vertical) x = crop.x + (crop.w - w) / 2
  if (horizontal) y = crop.y + (crop.h - h) / 2
  return { x, y, w, h }
}

export function aspectRatio(aspect: Aspect, crop: Crop, size: Size) {
  if (aspect === 'free') return null

  const base = aspect === 'original'
    ? Math.max(size.w, size.h) / Math.min(size.w, size.h)
    : RATIOS[aspect]
  const portrait = crop.h * size.h > crop.w * size.w
  return portrait ? 1 / base : base
}

export function aspectCrop(
  crop: Crop, aspect: Aspect, size: Size, angle: number
): Crop {
  const ratio = aspectRatio(aspect, crop, size)
  if (ratio === null) return crop

  return centredInside(crop, ratio, size, angle)
}

export function swapCrop(crop: Crop, size: Size, angle: number): Crop {
  const w = (crop.h * size.h) / size.w
  const h = (crop.w * size.w) / size.h
  const x = crop.x + (crop.w - w) / 2
  const y = crop.y + (crop.h - h) / 2
  return fitCrop({ x, y, w, h }, size, angle)
}

function centredInside(
  crop: Crop, ratio: number, size: Size, angle: number
): Crop {
  const pw = crop.w * size.w
  const ph = crop.h * size.h
  const w = Math.min(pw, ph * ratio) / size.w
  const h = Math.min(ph, pw / ratio) / size.h
  const x = crop.x + (crop.w - w) / 2
  const y = crop.y + (crop.h - h) / 2
  return fitCrop({ x, y, w, h }, size, angle)
}

// ─── Straighten ──────────────────────────────────────────────────────

// New angle that levels a line drawn on screen. Lines steeper than 45
// degrees are taken as verticals.
export function horizonAngle(current: number, dx: number, dy: number) {
  let line = (Math.atan2(dy, dx) * 180) / Math.PI
  if (line > 90) line -= 180
  if (line <= -90) line += 180
  if (line > 45) line -= 90
  if (line < -45) line += 90

  const angle = current - line
  return Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, angle))
}

// ─── Source transform ────────────────────────────────────────────────

// Maps output coordinates (0..1 across `region`) to source texture
// coordinates. Order of the forward transform: rotate by quarter
// turns, flip, straighten, crop.
export function sourceMatrix(edit: Edit, source: Size, region: Crop) {
  const size = orientedSize(source.w, source.h, edit.rotate)
  const rad = (edit.angle * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)

  const toPixels = [
    region.w * size.w, 0, region.x * size.w,
    0, region.h * size.h, region.y * size.h,
    0, 0, 1
  ]
  const unflip = edit.flip ? [-1, 0, 1, 0, 1, 0, 0, 0, 1] : identity()

  // Applied right to left: crop region to pixels, undo the
  // straighten around the centre, normalise, undo flip and rotation.
  const steps = [
    unorient(edit.rotate),
    unflip,
    [1 / size.w, 0, 0, 0, 1 / size.h, 0, 0, 0, 1],
    translate(size.w / 2, size.h / 2),
    [c, s, 0, -s, c, 0, 0, 0, 1],
    translate(-size.w / 2, -size.h / 2),
    toPixels
  ]
  return steps.reduce(multiply)
}

export function applyMatrix(m: Matrix, u: number, v: number) {
  return [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]]
}

// GLSL mat3 uniforms are column-major.
export function toColumnMajor(m: Matrix) {
  return new Float32Array([m[0], m[3], 0, m[1], m[4], 0, m[2], m[5], 1])
}

function unorient(rotate: Rotation): Matrix {
  if (rotate === 90) return [0, 1, 0, -1, 0, 1, 0, 0, 1]
  if (rotate === 180) return [-1, 0, 1, 0, -1, 1, 0, 0, 1]
  if (rotate === 270) return [0, -1, 1, 1, 0, 0, 0, 0, 1]
  return identity()
}

function translate(x: number, y: number): Matrix {
  return [1, 0, x, 0, 1, y, 0, 0, 1]
}

function identity(): Matrix {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1]
}

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array(9).fill(0)
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 3; k++) {
      out[r * 3 + k] = a[r * 3] * b[k] + a[r * 3 + 1] * b[3 + k] +
        a[r * 3 + 2] * b[6 + k]
    }
  }
  return out
}
