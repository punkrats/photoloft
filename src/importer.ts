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
import {
  currentAlbum, showToast, type AppState, type Progress
} from './state'
import {
  collectFiles, readOriginal, videoExt, writeOriginal, writeThumb, type Dirs
} from './storage'
import { showThumb, thumbFrom } from './thumbs'

const PARALLEL = 3

// A file to import: one dropped or picked, or one on a drive the
// Photoloft service reads. `read` gives the bytes from `start` to
// `end`, `file` the whole file.
export type Source = {
  name: string
  size: number
  read: (start: number, end: number) => Promise<Uint8Array<ArrayBuffer>>
  file: () => Promise<File>
}

// What an import found: the files to import and how many others it
// passed over.
export type Found = { sources: Source[], skipped: number }

type Outcome = {
  photo?: Photo
  known?: string
  invalid?: boolean
  unplayable?: boolean
  unreadable?: boolean
}

// What one import keeps: the ids it took so far, the library's items
// by the size of their originals, and the samples of those originals
// read so far.
type Run = {
  seen: Set<string>
  sizes: Map<number, string[]>
  samples: Map<string, Promise<string>>
}

const THUMB_SOURCE = 1024
const VIDEO_EDGE = 1024 * 1024
const SAMPLE_EDGE = 64 * 1024

// Imports dropped or picked files and folders with all their
// subfolders.
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

  const root = state.dirs.root
  await importFound(state, async progress => {
    const { files, skipped } = await collectFiles(entries, root, progress)
    return { sources: files.map(fileSource), skipped }
  })
}

// Copies JPEGs and videos into the library, from what `find` finds. A
// photo counts as known when a file with exactly the same content was
// imported before, under any name, a video when its size and first and
// last megabyte match; known ones are not copied again but still join
// the open album and come back from the trash. A file of the same size
// as a library item is checked first by its first and last 64 KB, so
// known files are skipped without reading them whole.
export async function importFound(
  state: AppState, find: (progress: Progress) => Promise<Found>
) {
  if (!state.library || !state.dirs || state.progress) return

  const progress = {
    label: 'Looking for photos', done: 0, total: 0,
    cancel: new AbortController()
  }
  state.progress = progress
  const ticker = window.setInterval(() => render(state), 250)
  let found: Found
  try {
    found = await find(progress)
  } catch (error) {
    state.progress = null
    showToast(state, `Could not read the folder: ${String(error)}`)
    render(state)
    return
  } finally {
    clearInterval(ticker)
  }

  const { sources, skipped } = found
  const cancelled = progress.cancel.signal.aborted
  if (cancelled || sources.length === 0) {
    state.progress = null
    if (!cancelled) showToast(state, 'No photos or videos found.')
    render(state)
    return
  }

  const total = sources.length
  Object.assign(progress, { label: 'Importing', done: 0, total })
  render(state)

  const outcomes: Outcome[] = []
  const run = newRun(state.library)
  await pool(sources, PARALLEL, async source => {
    if (progress.cancel.signal.aborted) return
    outcomes.push(await importSource(state, source, run))
    progress.done++
    render(state)
  })

  state.progress = null
  const added = outcomes.flatMap(o => (o.photo ? [o.photo] : []))
  const known = outcomes.flatMap(o => (o.known ? [o.known] : []))
  const count = (key: keyof Outcome) => outcomes.filter(o => o[key]).length
  commit(state, withImported(state, added, known))

  showToast(state, summary({
    added: added.length,
    known: known.length,
    invalid: skipped + count('invalid'),
    unplayable: count('unplayable'),
    unreadable: count('unreadable')
  }))
  render(state)
}

// Which of the sources the library holds, as far as their size and
// ends tell (`quickMatch`).
export async function heldSources(state: AppState, sources: Source[]) {
  const dirs = state.dirs!
  const lib = state.library!
  const run = newRun(lib)
  const held: boolean[] = []
  await pool([...sources.keys()], PARALLEL, async i => {
    const match = await quickMatch(dirs, lib, sources[i], run)
      .catch(() => null)
    held[i] = match !== null
  })
  return held
}

export function fileSource(file: File): Source {
  return {
    name: file.name,
    size: file.size,
    read: async (start, end) => {
      return new Uint8Array(await file.slice(start, end).arrayBuffer())
    },
    file: async () => file
  }
}

function newRun(lib: Library): Run {
  const sizes = new Map<number, string[]>()
  for (const { id, bytes } of Object.values(lib.photos)) {
    if (bytes) sizes.set(bytes, [...(sizes.get(bytes) ?? []), id])
  }
  return { seen: new Set(), sizes, samples: new Map() }
}

// A file that cannot be read, such as one on a drive pulled out, counts
// apart from one that is no photo or video.
async function importSource(
  state: AppState, source: Source, run: Run
): Promise<Outcome> {
  const ext = videoExt(source.name)
  let file: File
  try {
    const known = await quickMatch(state.dirs!, state.library!, source, run)
    if (known) return { known }
    file = await source.file()
  } catch {
    return { unreadable: true }
  }

  try {
    return ext
      ? await importVideo(state, file, ext, run.seen)
      : await importPhoto(state, file, run.seen)
  } catch {
    return ext ? { unplayable: true } : { invalid: true }
  }
}

// The library item whose original has the file's size and the same
// first and last 64 KB, or null to check the whole file. A file that
// differs from an item only in between would count as that item; files
// from cameras and phones never do.
async function quickMatch(
  dirs: Dirs, lib: Library, source: Source, run: Run
) {
  const ids = run.sizes.get(source.size)
  if (!ids) return null

  const sample = await sampledId(source, SAMPLE_EDGE)
  for (const id of ids) {
    if ((await originalSample(dirs, lib, id, run)) === sample) return id
  }
  return null
}

// A missing original gives an empty sample, which matches no file.
function originalSample(dirs: Dirs, lib: Library, id: string, run: Run) {
  let sample = run.samples.get(id)
  if (!sample) {
    sample = readOriginal(dirs, lib.photos[id])
      .then(original => sampledId(fileSource(original), SAMPLE_EDGE))
      .catch(() => '')
    run.samples.set(id, sample)
  }
  return sample
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
  const id = await sampledId(fileSource(file), VIDEO_EDGE)
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
  unreadable: number
}

function summary({ added, known, invalid, unplayable, unreadable }: Counts) {
  const parts = [`Imported ${added} ${added === 1 ? 'photo' : 'photos'}.`]
  if (known) parts.push(`${known} already imported.`)
  if (invalid) parts.push(`${invalid} skipped (not a JPEG or a video).`)
  if (unplayable) {
    const videos = unplayable === 1 ? '1 video' : `${unplayable} videos`
    parts.push(`${videos} could not be played in this browser.`)
  }
  if (unreadable) parts.push(`${unreadable} could not be read.`)
  if (added) parts.push('The originals stay where they were.')
  return parts.join(' ')
}

// The hash of the size and the first and last `edge` bytes. Videos can
// be far too large to hash whole; with a megabyte at each end this
// identifies them well enough.
async function sampledId(source: Source, edge: number) {
  const { size } = source
  const parts = [
    new TextEncoder().encode(String(size)),
    await source.read(0, Math.min(edge, size)),
    await source.read(Math.max(0, size - edge), size)
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
