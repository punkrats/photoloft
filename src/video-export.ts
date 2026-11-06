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
  rate: Rate
  creationTime: string | null
  stripGps: boolean
  meta: Meta
  trim: Trim | null
}

// x264's rate control: a constant quality in one pass, or a bitrate in
// one or two passes.
type Rate = { crf: number } | { kbps: number, passes: 1 | 2 }

type Choices = Pick<
  ExportSettings,
  'videoSide' | 'stripGps' | 'videoEncoding' | 'videoCrf' | 'videoBitrate'
  | 'videoTwoPass'
>

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
    rate: rateOf(choices),
    creationTime: photo.takenAt ? new Date(photo.takenAt).toISOString() : null,
    stripGps: choices.stripGps,
    meta: photo.meta,
    trim: photo.video?.trim ?? null
  }
}

function rateOf(choices: Choices): Rate {
  if (choices.videoEncoding === 'quality') return { crf: choices.videoCrf }

  const kbps = Math.round(choices.videoBitrate * 1000)
  return { kbps, passes: choices.videoTwoPass ? 2 : 1 }
}

// HTTP header values only carry Latin-1, so everything outside ASCII
// travels as JSON escapes.
export function settingsHeader(settings: VideoSettings) {
  return JSON.stringify(settings).replace(/[^\x00-\x7f]/g, c => {
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

// Uploads the original to the local server, which runs ffmpeg with the
// colour table and settings, and returns the exported MP4. An abort
// rejects the request under way or the next one, and has the server
// stop ffmpeg and drop the job.
export async function exportVideo(
  photo: Photo, original: Blob, choices: Choices, signal: AbortSignal,
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
  const init = { method: 'POST', headers, body, signal }
  const started = await fetch('/api/videos', init)
  if (!started.ok) throw new Error(await started.text())

  const job = `/api/videos/${(await started.json()).job}`
  try {
    return await result(job, headers, signal, onProgress)
  } catch (error) {
    if (signal.aborted) {
      void fetch(job, { method: 'DELETE', headers }).catch(() => {})
    }
    throw error
  }
}

// Waits for the job at the address `job` to end and fetches the video
// it made.
async function result(
  job: string, headers: HeadersInit, signal: AbortSignal,
  onProgress: (share: number) => void
) {
  for (;;) {
    const response = await fetch(job, { headers, signal })
    if (!response.ok) {
      throw new Error('The Photoloft service lost the video export')
    }
    const status = await response.json()
    if (status.state === 'failed') throw new Error(status.error)
    if (status.state === 'done') break

    onProgress(status.progress)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }

  const video = await fetch(`${job}/result`, { headers, signal })
  if (!video.ok) throw new Error('The exported video could not be fetched')
  return video.blob()
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
