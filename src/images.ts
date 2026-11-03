import { effectiveCrop, orientedSize, outputSize, type Size } from './geometry'
import { Renderer } from './pipeline'
import type { Edit } from './schema'
import type { AppState } from './state'

// Shared offscreen renderer for thumbnails and exports. Every use is a
// synchronous setSource-draw-transfer block, so interleaved async jobs
// never see each other's source.
export function offscreen(state: AppState) {
  state.offscreen ??= new Renderer(new OffscreenCanvas(1, 1))
  return state.offscreen
}

// Decodes with EXIF orientation applied, shrinking anything larger
// than `max` on its long edge.
export async function decode(file: Blob, max: number) {
  const options = { imageOrientation: 'from-image' } as const
  const bitmap = await createImageBitmap(file, options)
  if (Math.max(bitmap.width, bitmap.height) <= max) return bitmap

  const fitted = await resize(bitmap, fit(bitmap, max))
  bitmap.close()
  return fitted
}

// Renders `edit` at the crop's native resolution, capped at `limit`
// pixels on the long edge.
export function renderEdit(
  renderer: Renderer, source: ImageBitmap, edit: Edit, limit: number
) {
  const size = { w: source.width, h: source.height }
  const region = effectiveCrop(edit, size)
  const native = outputSize(region, orientedSize(size.w, size.h, edit.rotate))
  const target = fit(native, Math.min(limit, renderer.maxSize))

  renderer.setSource(source)
  renderer.draw(edit, { region, width: target.w, height: target.h })
  return (renderer.canvas as OffscreenCanvas).transferToImageBitmap()
}

export async function encodeJpeg(
  bitmap: ImageBitmap, size: Size, quality: number
) {
  const canvas = new OffscreenCanvas(size.w, size.h)
  const ctx = canvas.getContext('2d')!
  if (size.w === bitmap.width && size.h === bitmap.height) {
    ctx.drawImage(bitmap, 0, 0)
  } else {
    const resized = await resize(bitmap, size)
    ctx.drawImage(resized, 0, 0)
    resized.close()
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

// RGBA pixels of a small copy, for Auto.
export async function samplePixels(bitmap: ImageBitmap, longEdge: number) {
  const size = fit(bitmap, longEdge)
  const small = await resize(bitmap, size)
  const ctx = new OffscreenCanvas(size.w, size.h).getContext('2d')!
  ctx.drawImage(small, 0, 0)
  small.close()
  return ctx.getImageData(0, 0, size.w, size.h).data
}

// A video element ready to show `file`, with its first frame decoded.
// Fails for formats the browser cannot play.
export async function openVideo(file: Blob) {
  const video = document.createElement('video')
  video.preload = 'auto'
  video.playsInline = true
  video.src = URL.createObjectURL(file)
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve()
    video.onerror = () => reject(new Error('This video format cannot play'))
  })
  return video
}

export function closeVideo(video: HTMLVideoElement) {
  video.pause()
  URL.revokeObjectURL(video.src)
  video.removeAttribute('src')
  video.load()
}

// The frame on screen as an image, with the phone's rotation applied.
export function videoFrame(video: HTMLVideoElement) {
  return createImageBitmap(video)
}

// Size, length and a frame a moment in, for import and thumbnails.
export async function probeVideo(file: Blob) {
  const video = await openVideo(file)
  try {
    video.muted = true
    video.currentTime = Math.min(1, video.duration / 10)
    await new Promise(resolve => {
      video.onseeked = resolve
    })
    const frame = await videoFrame(video)
    const info = {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration
    }
    return { ...info, frame }
  } finally {
    closeVideo(video)
  }
}

export function fit(s: Size | ImageBitmap, longEdge: number): Size {
  const w = 'w' in s ? s.w : s.width
  const h = 'h' in s ? s.h : s.height
  const k = Math.min(1, longEdge / Math.max(w, h))
  const round = (v: number) => Math.max(1, Math.round(v * k))
  return { w: round(w), h: round(h) }
}

function resize(bitmap: ImageBitmap, size: Size) {
  return createImageBitmap(bitmap, {
    resizeWidth: size.w,
    resizeHeight: size.h,
    resizeQuality: 'high'
  })
}
