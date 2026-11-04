import { autoTone, autoWhiteBalance, hasSettings } from './auto'
import { srgbToLinear, wbFromRatios } from './colour'
import { commit } from './commit'
import {
  applyMatrix, aspectCrop, aspectRatio, clampCrop, effectiveCrop,
  horizonAngle, resizeCrop, sourceMatrix, swapCrop, type Handle
} from './geometry'
import {
  closeVideo, decode, openVideo, probeVideo, samplePixels, videoFrame
} from './images'
import {
  draggedTrim, markedTrim, setEdits, setTrim, trimRange, type Photo,
  type TrimEdge
} from './library'
import { Renderer } from './pipeline'
import { render } from './render'
import {
  colourOf, NEUTRAL_EDIT, type Aspect, type Colour, type Edit, type SliderKey
} from './schema'
import { stageLayout } from './stage-layout'
import {
  currentPhoto, endCoalescing, showToast, viewIds, type AppState, type Point
} from './state'
import { readOriginal, type Dirs } from './storage'

const AUTO_EDGE = 256
const AUTO_SOURCE = 2048
const AUTO_DELAY = 400
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
  void judgeAuto(state, id)
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
    stopAtOut(state, id, video)
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
}

function followFrames(state: AppState, id: string, video: HTMLVideoElement) {
  video.requestVideoFrameCallback(() => {
    if (state.editor.video !== video) return
    void grab(state, id, video)
    stopAtOut(state, id, video)
    if (!video.paused) followFrames(state, id, video)
  })
}

// Playback pauses once it reaches the out mark. Checked on every frame,
// and on each time update for a hidden page, which gets no frames.
function stopAtOut(state: AppState, id: string, video: HTMLVideoElement) {
  const info = state.library?.photos[id]?.video
  if (!info || video.paused) return
  if (video.currentTime >= trimRange(info).end) video.pause()
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

// Play starts at the in mark from a position before it, or at or past
// the out mark.
export function togglePlay(state: AppState) {
  const video = state.editor.video
  const info = currentPhoto(state)?.video
  if (!video || !info) return false

  if (!video.paused) {
    video.pause()
    return true
  }
  const { start, end } = trimRange(info)
  const at = video.currentTime
  if (at < start || at >= end) video.currentTime = start
  void video.play()
  return true
}

export function seek(state: AppState, time: number) {
  const video = state.editor.video
  if (video) video.currentTime = time
}

// The digit keys: 0 to 9 tenths of the whole clip.
export function jumpTo(state: AppState, share: number) {
  const info = currentPhoto(state)?.video
  if (info) seek(state, info.duration * share)
}

// A grip moves its mark and shows the frame there; the ticks of one
// drag make one undo step. Held at its limit, the grip changes nothing
// and `commit` draws nothing, so the render here puts it back in the
// same frame, also while the video is still loading and cannot seek.
export function dragTrim(state: AppState, edge: TrimEdge, at: number) {
  const photo = currentPhoto(state)
  if (!photo?.video) return

  const trim = draggedTrim(photo.video, edge, at)
  const tag = `trim:${photo.id}:${edge}`
  commit(state, setTrim(state.library!, photo.id, trim), tag)
  seek(state, trim[edge])
  render(state)
}

// I and O: the mark goes where the video is.
export function markTrim(state: AppState, edge: TrimEdge) {
  const photo = currentPhoto(state)
  const video = state.editor.video
  if (!photo?.video || !video) return

  const trim = markedTrim(photo.video, edge, video.currentTime)
  commit(state, setTrim(state.library!, photo.id, trim))
}

export function resetTrim(state: AppState) {
  const photo = currentPhoto(state)
  if (photo) commit(state, setTrim(state.library!, photo.id, null))
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

// A press on a photo that has Auto's settings already changes nothing
// and records nothing.
export async function autoCurrent(state: AppState) {
  const id = state.current
  if (!id) return

  const settings = await autoSettings(state, id).catch((error: unknown) => {
    showToast(state, `Could not open ${String(error)}`)
    return null
  })
  const photo = currentPhoto(state)
  if (settings && photo?.id === id && !hasSettings(photo.edit, settings)) {
    endCoalescing(state)
    changeCurrent(state, e => ({ ...e, ...settings }))
  }
  render(state)
}

// Works out Auto's settings once a photo has been open a moment, so the
// Auto button can grey out; stepping on through photos never waits for
// it.
async function judgeAuto(state: AppState, id: string) {
  await new Promise(resolve => setTimeout(resolve, AUTO_DELAY))
  if (state.current !== id || state.mode === 'grid') return

  await autoSettings(state, id).catch(() => null)
  render(state)
}

// Auto's settings for photo `id` under its white balance now, or null
// once the editor shows another photo. The sample is taken once per
// photo shown, the settings once per white balance.
async function autoSettings(state: AppState, id: string) {
  const editor = state.editor
  const photo = state.library?.photos[id]
  if (!photo || !state.dirs) return null

  if (editor.auto?.id !== id) {
    editor.auto = { id, sample: autoSample(state.dirs, photo), settings: [] }
  }
  const auto = editor.auto
  const sample = await auto.sample
  const edit = state.library?.photos[id]?.edit
  if (!edit || editor.auto !== auto || state.current !== id) return null

  const { temperature, tint } = edit
  const known = auto.settings.find(s => {
    return s.temperature === temperature && s.tint === tint
  })
  if (known) return known

  const settings = { temperature, tint, ...autoTone(sample, edit) }
  auto.settings.push(settings)
  return settings
}

// Auto's pixels for a photo: the original at 2048 px at most, or a
// video's thumbnail frame, shrunk to AUTO_EDGE. The editor and the
// selection bar share them, so Auto lands on the same values.
async function autoSample(dirs: Dirs, photo: Photo) {
  const original = await readOriginal(dirs, photo)
  const bitmap = photo.video
    ? (await probeVideo(original)).frame
    : await decode(original, AUTO_SOURCE)
  try {
    return await samplePixels(bitmap, AUTO_EDGE)
  } finally {
    bitmap.close()
  }
}

// A press on a photo that has this white balance already changes
// nothing and records nothing; the toast for no cast still shows.
export async function autoWhiteBalanceCurrent(state: AppState) {
  const id = state.current
  if (!id) return

  const sample = await currentSample(state)
  const photo = currentPhoto(state)
  if (!sample || photo?.id !== id) return

  const wb = autoWhiteBalance(sample)
  if (!hasSettings(photo.edit, wb)) {
    endCoalescing(state)
    changeCurrent(state, e => ({ ...e, ...wb }))
  }
  if (wb.temperature === 0 && wb.tint === 0) {
    showToast(state, 'No colour cast found. Try the eyedropper on ' +
      'something that should be grey.')
  }
  render(state)
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
      const sample = await autoSample(state.dirs, state.library!.photos[id])
      results.set(id, autoTone(sample, state.library!.photos[id].edit))
    } catch {
      // Skipped; reported by the count below.
    }
    progress.done++
    render(state)
  }

  // Only photos without their values change, so pressing Auto again
  // records nothing.
  state.progress = null
  let lib = state.library!
  const changed = [...results].filter(([id, auto]) => {
    const edit = lib.photos[id]?.edit
    return edit && !hasSettings(edit, auto)
  })
  for (const [id, auto] of changed) {
    lib = setEdits(lib, [id], e => ({ ...e, ...auto }))
  }
  commit(state, lib)

  const n = changed.length
  if (n || !results.size) {
    const count = `${n} ${plural(n)}`
    showToast(state, `Auto applied to ${count}.`)
  } else {
    const these = results.size === 1
      ? 'This photo already has'
      : `These ${results.size} photos already have`
    showToast(state, `${these} Auto's settings.`)
  }
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
