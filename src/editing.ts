import { autoTone, autoWhiteBalance } from './auto'
import { srgbToLinear, wbFromRatios } from './colour'
import { commit } from './commit'
import {
  applyMatrix, aspectCrop, aspectRatio, clampCrop, effectiveCrop,
  horizonAngle, resizeCrop, sourceMatrix, swapCrop, type Handle
} from './geometry'
import {
  closeVideo, decode, openVideo, probeVideo, samplePixels, videoFrame
} from './images'
import { setEdits } from './library'
import { Renderer } from './pipeline'
import { render } from './render'
import {
  colourOf, NEUTRAL_EDIT, type Aspect, type Colour, type Edit, type SliderKey
} from './schema'
import { stageLayout } from './stage-layout'
import {
  currentPhoto, endCoalescing, showToast, viewIds, type AppState, type Point
} from './state'
import { readOriginal } from './storage'

const AUTO_EDGE = 256
const SAMPLER_EDGE = 1024

// ─── Opening photos ──────────────────────────────────────────────────

export function ensureRenderer(state: AppState) {
  if (state.editor.renderer) return

  const canvas = state.root.querySelector<HTMLCanvasElement>('.stage-canvas')
  if (!canvas) return
  try {
    state.editor.renderer = new Renderer(canvas)
  } catch (error) {
    showToast(state, `Editing needs WebGL2: ${String(error)}`)
  }
}

export function openPhoto(state: AppState, id: string) {
  state.current = id
  state.anchor = id
  if (state.mode === 'grid') state.mode = 'edit'
  state.zoom = false
  state.editor.tool = 'none'
  state.editor.horizon = null
  render(state)
  void loadCurrent(state)
}

export function previewPhoto(state: AppState, id: string) {
  openPhoto(state, id)
  state.mode = 'preview'
}

// Back to the grid with the photo last shown selected and scrolled
// into view.
export function closeEditor(state: AppState) {
  releaseVideo(state)
  state.mode = 'grid'
  state.zoom = false
  state.before = false
  state.editor.tool = 'none'
  if (state.current) state.selection = new Set([state.current])
  state.grid.reveal = true
  render(state)
}

export function step(state: AppState, delta: number) {
  const ids = viewIds(state)
  const at = ids.indexOf(state.current ?? '')
  const next = ids[at + delta]
  if (next) openPhoto(state, next)
}

export async function loadCurrent(state: AppState) {
  const editor = state.editor
  const id = state.current
  const renderer = editor.renderer
  if (!id || !renderer || !state.dirs) return
  if (editor.loaded === id || editor.loading) return

  editor.loading = id
  try {
    const photo = state.library!.photos[id]
    const original = await readOriginal(state.dirs, photo)
    releaseVideo(state)
    if (photo.video) await loadVideo(state, id, original)
    else show(state, id, await decode(original, renderer.maxSize), true)
  } catch (error) {
    showToast(state, `Could not open ${String(error)}`)
  } finally {
    editor.loading = null
    render(state)
  }

  // The user may have moved on while this one was decoding.
  if (state.current && state.current !== editor.loaded) void loadCurrent(state)
}

function show(state: AppState, id: string, frame: ImageBitmap, mip: boolean) {
  const editor = state.editor
  if (state.current !== id || !editor.renderer) {
    frame.close()
    return
  }

  editor.renderer.setSource(frame, mip)
  editor.bitmap?.close()
  editor.bitmap = frame
  editor.sampler = null
  editor.loaded = id
}

// ─── Video ───────────────────────────────────────────────────────────

// Each new frame is grabbed as an image and drawn through the same
// renderer as photos, so every adjustment applies while it plays.
async function loadVideo(state: AppState, id: string, file: Blob) {
  const editor = state.editor
  const video = await openVideo(file)
  if (state.current !== id) {
    closeVideo(video)
    return
  }

  editor.video = video
  editor.time = 0
  const update = () => {
    editor.playing = !video.paused && !video.ended
    editor.time = video.currentTime
    render(state)
  }
  video.addEventListener('play', () => {
    update()
    followFrames(state, id, video)
  })
  video.addEventListener('pause', update)
  video.addEventListener('ended', update)
  video.addEventListener('timeupdate', update)
  video.addEventListener('seeked', () => void grab(state, id, video))

  await grab(state, id, video)
  if (state.mode === 'preview') void video.play()
}

function followFrames(state: AppState, id: string, video: HTMLVideoElement) {
  video.requestVideoFrameCallback(() => {
    if (state.editor.video !== video) return
    void grab(state, id, video)
    if (!video.paused) followFrames(state, id, video)
  })
}

async function grab(state: AppState, id: string, video: HTMLVideoElement) {
  const frame = await videoFrame(video)
  if (state.editor.video !== video) {
    frame.close()
    return
  }
  show(state, id, frame, false)
  render(state)
}

function releaseVideo(state: AppState) {
  const video = state.editor.video
  if (!video) return

  closeVideo(video)
  state.editor.video = null
  state.editor.playing = false
}

export function togglePlay(state: AppState) {
  const video = state.editor.video
  if (!video) return false

  if (video.paused) void video.play()
  else video.pause()
  return true
}

export function seek(state: AppState, time: number) {
  const video = state.editor.video
  if (video) video.currentTime = time
}

// ─── Adjustments ─────────────────────────────────────────────────────

function change(
  state: AppState, ids: string[], update: (e: Edit) => Edit, tag?: string
) {
  if (!state.library || ids.length === 0) return
  commit(state, setEdits(state.library, ids, update), tag ?? null)
}

function changeCurrent(
  state: AppState, update: (e: Edit) => Edit, tag?: string
) {
  if (state.current) change(state, [state.current], update, tag)
}

export function setSlider(state: AppState, key: SliderKey, value: number) {
  const tag = `edit:${state.current}:${key}`
  changeCurrent(state, e => ({ ...e, [key]: value }), tag)
}

export function resetSlider(state: AppState, key: SliderKey) {
  endCoalescing(state)
  changeCurrent(state, e => ({ ...e, [key]: NEUTRAL_EDIT[key] }))
}

export function resetColour(state: AppState) {
  changeCurrent(state, e => ({ ...e, ...colourOf(NEUTRAL_EDIT) }))
}

export function copySettings(state: AppState) {
  const photo = currentPhoto(state)
  if (!photo) return

  state.clipboard = colourOf(photo.edit)
  showToast(state, 'Settings copied. Paste them onto other photos.')
  render(state)
}

export function pasteSettings(state: AppState, ids: string[]) {
  const clipboard = state.clipboard
  if (!clipboard) return

  change(state, ids, e => ({ ...e, ...clipboard }))
  showToast(state, `Settings pasted onto ${ids.length} ${plural(ids.length)}.`)
}

// ─── Auto ────────────────────────────────────────────────────────────

export async function autoCurrent(state: AppState) {
  const sample = await currentSample(state)
  const photo = currentPhoto(state)
  if (!sample || !photo) return

  const auto = autoTone(sample, photo.edit)
  endCoalescing(state)
  changeCurrent(state, e => ({ ...e, ...auto }))
}

export async function autoWhiteBalanceCurrent(state: AppState) {
  const sample = await currentSample(state)
  if (!sample) return

  const wb = autoWhiteBalance(sample)
  endCoalescing(state)
  changeCurrent(state, e => ({ ...e, ...wb }))
  if (wb.temperature === 0 && wb.tint === 0) {
    showToast(state, 'No colour cast found. Try the eyedropper on ' +
      'something that should be grey.')
  }
}

async function currentSample(state: AppState) {
  const bitmap = state.editor.bitmap
  if (!bitmap || state.editor.loaded !== state.current) return null

  return samplePixels(bitmap, AUTO_EDGE)
}

export async function autoSelection(state: AppState) {
  const ids = [...state.selection]
  if (!state.dirs || ids.length === 0 || state.progress) return

  const total = ids.length
  const progress = { label: 'Auto', done: 0, total, cancelled: false }
  state.progress = progress
  render(state)

  const results = new Map<string, Partial<Colour>>()
  for (const id of ids) {
    if (progress.cancelled) break
    try {
      const photo = state.library!.photos[id]
      const original = await readOriginal(state.dirs, photo)
      const bitmap = photo.video
        ? (await probeVideo(original)).frame
        : await decode(original, 2048)
      const sample = await samplePixels(bitmap, AUTO_EDGE)
      results.set(id, autoTone(sample, state.library!.photos[id].edit))
      bitmap.close()
    } catch {
      // Skipped; reported by the count below.
    }
    progress.done++
    render(state)
  }

  state.progress = null
  let lib = state.library!
  for (const [id, auto] of results) {
    lib = setEdits(lib, [id], e => ({ ...e, ...auto }))
  }
  commit(state, lib)
  showToast(state, `Auto applied to ${results.size} ${plural(results.size)}.`)
  render(state)
}

// ─── Eyedropper ──────────────────────────────────────────────────────

// Sets white balance so the clicked spot (a point on the stage frame,
// in CSS pixels) turns neutral grey.
export function pickWhite(state: AppState, point: Point) {
  const photo = currentPhoto(state)
  const layout = stageLayout(state)
  const bitmap = state.editor.bitmap
  if (!photo || !layout || !bitmap) return

  const u = point.x / layout.css.w
  const v = point.y / layout.css.h
  const matrix = sourceMatrix(photo.edit, layout.source, layout.region)
  const [sx, sy] = applyMatrix(matrix, u, v)
  const rgb = averageAround(state, bitmap, sx, sy)
  state.editor.tool = 'none'
  if (!rgb) return

  const [r, g, b] = rgb.map(srgbToLinear)
  if (Math.min(r, g, b) < 0.002) {
    showToast(state, 'Pick a lighter spot that should be grey.')
    render(state)
    return
  }

  const wb = wbFromRatios(Math.log2(g / r), Math.log2(g / b))
  const slider = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 100)
  endCoalescing(state)
  changeCurrent(state, e => ({
    ...e, temperature: slider(wb.temperature), tint: slider(wb.tint)
  }))
}

function averageAround(
  state: AppState, bitmap: ImageBitmap, sx: number, sy: number
) {
  if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return null

  if (!state.editor.sampler) {
    const k = Math.min(1, SAMPLER_EDGE / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * k)
    const h = Math.round(bitmap.height * k)
    const ctx = new OffscreenCanvas(w, h).getContext('2d', {
      willReadFrequently: true
    })!
    ctx.drawImage(bitmap, 0, 0, w, h)
    state.editor.sampler = ctx
  }

  const ctx = state.editor.sampler
  const x = Math.round(sx * (ctx.canvas.width - 1))
  const y = Math.round(sy * (ctx.canvas.height - 1))
  const left = Math.max(0, x - 2)
  const top = Math.max(0, y - 2)
  const data = ctx.getImageData(left, top, 5, 5).data
  const sum = [0, 0, 0]
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) sum[c] += data[i + c]
  }
  return sum.map(s => s / (data.length / 4) / 255)
}

// ─── Crop and straighten ─────────────────────────────────────────────

function cropContext(state: AppState) {
  const photo = currentPhoto(state)
  const layout = stageLayout(state)
  if (!photo || !layout) return null

  const crop = effectiveCrop(photo.edit, layout.source)
  return { photo, layout, crop, size: layout.size }
}

export function startCropDrag(state: AppState, handle: Handle, start: Point) {
  const ctx = cropContext(state)
  if (!ctx) return

  const ratio = aspectRatio(ctx.photo.edit.aspect, ctx.crop, ctx.size)
  state.editor.drag = { handle, start, crop: ctx.crop, last: ctx.crop, ratio }
}

export function moveCropDrag(state: AppState, at: Point) {
  const drag = state.editor.drag
  const ctx = cropContext(state)
  if (!drag || !ctx) return

  const { layout, size } = ctx
  const dx = ((at.x - drag.start.x) / layout.css.w) * layout.region.w
  const dy = ((at.y - drag.start.y) / layout.css.h) * layout.region.h
  const wanted = resizeCrop(drag.crop, drag.handle, dx, dy, drag.ratio, size)
  const crop = clampCrop(drag.last, wanted, size, ctx.photo.edit.angle)
  drag.last = crop
  changeCurrent(state, e => ({ ...e, crop }), `crop:${state.current}`)
}

export function endCropDrag(state: AppState) {
  state.editor.drag = null
  endCoalescing(state)
}

export function setAspect(state: AppState, aspect: Aspect) {
  const ctx = cropContext(state)
  if (!ctx) return

  const angle = ctx.photo.edit.angle
  const crop = aspectCrop(ctx.crop, aspect, ctx.size, angle)
  changeCurrent(state, e => ({ ...e, aspect, crop }))
}

export function swapOrientation(state: AppState) {
  const ctx = cropContext(state)
  if (!ctx) return

  const crop = swapCrop(ctx.crop, ctx.size, ctx.photo.edit.angle)
  changeCurrent(state, e => ({ ...e, crop }))
}

export function rotate(state: AppState, turn: number) {
  changeCurrent(state, e => {
    const rotate = ((e.rotate + turn + 360) % 360) as Edit['rotate']
    return { ...e, rotate, crop: null }
  })
}

export function flip(state: AppState) {
  changeCurrent(state, e => {
    const crop = e.crop && { ...e.crop, x: 1 - e.crop.x - e.crop.w }
    return { ...e, flip: !e.flip, crop }
  })
}

export function resetCrop(state: AppState) {
  changeCurrent(state, e => {
    return { ...e, crop: null, angle: 0, aspect: 'original' }
  })
}

export function finishHorizon(state: AppState) {
  const line = state.editor.horizon
  const photo = currentPhoto(state)
  state.editor.horizon = null
  state.editor.tool = 'none'
  if (!line || !photo) return

  const dx = line.end.x - line.start.x
  const dy = line.end.y - line.start.y
  if (Math.hypot(dx, dy) < 10) {
    render(state)
    return
  }

  const angle = Math.round(horizonAngle(photo.edit.angle, dx, dy) * 10) / 10
  changeCurrent(state, e => ({ ...e, angle }))
}

function plural(n: number) {
  return n === 1 ? 'photo' : 'photos'
}
