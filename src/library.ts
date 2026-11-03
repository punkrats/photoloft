import { NEUTRAL_EDIT, type Edit } from './schema'
import { realTaken, shiftedTaken, takenDifference } from './taken'

export type Photo = {
  id: string
  name: string
  takenAt: string | null
  importedAt: string
  width: number
  height: number
  edit: Edit
  trashedAt: string | null
  starred: boolean
  bytes: number
  video: VideoInfo | null
}

export type VideoInfo = { duration: number, ext: VideoExt }
export type VideoExt = 'mp4' | 'mov' | 'm4v'
export const VIDEO_EXTS: VideoExt[] = ['mp4', 'mov', 'm4v']

// `photos` is the custom order; it stays untouched while the album is
// sorted, so switching back to 'custom' restores it.
export type Album = {
  id: string
  name: string
  photos: string[]
  sort?: Sort
  exportName?: string
}

export type ExportRecord = { folder: string, files: string[] }

export type ExportSettings = {
  naming: 'album' | 'original'
  longEdge: number | null
  maxBytes: number | null
  quality: number
  stripGps: boolean
  videoSide: 0 | 720 | 1080
}

export type Library = {
  version: 1
  photos: Record<string, Photo>
  albums: Album[]
  exports: Record<string, ExportRecord>
  exportSettings: ExportSettings
  lastImport: string[]
}

export type View =
  | { kind: 'all' }
  | { kind: 'unsorted' }
  | { kind: 'starred' }
  | { kind: 'import' }
  | { kind: 'albums' }
  | { kind: 'trash' }
  | { kind: 'album', id: string }

export type Sort = 'date' | 'name' | 'size'
export type AlbumSort = Sort | 'custom'

const SORTS: AlbumSort[] = ['date', 'name', 'size', 'custom']

const VERSION = 1
const COLLATOR = new Intl.Collator(undefined, {
  numeric: true, sensitivity: 'base'
})

const DEFAULT_EXPORT: ExportSettings = {
  naming: 'album',
  longEdge: null,
  maxBytes: null,
  quality: 90,
  stripGps: true,
  videoSide: 720
}

export function emptyLibrary(): Library {
  return {
    version: VERSION,
    photos: {},
    albums: [],
    exports: {},
    exportSettings: DEFAULT_EXPORT,
    lastImport: []
  }
}

// ─── Photos ──────────────────────────────────────────────────────────

export function addPhotos(lib: Library, photos: Photo[]): Library {
  const added = Object.fromEntries(photos.map(p => [p.id, p]))
  return { ...lib, photos: { ...lib.photos, ...added } }
}

// Only an import that added photos replaces it, so re-importing a card
// keeps the view of what was new.
export function setLastImport(lib: Library, ids: string[]): Library {
  return ids.length ? { ...lib, lastImport: ids } : lib
}

export function notInAlbums(lib: Library, ids: string[]) {
  const grouped = new Set(lib.albums.flatMap(a => a.photos))
  return ids.filter(id => !grouped.has(id))
}

export function renamePhoto(lib: Library, id: string, name: string) {
  const clean = name.trim()
  const photo = lib.photos[id]
  if (!clean || !photo) return lib

  return withPhotos(lib, [{ ...photo, name: clean }])
}

export function setEdits(
  lib: Library, ids: string[], change: (edit: Edit) => Edit
): Library {
  const photos = ids
    .map(id => lib.photos[id])
    .filter(Boolean)
    .map(p => ({ ...p, edit: change(p.edit) }))

  return withPhotos(lib, photos)
}

// Stars all when any of them is unstarred, otherwise clears all.
export function toggleStars(lib: Library, ids: string[]) {
  const photos = ids.map(id => lib.photos[id]).filter(Boolean)
  const starred = !photos.every(p => p.starred)
  return withPhotos(lib, photos.map(p => ({ ...p, starred })))
}

// File name of the original in the library folder.
export function originalName(photo: Photo) {
  return `${photo.id}.${photo.video?.ext ?? 'jpg'}`
}

export function setPhotoSizes(lib: Library, sizes: Record<string, number>) {
  const photos = Object.entries(sizes)
    .filter(([id]) => lib.photos[id])
    .map(([id, bytes]) => ({ ...lib.photos[id], bytes }))
  return withPhotos(lib, photos)
}

// Sets the reference's capture time to `to`. Dated photos move by the
// same gap (and keep their time when the reference had none); undated
// ones get times one second apart around the reference, in the order
// given, so they keep that order.
export function retime(
  lib: Library, ordered: string[], reference: string, to: string
) {
  const from = lib.photos[reference]?.takenAt
  const gap = from ? takenDifference(from, to) : null
  const at = ordered.indexOf(reference)

  const photos = ordered.flatMap((id, i) => {
    const photo = lib.photos[id]
    if (!photo) return []
    if (!photo.takenAt) {
      return [{ ...photo, takenAt: shiftedTaken(to, (i - at) * 1000) }]
    }
    if (gap === null) return []
    return [{ ...photo, takenAt: shiftedTaken(photo.takenAt, gap) }]
  })
  return withPhotos(lib, photos)
}

export function trashPhotos(lib: Library, ids: string[], now: string) {
  const photos = ids
    .map(id => lib.photos[id])
    .filter(Boolean)
    .map(p => ({ ...p, trashedAt: now }))

  return withPhotos(lib, photos)
}

export function restorePhotos(lib: Library, ids: string[]) {
  const photos = ids
    .map(id => lib.photos[id])
    .filter(Boolean)
    .map(p => ({ ...p, trashedAt: null }))

  return withPhotos(lib, photos)
}

export function emptyTrash(lib: Library) {
  const removed = Object.values(lib.photos)
    .filter(p => p.trashedAt)
    .map(p => p.id)
  const gone = new Set(removed)

  const photos = Object.fromEntries(
    Object.entries(lib.photos).filter(([id]) => !gone.has(id))
  )
  const albums = lib.albums.map(a => {
    const kept = a.photos.filter(id => !gone.has(id))
    return { ...a, photos: kept }
  })

  return { library: { ...lib, photos, albums }, removed }
}

function withPhotos(lib: Library, photos: Photo[]): Library {
  if (photos.length === 0) return lib
  return addPhotos(lib, photos)
}

// ─── Albums ──────────────────────────────────────────────────────────

export function createAlbum(lib: Library, id: string, name: string) {
  const album: Album = { id, name: name.trim() || 'Untitled', photos: [] }
  return { ...lib, albums: [...lib.albums, album] }
}

export function renameAlbum(lib: Library, id: string, name: string) {
  const clean = name.trim()
  if (!clean) return lib

  return mapAlbum(lib, id, a => ({ ...a, name: clean }))
}

export function deleteAlbum(lib: Library, id: string): Library {
  const albums = lib.albums.filter(a => a.id !== id)
  const { [id]: _dropped, ...exports } = lib.exports
  return { ...lib, albums, exports }
}

export function addToAlbum(lib: Library, id: string, photoIds: string[]) {
  return mapAlbum(lib, id, a => {
    const present = new Set(a.photos)
    const added = photoIds.filter(p => lib.photos[p] && !present.has(p))
    return { ...a, photos: [...a.photos, ...new Set(added)] }
  })
}

export function removeFromAlbum(lib: Library, id: string, ids: string[]) {
  const gone = new Set(ids)
  return mapAlbum(lib, id, a => {
    const kept = a.photos.filter(p => !gone.has(p))
    return { ...a, photos: kept }
  })
}

// Moves the photos as one block, in the order shown, so that they land
// before the photo shown at `index`. A sorted album becomes custom,
// starting from the order it showed.
export function moveInAlbum(
  lib: Library, id: string, ids: string[], index: number
) {
  const moving = new Set(ids)
  const shown = viewPhotos(lib, { kind: 'album', id }, 'date')
  const anchor = shown.slice(index).find(p => !moving.has(p))

  return mapAlbum(lib, id, a => {
    const { sort, ...custom } = a
    const order = sort ? sortIds(lib, a.photos, sort) : a.photos
    const block = order.filter(p => moving.has(p))
    const rest = order.filter(p => !moving.has(p))
    const at = anchor ? rest.indexOf(anchor) : rest.length
    const photos = [...rest.slice(0, at), ...block, ...rest.slice(at)]
    return { ...custom, photos }
  })
}

export function setAlbumSort(lib: Library, id: string, sort: AlbumSort) {
  return mapAlbum(lib, id, a => {
    const { sort: _old, ...custom } = a
    return sort === 'custom' ? custom : { ...custom, sort }
  })
}

// Kept only when it differs from the album name, so renaming the album
// renames its exports too.
export function setAlbumExportName(lib: Library, id: string, name: string) {
  return mapAlbum(lib, id, a => {
    const { exportName: _old, ...album } = a
    return name === a.name ? album : { ...album, exportName: name }
  })
}

export function albumsByName(lib: Library) {
  return [...lib.albums].sort((a, b) => COLLATOR.compare(a.name, b.name))
}

function mapAlbum(lib: Library, id: string, change: (a: Album) => Album) {
  const albums = lib.albums.map(a => (a.id === id ? change(a) : a))
  return { ...lib, albums }
}

// ─── Export bookkeeping ──────────────────────────────────────────────

export function setExportRecord(
  lib: Library, id: string, record: ExportRecord
): Library {
  return { ...lib, exports: { ...lib.exports, [id]: record } }
}

export function setExportSettings(lib: Library, settings: ExportSettings) {
  return { ...lib, exportSettings: settings }
}

// ─── Views ───────────────────────────────────────────────────────────

export function viewPhotos(lib: Library, view: View, sort: Sort) {
  const alive = (id: string) => {
    const photo = lib.photos[id]
    return photo && !photo.trashedAt
  }

  if (view.kind === 'album') {
    const album = lib.albums.find(a => a.id === view.id)
    return album ? albumOrder(lib, album) : []
  }
  if (view.kind === 'albums') {
    return albumSections(lib).flatMap(s => s.ids)
  }
  if (view.kind === 'import') {
    return sortIds(lib, lib.lastImport.filter(alive), sort)
  }

  const ids = Object.keys(lib.photos)
  if (view.kind === 'trash') {
    const trashed = ids.filter(id => lib.photos[id].trashedAt)
    return sortIds(lib, trashed, sort)
  }

  const grouped = new Set(lib.albums.flatMap(a => a.photos))
  const shown = ids.filter(id => {
    if (!alive(id)) return false
    if (view.kind === 'starred') return lib.photos[id].starred
    return view.kind === 'all' || !grouped.has(id)
  })

  return sortIds(lib, shown, sort)
}

// Every album A to Z with its photos in the album's order.
export function albumSections(lib: Library) {
  return albumsByName(lib).map(album => {
    return { album, ids: albumOrder(lib, album) }
  })
}

function albumOrder(lib: Library, album: Album) {
  const photos = album.photos.filter(id => {
    const photo = lib.photos[id]
    return photo && !photo.trashedAt
  })
  return album.sort ? sortIds(lib, photos, album.sort) : photos
}

export function libraryCounts(lib: Library) {
  const alive = (id: string) => {
    const photo = lib.photos[id]
    return photo && !photo.trashedAt
  }
  const grouped = new Set(lib.albums.flatMap(a => a.photos))
  const ids = Object.keys(lib.photos)

  const albums: Record<string, number> = {}
  for (const a of lib.albums) albums[a.id] = a.photos.filter(alive).length

  return {
    all: ids.filter(alive).length,
    unsorted: ids.filter(id => alive(id) && !grouped.has(id)).length,
    starred: ids.filter(id => alive(id) && lib.photos[id].starred).length,
    import: lib.lastImport.filter(alive).length,
    inAlbums: [...grouped].filter(alive).length,
    trash: ids.filter(id => !alive(id)).length,
    albums
  }
}

function sortIds(lib: Library, ids: string[], by: Sort) {
  const byName = (a: Photo, b: Photo) =>
    COLLATOR.compare(a.name, b.name) || a.id.localeCompare(b.id)

  const compare = (a: Photo, b: Photo) => {
    if (by === 'name') return byName(a, b)
    if (by === 'size') return b.bytes - a.bytes || byName(a, b)
    if (a.takenAt === b.takenAt) return byName(a, b)
    if (!a.takenAt) return 1
    if (!b.takenAt) return -1
    return a.takenAt.localeCompare(b.takenAt)
  }

  return ids
    .map(id => lib.photos[id])
    .sort(compare)
    .map(p => p.id)
}

// ─── Loading ─────────────────────────────────────────────────────────

type Raw = Record<string, unknown>

// Saves alternate between two files, each tagged with a sequence
// number, so a save cut short by a crash only damages one of them.
// Unreadable copies are skipped; a copy from a newer Lightbox throws.
export function pickLibrary(candidates: { name: string, text: string }[]) {
  let best: { name: string, text: string, library: Library, seq: number } |
    null = null

  for (const candidate of candidates) {
    let raw: unknown
    try {
      raw = JSON.parse(candidate.text)
    } catch {
      continue
    }

    const library = migrate(raw)
    const seq = num(record(raw).seq, 0)
    if (!best || seq > best.seq) best = { ...candidate, library, seq }
  }
  return best
}

export function migrate(raw: unknown): Library {
  const data = record(raw)
  const version = num(data.version, VERSION)
  if (version > VERSION) {
    throw new Error('This library was written by a newer Lightbox')
  }

  const photos: Record<string, Photo> = {}
  for (const value of Object.values(record(data.photos))) {
    const photo = migratePhoto(record(value))
    if (photo) photos[photo.id] = photo
  }

  const albums = list(data.albums)
    .map(value => migrateAlbum(record(value), photos))
    .filter((a): a is Album => a !== null)

  const exports: Record<string, ExportRecord> = {}
  for (const [id, value] of Object.entries(record(data.exports))) {
    const entry = record(value)
    const files = list(entry.files).filter(isString)
    exports[id] = { folder: str(entry.folder, ''), files }
  }

  const exportSettings = migrateExport(record(data.exportSettings))
  const lastImport = list(data.lastImport)
    .filter(isString)
    .filter(id => photos[id])
  return {
    version: VERSION, photos, albums, exports, exportSettings, lastImport
  }
}

function migratePhoto(raw: Raw): Photo | null {
  if (!isString(raw.id)) return null

  return {
    id: raw.id,
    name: str(raw.name, `${raw.id}.jpg`),
    takenAt: isString(raw.takenAt) ? realTaken(raw.takenAt) : null,
    importedAt: str(raw.importedAt, ''),
    width: num(raw.width, 0),
    height: num(raw.height, 0),
    edit: migrateEdit(record(raw.edit)),
    trashedAt: isString(raw.trashedAt) ? raw.trashedAt : null,
    starred: raw.starred === true || raw.flagged === true,
    bytes: num(raw.bytes, 0),
    video: migrateVideo(record(raw.video))
  }
}

function migrateVideo(raw: Raw): VideoInfo | null {
  const ext = VIDEO_EXTS.find(e => e === raw.ext)
  return ext ? { duration: num(raw.duration, 0), ext } : null
}

function migrateEdit(raw: Raw): Edit {
  const edit: Record<string, unknown> = { ...NEUTRAL_EDIT }
  for (const [key, neutral] of Object.entries(NEUTRAL_EDIT)) {
    const value = raw[key]
    if (typeof value !== typeof neutral || value === null) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    edit[key] = value
  }

  const crop = record(raw.crop)
  const valid = ['x', 'y', 'w', 'h'].every(k => typeof crop[k] === 'number')
  edit.crop = valid ? { x: crop.x, y: crop.y, w: crop.w, h: crop.h } : null

  if (![0, 90, 180, 270].includes(edit.rotate as number)) edit.rotate = 0
  const aspects = ['original', 'free', '1:1', '4:3', '3:2', '16:9']
  if (!aspects.includes(edit.aspect as string)) edit.aspect = 'original'

  return edit as Edit
}

function migrateAlbum(raw: Raw, photos: Record<string, Photo>) {
  if (!isString(raw.id)) return null

  const ids = list(raw.photos).filter(isString).filter(id => photos[id])
  const album: Album = {
    id: raw.id,
    name: str(raw.name, 'Untitled'),
    photos: [...new Set(ids)]
  }
  if (isString(raw.exportName)) album.exportName = raw.exportName
  const sort = SORTS.find(s => s === raw.sort)
  if (sort && sort !== 'custom') album.sort = sort
  return album
}

function migrateExport(raw: Raw): ExportSettings {
  const nullableNum = (value: unknown) =>
    typeof value === 'number' && value > 0 ? value : null

  return {
    naming: raw.naming === 'original' ? 'original' : 'album',
    longEdge: nullableNum(raw.longEdge),
    maxBytes: nullableNum(raw.maxBytes),
    quality: num(raw.quality, DEFAULT_EXPORT.quality),
    stripGps: typeof raw.stripGps === 'boolean' ? raw.stripGps : true,
    videoSide: raw.videoSide === 0 || raw.videoSide === 1080
      ? raw.videoSide
      : 720
  }
}

function record(value: unknown): Raw {
  const ok = value !== null && typeof value === 'object'
  return ok && !Array.isArray(value) ? (value as Raw) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function str(value: unknown, fallback: string) {
  return isString(value) ? value : fallback
}

function num(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback
}
