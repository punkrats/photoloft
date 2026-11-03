import { bboxRegion, effectiveCrop, orientedSize } from './geometry'
import type { Photo } from './library'
import { cubeLut } from './lut'
import { colourOf } from './schema'

export type VideoSettings = {
  rotate: number
  flip: boolean
  angle: number
  crop: { x: number, y: number, w: number, h: number }
  shortSide: 0 | 720 | 1080
  crf: number
  creationTime: string | null
}

const POLL_MS = 400

// What the server needs to export a video: quarter turns, flip and
// straighten as set, and the crop as fractions of the straightened
// frame, which is what ffmpeg sees after rotating.
export function videoSettings(
  photo: Photo, shortSide: VideoSettings['shortSide']
): VideoSettings {
  const edit = photo.edit
  const source = { w: photo.width, h: photo.height }
  const size = orientedSize(source.w, source.h, edit.rotate)
  const crop = effectiveCrop(edit, source)
  const box = bboxRegion(size, edit.angle)
  const fraction = (v: number) => Math.min(1, Math.max(0, round(v)))

  const x = fraction((crop.x - box.x) / box.w)
  const y = fraction((crop.y - box.y) / box.h)
  return {
    rotate: edit.rotate,
    flip: edit.flip,
    angle: edit.angle,
    crop: {
      x,
      y,
      w: Math.min(1 - x, fraction(crop.w / box.w)),
      h: Math.min(1 - y, fraction(crop.h / box.h))
    },
    shortSide,
    crf: 20,
    creationTime: photo.takenAt ? new Date(photo.takenAt).toISOString() : null
  }
}

// Uploads the original to the local server, which runs ffmpeg with the
// colour table and settings, and returns the exported MP4.
export async function exportVideo(
  photo: Photo, original: Blob, shortSide: VideoSettings['shortSide'],
  onProgress: (share: number) => void
) {
  const token = await serverToken()
  const lut = cubeLut(colourOf(photo.edit))
  const settings = videoSettings(photo, shortSide)
  const headers = {
    'X-Lightbox-Token': token,
    'X-Lightbox-Settings': JSON.stringify(settings),
    'X-Lightbox-Lut-Length': String(lut.length)
  }
  const body = new Blob([lut, original])
  const started = await fetch('/api/videos', { method: 'POST', headers, body })
  if (!started.ok) throw new Error(await started.text())

  const { job } = await started.json()
  for (;;) {
    const status = await (await fetch(`/api/videos/${job}`, { headers })).json()
    if (status.state === 'failed') throw new Error(status.error)
    if (status.state === 'done') break

    onProgress(status.progress)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }

  const result = await fetch(`/api/videos/${job}/result`, { headers })
  if (!result.ok) throw new Error('The exported video could not be fetched')
  return result.blob()
}

async function serverToken() {
  const response = await fetch('/api/token').catch(() => null)
  if (!response?.ok) {
    throw new Error('Video export needs the Lightbox service ' +
      '(open Lightbox from the app launcher)')
  }
  return (await response.json()).token as string
}

function round(v: number) {
  return Math.round(v * 1e6) / 1e6
}
