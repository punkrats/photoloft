import { commit } from './commit'
import { jpegInfo } from './exif'
import { decode, probeVideo } from './images'
import {
  addToAlbum, restorePhotos, setLastImport, withPhotos, type Library,
  type Photo, type VideoExt
} from './library'
import { readMoov, videoTaken } from './mp4'
import { render } from './render'
import { NEUTRAL_EDIT } from './schema'
import { currentAlbum, showToast, type AppState } from './state'
import {
  collectFiles, videoExt, writeOriginal, writeThumb
} from './storage'
import { showThumb, thumbFrom } from './thumbs'

const PARALLEL = 3

type Outcome = {
  photo?: Photo
  known?: string
  invalid?: boolean
  unplayable?: boolean
}

const THUMB_SOURCE = 1024

// Copies JPEGs and videos into the library. A photo counts as known
// when a file with exactly the same content was imported before, under
// any name, a video when its size and first and last megabyte match;
// known ones are not copied again but still join the open album and
// come back from the trash.
export async function importEntries(
  state: AppState, entries: (File | FileSystemHandle)[]
) {
  if (!state.library || !state.dirs || state.progress) return
  if (await includesLibrary(state.dirs.root, entries)) {
    showToast(state, 'This is the Photoloft library folder. ' +
      'Pick the folder your photos are in.')
    render(state)
    return
  }

  const progress = {
    label: 'Looking for photos', done: 0, total: 0, cancelled: false
  }
  state.progress = progress
  const ticker = window.setInterval(() => render(state), 250)
  const found = await collectFiles(entries, state.dirs.root, progress)
    .finally(() => clearInterval(ticker))

  const { files, skipped } = found
  if (progress.cancelled || files.length === 0) {
    state.progress = null
    if (!progress.cancelled) showToast(state, 'No photos or videos found.')
    render(state)
    return
  }

  Object.assign(progress, { label: 'Importing', done: 0, total: files.length })
  render(state)

  const outcomes: Outcome[] = []
  const seen = new Set<string>()
  await pool(files, PARALLEL, async file => {
    if (progress.cancelled) return
    outcomes.push(await importFile(state, file, seen))
    progress.done++
    render(state)
  })

  state.progress = null
  const added = outcomes.flatMap(o => (o.photo ? [o.photo] : []))
  const known = outcomes.flatMap(o => (o.known ? [o.known] : []))
  const invalid = skipped + outcomes.filter(o => o.invalid).length
  const unplayable = outcomes.filter(o => o.unplayable).length
  commit(state, withImported(state, added, known))

  const counts = { added: added.length, known: known.length }
  showToast(state, summary({ ...counts, invalid, unplayable }))
  render(state)
}

async function importFile(
  state: AppState, file: File, seen: Set<string>
): Promise<Outcome> {
  const ext = videoExt(file.name)
  try {
    return ext
      ? await importVideo(state, file, ext, seen)
      : await importPhoto(state, file, seen)
  } catch {
    return ext ? { unplayable: true } : { invalid: true }
  }
}

async function importPhoto(state: AppState, file: File, seen: Set<string>) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const info = jpegInfo(bytes)
  if (!info) return { invalid: true }

  const id = await contentId(bytes)
  if (state.library!.photos[id] || seen.has(id)) return { known: id }
  seen.add(id)

  await writeOriginal(state.dirs!, `${id}.jpg`, file)
  await storeThumb(state, id, await decode(file, THUMB_SOURCE))
  const photo = newItem(id, file, info)
  return { photo: { ...photo, takenAt: info.takenAt } }
}

async function importVideo(
  state: AppState, file: File, ext: VideoExt, seen: Set<string>
) {
  const id = await sampledId(file)
  if (state.library!.photos[id] || seen.has(id)) return { known: id }
  seen.add(id)

  const probe = await probeVideo(file)
  await writeOriginal(state.dirs!, `${id}.${ext}`, file)
  await storeThumb(state, id, probe.frame)

  const takenAt = videoTaken(file.name, await readMoov(file))
  const video = { duration: probe.duration, ext }
  return { photo: { ...newItem(id, file, probe), takenAt, video } }
}

async function storeThumb(state: AppState, id: string, frame: ImageBitmap) {
  const thumb = await thumbFrom(state, frame, NEUTRAL_EDIT)
  await writeThumb(state.dirs!, id, thumb)
  showThumb(state, id, thumb)
}

function newItem(
  id: string, file: File, size: { width: number, height: number }
): Photo {
  return {
    id,
    name: file.name,
    takenAt: null,
    importedAt: new Date().toISOString(),
    width: size.width,
    height: size.height,
    edit: NEUTRAL_EDIT,
    trashedAt: null,
    starred: false,
    bytes: file.size,
    video: null,
    meta: {}
  }
}

function withImported(state: AppState, added: Photo[], known: string[]) {
  let lib: Library = withPhotos(state.library!, added)
  lib = setLastImport(lib, added.map(p => p.id))
  lib = restorePhotos(lib, known.filter(id => lib.photos[id]?.trashedAt))

  const album = currentAlbum(state)
  const ids = [...added.map(p => p.id), ...known]
  return album ? addToAlbum(lib, album.id, ids) : lib
}

async function includesLibrary(
  root: FileSystemDirectoryHandle, entries: (File | FileSystemHandle)[]
) {
  const handles = entries.filter(
    (e): e is FileSystemHandle => !(e instanceof File)
  )
  const same = await Promise.all(handles.map(h => h.isSameEntry(root)))
  return same.includes(true)
}

type Counts = {
  added: number
  known: number
  invalid: number
  unplayable: number
}

function summary({ added, known, invalid, unplayable }: Counts) {
  const parts = [`Imported ${added} ${added === 1 ? 'photo' : 'photos'}.`]
  if (known) parts.push(`${known} already imported.`)
  if (invalid) parts.push(`${invalid} skipped (not a JPEG or a video).`)
  if (unplayable) {
    const videos = unplayable === 1 ? '1 video' : `${unplayable} videos`
    parts.push(`${videos} could not be played in this browser.`)
  }
  if (added) parts.push('The originals stay where they were.')
  return parts.join(' ')
}

// Videos can be far too large to hash whole; their size plus the first
// and last megabyte identify them well enough.
async function sampledId(file: File) {
  const edge = 1024 * 1024
  const parts = [
    new TextEncoder().encode(String(file.size)),
    new Uint8Array(await file.slice(0, edge).arrayBuffer()),
    new Uint8Array(await file.slice(-edge).arrayBuffer())
  ]
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return contentId(joined)
}

async function contentId(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
  return hex.join('').slice(0, 16)
}

async function pool<T>(
  items: T[], size: number, run: (item: T) => Promise<void>
) {
  const queue = [...items]
  const workers = Array.from({ length: size }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await run(item)
    }
  })
  await Promise.all(workers)
}
