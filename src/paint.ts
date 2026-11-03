import { effectiveCrop, orientedSize, outputSize } from './geometry'
import { fit } from './images'
import type { Photo } from './library'
import { render } from './render'
import { stageLayout } from './stage-layout'
import { currentPhoto, type AppState } from './state'
import { histogramOf } from './ui/histogram'

const HISTOGRAM_EDGE = 256
const HISTOGRAM_DELAY = 120

type HistogramKey = { photo: Photo, before: boolean }

// Draws the current photo onto the stage canvas.
export function paint(state: AppState) {
  const { renderer, loaded } = state.editor
  const photo = currentPhoto(state)
  if (state.mode === 'grid' || !renderer || !photo || loaded !== photo.id) {
    return
  }

  const layout = stageLayout(state)!
  const target = {
    region: layout.region,
    width: layout.px.w,
    height: layout.px.h,
    neutral: state.before
  }
  renderer.draw(photo.edit, target)
  scheduleHistogram(state, photo)
}

// The histogram always covers the cropped photo, also while the crop
// tool shows the whole frame.
function scheduleHistogram(state: AppState, photo: Photo) {
  const editor = state.editor
  const last = editor.histogramKey as HistogramKey | null
  if (last && last.photo === photo && last.before === state.before) return

  editor.histogramKey = { photo, before: state.before }
  if (editor.histogramTimer) clearTimeout(editor.histogramTimer)

  editor.histogramTimer = window.setTimeout(() => {
    editor.histogramTimer = null
    const renderer = editor.renderer
    const source = renderer?.sourceSize
    if (!renderer || !source || editor.loaded !== photo.id) return

    const region = effectiveCrop(photo.edit, source)
    const size = orientedSize(source.w, source.h, photo.edit.rotate)
    const small = fit(outputSize(region, size), HISTOGRAM_EDGE)
    const target = {
      region, width: small.w, height: small.h, neutral: state.before
    }
    const pixels = renderer.read(photo.edit, target)
    editor.histogram = pixels ? histogramOf(pixels) : null
    render(state)
  }, HISTOGRAM_DELAY)
}
