import { bboxRegion, effectiveCrop, orientedSize } from './geometry'
import type { ExportSettings, Photo, Trim } from './library'
import { cubeLut } from './lut'
import type { Meta } from './meta'
import { colourOf } from './schema'

export type VideoSettings = {
  rotate: number
  flip: boolean
  angle: number
  crop: { x: number, y: number, w: number, h: number }
  shortSide: 0 | 720 | 1080
  crf: number
  creationTime: string | null
  stripGps: boolean
  meta: Meta
  trim: Trim | null
}

type Choices = Pick<ExportSettings, 'videoSide' | 'stripGps'>

const POLL_MS = 400

// What the server needs to export a video: quarter turns, flip and
// straighten as set, the crop as fractions of the straightened frame,
// which is what ffmpeg sees after rotating, the info to write and the
// part of the clip to keep.
export function videoSettings(photo: Photo, choices: Choices): VideoSettings {
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
    shortSide: choices.videoSide,
    crf: 20,
    creationTime: photo.takenAt ? new Date(photo.takenAt).toISOString() : null,
    stripGps: choices.stripGps,
    meta: photo.meta,
    trim: photo.video?.trim ?? null
  }
}

// HTTP header values only carry Latin-1, so everything outside ASCII
// travels as JSON escapes.
export function settingsHeader(settings: VideoSettings) {
  return JSON.stringify(settings).replace(/[^\x00-\x7f]/g, c => {
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

// Uploads the original to the local server, which runs ffmpeg with the
// colour table and settings, and returns the exported MP4.
export async function exportVideo(
  photo: Photo, original: Blob, choices: Choices,
  onProgress: (share: number) => void
) {
  const token = await serverToken()
  const lut = cubeLut(colourOf(photo.edit))
  const settings = videoSettings(photo, choices)
  const headers = {
    'X-Photoloft-Token': token,
    'X-Photoloft-Settings': settingsHeader(settings),
    'X-Photoloft-Lut-Length': String(lut.length)
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
    throw new Error('Video export needs the Photoloft service ' +
      '(open Photoloft from the app launcher)')
  }
  return (await response.json()).token as string
}

function round(v: number) {
  return Math.round(v * 1e6) / 1e6
}
