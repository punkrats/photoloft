import {
  bboxRegion, effectiveCrop, orientedSize, outputSize, type Size
} from './geometry'
import type { Crop } from './schema'
import { currentPhoto, type AppState } from './state'

export type StageLayout = {
  source: Size
  size: Size
  region: Crop
  native: Size
  css: Size
  px: Size
}

const PAD = 24

// Where and how large the current photo is drawn. The crop tool shows
// the whole straightened image; otherwise the cropped area, fitted to
// the stage or at 100 % when zoomed.
export function stageLayout(state: AppState): StageLayout | null {
  const photo = currentPhoto(state)
  if (!photo) return null

  const { renderer, loaded } = state.editor
  const loadedSize = loaded === photo.id ? renderer?.sourceSize : null
  const source = loadedSize ?? { w: photo.width, h: photo.height }
  const edit = photo.edit
  const size = orientedSize(source.w, source.h, edit.rotate)
  const region = state.mode === 'crop'
    ? bboxRegion(size, edit.angle)
    : effectiveCrop(edit, source)
  const native = outputSize(region, size)

  const dpr = globalThis.devicePixelRatio || 1
  const max = renderer?.maxSize ?? 4096
  if (state.zoom && state.mode === 'edit') {
    const px = capped(native, max)
    return { source, size, region, native, px, css: scale(px, 1 / dpr) }
  }

  const room = {
    w: Math.max(1, state.editor.stage.width - 2 * PAD),
    h: Math.max(1, state.editor.stage.height - 2 * PAD)
  }
  const fit = Math.min(room.w / native.w, room.h / native.h)
  const css = scale(native, fit)
  const px = capped(rounded(scale(css, dpr)), max)
  return { source, size, region, native, px, css }
}

// The crop rectangle in CSS pixels on the canvas.
export function cropBox(layout: StageLayout, crop: Crop) {
  const { region, css } = layout
  return {
    x: ((crop.x - region.x) / region.w) * css.w,
    y: ((crop.y - region.y) / region.h) * css.h,
    w: (crop.w / region.w) * css.w,
    h: (crop.h / region.h) * css.h
  }
}

function scale(s: Size, k: number): Size {
  return { w: s.w * k, h: s.h * k }
}

function rounded(s: Size): Size {
  return { w: Math.max(1, Math.round(s.w)), h: Math.max(1, Math.round(s.h)) }
}

function capped(s: Size, max: number): Size {
  const k = Math.min(1, max / Math.max(s.w, s.h))
  return rounded(scale(s, k))
}
