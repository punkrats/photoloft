import {
  decode, encodeJpeg, offscreen, probeVideo, renderEdit
} from './images'
import { render } from './render'
import type { Edit } from './schema'
import type { AppState } from './state'
import { readOriginal, readThumb, writeThumb } from './storage'

const THUMB_EDGE = 400
const WORK_EDGE = 1024
const REFRESH_DELAY = 600
const KEPT_THUMBS = 600

export async function makeThumb(
  state: AppState, file: Blob, edit: Edit, video: boolean
) {
  const source = video
    ? (await probeVideo(file)).frame
    : await decode(file, WORK_EDGE)
  return thumbFrom(state, source, edit)
}

// Renders a decoded frame as a thumbnail and releases it.
export async function thumbFrom(
  state: AppState, source: ImageBitmap, edit: Edit
) {
  const rendered = renderEdit(offscreen(state), source, edit, THUMB_EDGE)
  source.close()

  const size = { w: rendered.width, h: rendered.height }
  const blob = await encodeJpeg(rendered, size, 0.85)
  rendered.close()
  return blob
}

export function showThumb(state: AppState, id: string, blob: Blob) {
  const old = state.thumbs.get(id)
  if (old) URL.revokeObjectURL(old)
  state.thumbs.set(id, URL.createObjectURL(blob))
}

// Loads thumbnails for the grid cells and filmstrip items on screen and
// lets go of off-screen ones once too many are held.
export function loadVisibleThumbs(state: AppState) {
  const items = state.root.querySelectorAll<HTMLElement>(
    '.cell[data-id], .film-item[data-id]'
  )
  const visible = new Set([...items].map(item => item.dataset.id!))
  for (const id of visible) {
    if (state.thumbs.has(id) || state.thumbsPending.has(id)) continue
    void loadThumb(state, id)
  }
  if (state.thumbs.size > KEPT_THUMBS) forgetThumbs(state, visible)
}

function forgetThumbs(state: AppState, visible: Set<string>) {
  for (const [id, url] of state.thumbs) {
    if (visible.has(id)) continue
    if (url) URL.revokeObjectURL(url)
    state.thumbs.delete(id)
  }
}

async function loadThumb(state: AppState, id: string) {
  if (!state.dirs) return

  state.thumbsPending.add(id)
  try {
    const blob = await readThumb(state.dirs, id)
    if (blob) showThumb(state, id, blob)
    else refreshThumbs(state, [id], 0)
  } finally {
    state.thumbsPending.delete(id)
    render(state)
  }
}

// Re-renders thumbnails once the photos have been left alone for a
// moment, so a slider drag does not queue a render per tick.
export function refreshThumbs(
  state: AppState, ids: string[], delay = REFRESH_DELAY
) {
  for (const id of ids) state.thumbQueue.add(id)
  if (state.thumbTimer) clearTimeout(state.thumbTimer)

  state.thumbTimer = window.setTimeout(() => {
    state.thumbTimer = null
    void work(state)
  }, delay)
}

async function work(state: AppState) {
  if (state.thumbBusy) return

  state.thumbBusy = true
  try {
    for (const id of state.thumbQueue) {
      state.thumbQueue.delete(id)
      await rebuild(state, id)
    }
  } finally {
    state.thumbBusy = false
  }
}

async function rebuild(state: AppState, id: string) {
  const photo = state.library?.photos[id]
  const dirs = state.dirs
  if (!photo || !dirs) return

  try {
    const original = await readOriginal(dirs, photo)
    const blob = await makeThumb(state, original, photo.edit, !!photo.video)
    await writeThumb(dirs, id, blob)
    showThumb(state, id, blob)
  } catch {

    // An empty URL marks the thumbnail as unavailable, so it is not
    // retried on every render.
    state.thumbs.set(id, '')
  }
  render(state)
}
