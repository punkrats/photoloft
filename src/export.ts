import { applyBookkeeping } from './commit'
import { exportExif, insertSegment } from './exif'
import { decode, encodeJpeg, offscreen, renderEdit } from './images'
import {
  setAlbumExportName, setExportRecord, setExportSettings, viewPhotos,
  type Album, type ExportSettings, type Photo
} from './library'
import { encodeWithin } from './limit'
import {
  albumFileNames, originalFileNames, sanitizeName, withExtension
} from './naming'
import { render } from './render'
import { exportVideo } from './video-export'
import {
  showToast, type AppState, type ExportForm, type Progress
} from './state'
import {
  exportFolder, readOriginal, removeExportFolderIfEmpty, removeFiles,
  writeFile, type Dirs
} from './storage'

const PRESET_SIZES = ['3840', '2560', '2048', '1600', '1080']
const PRESET_LIMITS = ['500000', '1000000', '2000000', '5000000']
const VIDEO_SIDES = [720, 1080, 0] as const

export function exportDialog(state: AppState, albumIds: string[]) {
  const lib = state.library
  if (!lib || albumIds.length === 0) return

  const s = lib.exportSettings
  const album = albumIds.length === 1
    ? lib.albums.find(a => a.id === albumIds[0])
    : null
  const sizeKey = s.longEdge ? String(s.longEdge) : 'original'
  const limitKey = s.maxBytes ? String(s.maxBytes) : 'none'
  const form: ExportForm = {
    albumIds,
    name: album ? album.exportName ?? album.name : '',
    start: 1,
    naming: s.naming,
    size: PRESET_SIZES.includes(sizeKey) || !s.longEdge ? sizeKey : 'custom',
    customSize: s.longEdge ?? 2048,
    limit: PRESET_LIMITS.includes(limitKey) || !s.maxBytes
      ? limitKey
      : 'custom',
    customLimit: s.maxBytes ? s.maxBytes / 1_000_000 : 1,
    quality: s.quality,
    stripGps: s.stripGps,
    videoSide: String(s.videoSide)
  }
  state.dialog = { kind: 'export', form }
  render(state)
}

export function settingsOf(form: ExportForm): ExportSettings {
  const longEdge = form.size === 'original'
    ? null
    : form.size === 'custom' ? Math.round(form.customSize) : Number(form.size)
  const maxBytes = form.limit === 'none'
    ? null
    : form.limit === 'custom'
      ? Math.round(form.customLimit * 1_000_000)
      : Number(form.limit)

  return {
    naming: form.naming,
    longEdge: longEdge && longEdge > 0 ? longEdge : null,
    maxBytes: maxBytes && maxBytes > 0 ? maxBytes : null,
    quality: Math.min(100, Math.max(60, form.quality)),
    stripGps: form.stripGps,
    videoSide: VIDEO_SIDES.find(s => String(s) === form.videoSide) ?? 720
  }
}

export async function runExport(state: AppState, form: ExportForm) {
  if (!state.library || !state.dirs || state.progress) return

  const settings = settingsOf(form)
  let lib = setExportSettings(state.library, settings)
  if (form.albumIds.length === 1 && form.name.trim()) {
    lib = setAlbumExportName(lib, form.albumIds[0], form.name.trim())
  }
  applyBookkeeping(state, lib)
  state.dialog = null

  const albums = form.albumIds
    .map(id => lib.albums.find(a => a.id === id))
    .filter((a): a is Album => a !== undefined)
  const count = (a: Album) =>
    viewPhotos(lib, { kind: 'album', id: a.id }, 'date').length
  const total = albums.reduce((n, a) => n + count(a), 0)
  const progress = { label: 'Exporting', done: 0, total, cancelled: false }
  state.progress = progress
  render(state)

  let over = 0
  const errors: string[] = []
  for (const album of albums) {
    if (progress.cancelled) break
    const result = await exportAlbum(state, album, form, settings, progress)
    over += result.over
    errors.push(...result.errors)
  }

  state.progress = null
  showToast(state, report(albums, progress, over, errors))
  render(state)
}

async function exportAlbum(
  state: AppState, album: Album, form: ExportForm, settings: ExportSettings,
  progress: Progress
) {
  const dirs = state.dirs!
  const lib = state.library!
  const ids = viewPhotos(lib, { kind: 'album', id: album.id }, 'date')
  const base = form.albumIds.length === 1
    ? form.name.trim() || album.name
    : album.exportName ?? album.name
  const photos = ids.map(id => lib.photos[id])
  const names = (settings.naming === 'album'
    ? albumFileNames(base, ids.length, Math.max(0, Math.round(form.start)))
    : originalFileNames(photos.map(p => {
      return p.video ? withExtension(p.name, 'mp4') : p.name
    })))
    .map((name, i) => (photos[i].video ? withExtension(name, 'mp4') : name))

  const folder = sanitizeName(album.name)
  const dir = await exportFolder(dirs, folder)
  await clearPrevious(dirs, lib.exports[album.id], folder, dir)

  const written: string[] = []
  const errors: string[] = []
  let over = 0
  for (const [i, photo] of photos.entries()) {
    if (progress.cancelled) break
    try {
      const { blob, fits } = photo.video
        ? await exportClip(state, photo, settings, progress)
        : await exportPhoto(state, photo, settings)
      await writeFile(dir, names[i], blob)
      written.push(names[i])
      if (!fits) over++
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    progress.done++
    render(state)
  }

  const record = { folder, files: written }
  applyBookkeeping(state, setExportRecord(state.library!, album.id, record))
  return { over, errors }
}

async function exportClip(
  state: AppState, photo: Photo, settings: ExportSettings, progress: Progress
) {
  const original = await readOriginal(state.dirs!, photo)
  const blob = await exportVideo(photo, original, settings, share => {
    progress.label = `Exporting (video ${Math.round(share * 100)} %)`
    render(state)
  })
  progress.label = 'Exporting'
  return { blob, fits: true }
}

// Deletes exactly the files an earlier export of this album wrote, so
// photos taken out of the album disappear and hand-added files stay.
async function clearPrevious(
  dirs: Dirs,
  previous: { folder: string, files: string[] } | undefined,
  folder: string,
  dir: FileSystemDirectoryHandle
) {
  if (!previous) return
  if (previous.folder === folder) {
    await removeFiles(dir, previous.files)
    return
  }

  const old = await exportFolder(dirs, previous.folder)
  await removeFiles(old, previous.files)
  await removeExportFolderIfEmpty(dirs, previous.folder)
}

async function exportPhoto(
  state: AppState, photo: Photo, settings: ExportSettings
) {
  const file = await readOriginal(state.dirs!, photo)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const renderer = offscreen(state)

  const source = await decode(file, renderer.maxSize)
  const rendered = renderEdit(renderer, source, photo.edit, Infinity)
  source.close()

  const long = Math.max(rendered.width, rendered.height)
  const base = settings.longEdge ? Math.min(1, settings.longEdge / long) : 1
  const sizeAt = (scale: number) => ({
    w: Math.max(1, Math.round(rendered.width * base * scale)),
    h: Math.max(1, Math.round(rendered.height * base * scale))
  })
  const exifOptions = {
    width: 1,
    height: 1,
    stripGps: settings.stripGps,
    takenAt: photo.takenAt,
    meta: photo.meta
  }
  const overhead = exportExif(bytes, exifOptions)?.length ?? 0

  const encode = async (scale: number, quality: number) => {
    const size = sizeAt(scale)
    const blob = await encodeJpeg(rendered, size, quality)
    return { blob, size: blob.size, dims: size }
  }
  const quality = settings.quality / 100
  const out = await encodeWithin(encode, quality, settings.maxBytes, overhead)
  rendered.close()

  const { dims, blob } = out.result
  const final = { ...exifOptions, width: dims.w, height: dims.h }
  const app1 = exportExif(bytes, final)
  if (!app1) return { blob, fits: out.fits }

  const jpeg = new Uint8Array(await blob.arrayBuffer())
  const withExif = insertSegment(jpeg, app1)
  return { blob: new Blob([withExif], { type: 'image/jpeg' }), fits: out.fits }
}

function report(
  albums: Album[], progress: Progress, over: number, errors: string[]
) {
  const where = albums.length === 1
    ? `Exports/${sanitizeName(albums[0].name)}`
    : 'Exports'
  const done = progress.done - errors.length
  const files = `${done} ${done === 1 ? 'file' : 'files'}`
  const parts = [`Exported ${files} to ${where}.`]
  if (progress.cancelled) parts.unshift('Export cancelled.')
  if (over) parts.push(`${over} could not get under the size limit.`)
  if (errors.length) {
    parts.push(`${errors.length} failed: ${[...new Set(errors)].join('; ')}`)
  }
  return parts.join(' ')
}
