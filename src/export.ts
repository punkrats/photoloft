import { applyBookkeeping } from './commit'
import { exportExif, insertSegment } from './exif'
import { formatList } from './format'
import { decode, encodeJpeg, offscreen, renderEdit } from './images'
import {
  setAlbumExportFolder, setAlbumExportName, setExportRecord,
  setExportSettings, videoBitrate, videoCrf, viewPhotos, type Album,
  type ExportRecord, type ExportSettings, type Library, type Photo
} from './library'
import { encodeWithin } from './limit'
import {
  albumFileNames, originalFileNames, PHOTOS_NAME, sanitizeName, withExtension
} from './naming'
import { render } from './render'
import { exportVideo } from './video-export'
import {
  currentAlbum, showToast, type AppState, type ExportForm, type Progress
} from './state'
import {
  exportFolder, exportsFolder, openFolder, readOriginal,
  removeExportFolderIfEmpty, removeFiles, saveExportFolders,
  SELECTION_FOLDER, writeFile, type Dirs
} from './storage'

const PRESET_SIZES = ['3840', '2560', '2048', '1600', '1080']
const PRESET_LIMITS = ['500000', '1000000', '2000000', '5000000']
const VIDEO_SIDES = [720, 1080, 0] as const

// What one export writes: an album's photos or the photos picked, and
// the folder picked for them, or null for their place under Exports.
type Target = {
  album: Album | null
  ids: string[]
  picked: FileSystemDirectoryHandle | null
}

// Opens the dialog for albums, or for photos picked. Photos start with
// their own names each time; numbered, they take the open album's name,
// else `PHOTOS_NAME`.
export function exportDialog(
  state: AppState, albumIds: string[], photoIds: string[] = []
) {
  const lib = state.library
  const dirs = state.dirs
  const empty = albumIds.length + photoIds.length === 0
  if (!lib || !dirs || empty || state.progress) return

  const s = lib.exportSettings
  const photos = photoIds.length > 0
  const album = photos
    ? currentAlbum(state)
    : albumIds.length === 1
      ? lib.albums.find(a => a.id === albumIds[0])
      : null
  const folder = photos
    ? dirs.folders[SELECTION_FOLDER]?.name ?? null
    : album?.exportFolder ?? null
  const sizeKey = s.longEdge ? String(s.longEdge) : 'original'
  const limitKey = s.maxBytes ? String(s.maxBytes) : 'none'
  const form: ExportForm = {
    albumIds,
    photoIds,
    name: album ? album.exportName ?? album.name : photos ? PHOTOS_NAME : '',
    start: 1,
    naming: photos ? 'original' : s.naming,
    size: PRESET_SIZES.includes(sizeKey) || !s.longEdge ? sizeKey : 'custom',
    customSize: s.longEdge ?? 2048,
    limit: PRESET_LIMITS.includes(limitKey) || !s.maxBytes
      ? limitKey
      : 'custom',
    customLimit: s.maxBytes ? s.maxBytes / 1_000_000 : 1,
    quality: s.quality,
    stripGps: s.stripGps,
    videoSide: String(s.videoSide),
    videoEncoding: s.videoEncoding,
    videoCrf: s.videoCrf,
    videoBitrate: s.videoBitrate,
    videoTwoPass: s.videoTwoPass,
    folder,
    picked: null
  }
  state.dialog = { kind: 'export', form }
  render(state)
}

// The key of the dialog's folder in `dirs.folders`.
export function folderKey(form: ExportForm) {
  return form.photoIds.length ? SELECTION_FOLDER : form.albumIds[0]
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
    videoSide: VIDEO_SIDES.find(s => String(s) === form.videoSide) ?? 720,
    videoEncoding: form.videoEncoding,
    videoCrf: videoCrf(form.videoCrf),
    videoBitrate: videoBitrate(form.videoBitrate),
    videoTwoPass: form.videoTwoPass
  }
}

// The settings become the shared ones, except that photos picked leave
// the albums' choice of file names alone.
export async function runExport(state: AppState, form: ExportForm) {
  if (!state.library || !state.dirs || state.progress) return

  const dirs = state.dirs
  const settings = settingsOf(form)
  const naming = form.photoIds.length
    ? state.library.exportSettings.naming
    : settings.naming
  let lib = setExportSettings(state.library, { ...settings, naming })
  if (form.albumIds.length === 1) lib = albumChoices(lib, form)
  const moved = keepFolder(dirs, form)
  applyBookkeeping(state, lib)
  state.dialog = null

  const cancel = new AbortController()
  const progress = { label: 'Exporting', done: 0, total: 0, cancel }
  state.progress = progress
  render(state)

  const { targets, closed } = await openTargets(dirs, lib, form)
  if (moved) await saveExportFolders(dirs)
  progress.total = targets.reduce((n, t) => n + t.ids.length, 0)
  render(state)

  let over = 0
  const errors: string[] = []
  for (const target of targets) {
    if (cancel.signal.aborted) break
    const result = await exportTarget(state, target, form, settings, progress)
    over += result.over
    errors.push(...result.errors)
  }

  state.progress = null
  showToast(state, report(targets, closed, progress, over, errors))
  render(state)
}

// What the dialog of one album sets for it: the export name and folder.
// A folder newly picked has no export of the album in it yet, so a
// record of the last export to another picked folder is emptied and
// those files stay there.
function albumChoices(lib: Library, form: ExportForm) {
  const id = form.albumIds[0]
  const name = form.name.trim()
  let next = setAlbumExportFolder(lib, id, form.folder)
  if (name) next = setAlbumExportName(next, id, name)

  const moved = form.picked && next.exports[id]?.folder === null
  return moved ? setExportRecord(next, id, { folder: null, files: [] }) : next
}

// Keeps the folder picked in the dialog for its album or for photos,
// and says whether `dirs.folders` changed. The photos' folder is known
// by its handle alone, so Use library folder forgets the handle.
function keepFolder(dirs: Dirs, form: ExportForm) {
  const key = folderKey(form)
  if (form.picked) {
    dirs.folders[key] = form.picked
    return true
  }
  if (key !== SELECTION_FOLDER || form.folder || !dirs.folders[key]) {
    return false
  }
  delete dirs.folders[key]
  return true
}

// Opens the picked folders before anything else is awaited: after a
// browser restart the browser asks for access, and its prompt shows
// only while the press still counts as a user gesture. A handle is used
// only under the name the dialog showed. Exports whose folder cannot be
// opened stay out; `closed` names their folders.
async function openTargets(dirs: Dirs, lib: Library, form: ExportForm) {
  const targets: Target[] = []
  const closed: string[] = []
  for (const { album, ids, key, name } of sources(lib, form)) {
    const handle = dirs.folders[key]
    if (!name) {
      targets.push({ album, ids, picked: null })
    } else if (handle?.name === name && (await openFolder(handle))) {
      targets.push({ album, ids, picked: handle })
    } else {
      closed.push(name)
    }
  }
  return { targets, closed }
}

// What the dialog exports: the photos picked, or each album's photos,
// with the key of their folder in `dirs.folders` and its name.
function sources(lib: Library, form: ExportForm) {
  if (form.photoIds.length) {
    const ids = form.photoIds.filter(id => lib.photos[id])
    return [{ album: null, ids, key: SELECTION_FOLDER, name: form.folder }]
  }

  return form.albumIds
    .map(id => lib.albums.find(a => a.id === id))
    .filter((a): a is Album => a !== undefined)
    .map(album => ({
      album,
      ids: viewPhotos(lib, { kind: 'album', id: album.id }, 'date'),
      key: album.id,
      name: album.exportFolder ?? null
    }))
}

async function exportTarget(
  state: AppState, target: Target, form: ExportForm,
  settings: ExportSettings, progress: Progress
) {
  const { album, picked } = target
  const dirs = state.dirs!
  const lib = state.library!
  const photos = target.ids
    .map(id => lib.photos[id])
    .filter(p => p !== undefined)
  const start = Math.max(0, Math.round(form.start))
  const names = (settings.naming === 'album'
    ? albumFileNames(baseName(form, album), photos.length, start)
    : originalFileNames(photos.map(p => {
      return p.video ? withExtension(p.name, 'mp4') : p.name
    })))
    .map((name, i) => (photos[i].video ? withExtension(name, 'mp4') : name))

  const folder = album ? sanitizeName(album.name) : null
  const dir = picked ??
    (folder ? await exportFolder(dirs, folder) : await exportsFolder(dirs))
  const place = picked ? null : folder
  if (album) await clearPrevious(dirs, lib.exports[album.id], place, dir)

  const written: string[] = []
  const errors: string[] = []
  let over = 0
  // A clip cancelled half way neither counts nor fails.
  for (const [i, photo] of photos.entries()) {
    if (progress.cancel.signal.aborted) break
    try {
      const { blob, fits } = photo.video
        ? await exportClip(state, photo, settings, progress)
        : await exportPhoto(state, photo, settings)
      await writeFile(dir, names[i], blob)
      written.push(names[i])
      if (!fits) over++
    } catch (error) {
      if (progress.cancel.signal.aborted) break
      errors.push(error instanceof Error ? error.message : String(error))
    }
    progress.done++
    render(state)
  }

  if (album) {
    const record = { folder: place, files: written }
    applyBookkeeping(state, setExportRecord(state.library!, album.id, record))
  }
  return { over, errors }
}

// The name numbered files take: the one typed in the dialog of one
// album or of photos, else the album's export name.
function baseName(form: ExportForm, album: Album | null) {
  const typed = form.name.trim()
  if (!album) return typed || PHOTOS_NAME
  if (form.albumIds.length === 1) return typed || album.name
  return album.exportName ?? album.name
}

async function exportClip(
  state: AppState, photo: Photo, settings: ExportSettings, progress: Progress
) {
  const original = await readOriginal(state.dirs!, photo)
  const signal = progress.cancel.signal
  try {
    const blob = await exportVideo(photo, original, settings, signal, share => {
      progress.label = `Exporting (video ${Math.round(share * 100)} %)`
      render(state)
    })
    return { blob, fits: true }
  } finally {
    progress.label = 'Exporting'
  }
}

// Deletes exactly the files the album's last export wrote when it went
// to the same place, so photos taken out of the album disappear and
// hand-added files stay. A picked folder's record always belongs to the
// album's handle (see `albumChoices`). An album renamed inside Exports
// takes its files out of its old folder there, which goes once empty.
async function clearPrevious(
  dirs: Dirs,
  previous: ExportRecord | undefined,
  folder: string | null,
  dir: FileSystemDirectoryHandle
) {
  if (!previous) return
  if (previous.folder === folder) {
    await removeFiles(dir, previous.files)
    return
  }
  if (previous.folder === null || folder === null) return

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
  targets: Target[], closed: string[], progress: Progress, over: number,
  errors: string[]
) {
  const done = progress.done - errors.length
  const files = `${done} ${done === 1 ? 'file' : 'files'}`
  const parts = targets.length ? [`Exported ${files}${where(targets)}.`] : []
  if (progress.cancel.signal.aborted) parts.unshift('Export cancelled.')
  if (over) parts.push(`${over} could not get under the size limit.`)
  if (errors.length) {
    parts.push(`${errors.length} failed: ${[...new Set(errors)].join('; ')}`)
  }
  if (closed.length) parts.push(unopened([...new Set(closed)]))
  return parts.join(' ')
}

// Where the files went: one album's folder or Exports for photos,
// Exports for several albums there, and nothing to name when some of
// them went to picked folders.
function where(targets: Target[]) {
  if (targets.length > 1) {
    return targets.some(t => t.picked) ? '' : ' to Exports'
  }

  const { album, picked } = targets[0]
  if (picked) return ` to ${picked.name}`
  return album ? ` to Exports/${sanitizeName(album.name)}` : ' to Exports'
}

function unopened(names: string[]) {
  const one = names.length === 1
  const folders = one ? 'the folder' : 'the folders'
  const again = `Choose ${one ? 'it' : 'them'} again in the Export dialog.`
  return `Could not open ${folders} ${formatList(names)}. ${again}`
}
