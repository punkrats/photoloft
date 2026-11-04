import { isLocation } from './geo'
import type { Meta } from './meta'
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
  meta: Meta
}

// The file's length and type, and the part of it that plays and
// exports: `trim`, in seconds of the original, or the whole clip when
// absent.
export type VideoInfo = { duration: number, ext: VideoExt, trim?: Trim }
export type VideoExt = 'mp4' | 'mov' | 'm4v'
export const VIDEO_EXTS: VideoExt[] = ['mp4', 'mov', 'm4v']

export type Trim = { start: number, end: number }
export type TrimEdge = keyof Trim

// The shortest part of a clip a trim keeps, in seconds.
export const MIN_TRIM = 1

// Slack for sums of decimals: 1.4 - 0.4 is 0.9999999999999999.
const SLACK = 1e-6

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

// A capture time to replace: `from` is the time the photo must still
// have for `to` to apply.
export type TakenFix = { id: string, from: string | null, to: string }

// The author and copyright last set, offered for photos without one.
export type MetaDefaults = Pick<Meta, 'author' | 'copyright'>

// Per field: `{ set }` gives every photo the value, 'remove' deletes
// it, a missing key keeps each photo's own. A location set to null
// means no location at all, the camera's included.
export type FieldChange<T> = { set: T } | 'remove'
export type MetaChange = {
  [K in keyof Meta]?: FieldChange<Exclude<Meta[K], undefined>>
}

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
  metaDefaults: MetaDefaults
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
const META_TEXT = ['title', 'description', 'author', 'copyright'] as const

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
    lastImport: [],
    metaDefaults: {}
  }
}

// ─── Photos ──────────────────────────────────────────────────────────

// Adds the photos, replacing any held under the same id; with none
// given it returns `lib` itself.
export function addPhotos(lib: Library, photos: Photo[]): Library {
  if (!photos.length) return lib

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

// A blank name keeps the old one.
export function renamePhoto(lib: Library, id: string, name: string) {
  const clean = name.trim()
  return clean ? renamePhotos(lib, { [id]: clean }) : lib
}

// Gives each photo the name set for its id. Ids the library lacks and
// names a photo has already are skipped, so a rename that changes no
// name returns `lib` itself.
export function renamePhotos(lib: Library, names: Record<string, string>) {
  const photos = Object.entries(names)
    .filter(([id, name]) => lib.photos[id] && lib.photos[id].name !== name)
    .map(([id, name]) => ({ ...lib.photos[id], name }))
  return withPhotos(lib, photos)
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

export function trimRange(video: VideoInfo): Trim {
  return video.trim ?? { start: 0, end: video.duration }
}

// A dragged grip moves inside the clip and stops MIN_TRIM short of the
// other mark.
export function draggedTrim(video: VideoInfo, edge: TrimEdge, at: number) {
  const { start, end } = trimRange(video)
  if (edge === 'start') return { start: clamp(at, 0, end - MIN_TRIM), end }
  return { start, end: clamp(at, start + MIN_TRIM, video.duration) }
}

// I or O puts its mark where the video is, with room for MIN_TRIM left
// in the clip. When the other mark is closer than that, or crossed, it
// goes back to its end of the clip.
export function markedTrim(video: VideoInfo, edge: TrimEdge, at: number) {
  const { start, end } = trimRange(video)
  const duration = video.duration
  const short = (length: number) => length < MIN_TRIM - SLACK

  if (edge === 'start') {
    const mark = clamp(at, 0, duration - MIN_TRIM)
    return { start: mark, end: short(end - mark) ? duration : end }
  }
  const mark = clamp(at, MIN_TRIM, duration)
  return { start: short(mark - start) ? 0 : start, end: mark }
}

// Sets the part of a video that plays and exports, as `draggedTrim` and
// `markedTrim` give it. A trim reaching both ends of the clip, or null,
// removes it; with no change, or no such video, it returns `lib`.
export function setTrim(lib: Library, id: string, trim: Trim | null) {
  const photo = lib.photos[id]
  if (!photo?.video) return lib

  const { trim: old, ...video } = photo.video
  const whole = !trim || (trim.start <= 0 && trim.end >= video.duration)
  if (whole) return old ? withPhotos(lib, [{ ...photo, video }]) : lib
  if (old?.start === trim.start && old.end === trim.end) return lib

  const kept = { start: trim.start, end: trim.end }
  return withPhotos(lib, [{ ...photo, video: { ...video, trim: kept } }])
}

// Ids the library lacks and sizes a photo has already are skipped, so
// with nothing to change it returns `lib` itself.
export function setPhotoSizes(lib: Library, sizes: Record<string, number>) {
  const photos = Object.entries(sizes)
    .filter(([id, bytes]) => lib.photos[id] && lib.photos[id].bytes !== bytes)
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

// Gives each photo its fix's time `to` while its capture time is still
// `from`, so a time changed since stays; a fix that changes nothing is
// skipped, and with none left it returns `lib` itself.
export function fixTaken(lib: Library, fixes: TakenFix[]) {
  const photos = fixes.flatMap(({ id, from, to }) => {
    const photo = lib.photos[id]
    const due = photo && photo.takenAt === from && from !== to
    return due ? [{ ...photo, takenAt: to }] : []
  })
  return withPhotos(lib, photos)
}

// Applies the change to each photo; only photos that end up different
// are copied, so a change that alters nothing returns `lib` itself. The
// author and copyright it sets are remembered.
export function setMeta(lib: Library, ids: string[], change: MetaChange) {
  const photos = ids
    .map(id => lib.photos[id])
    .filter(Boolean)
    .flatMap(p => {
      const meta = changedMeta(p.meta, change)
      return sameMeta(meta, p.meta) ? [] : [{ ...p, meta }]
    })
  if (!photos.length) return lib

  const metaDefaults = { ...lib.metaDefaults }
  for (const key of ['author', 'copyright'] as const) {
    const field = change[key]
    const value = field && field !== 'remove' ? field.set.trim() : ''
    if (value) metaDefaults[key] = value
  }
  return { ...withPhotos(lib, photos), metaDefaults }
}

function changedMeta(meta: Meta, change: MetaChange): Meta {
  const next: Record<string, unknown> = { ...meta }
  for (const [key, field] of Object.entries(change)) {
    const value = field === 'remove' ? undefined : cleanMeta(field.set)
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next as Meta
}

// Text is trimmed and keywords dropped when blank or repeated; what is
// left empty counts as no value.
function cleanMeta(value: Exclude<Meta[keyof Meta], undefined>) {
  if (typeof value === 'string') return value.trim() || undefined
  if (!Array.isArray(value)) return value

  const words = [...new Set(value.map(w => w.trim()).filter(Boolean))]
  return words.length ? words : undefined
}

function sameMeta(a: Meta, b: Meta) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every(key => {
    const k = key as keyof Meta
    return JSON.stringify(a[k]) === JSON.stringify(b[k])
  })
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

// Swaps in changed copies of photos the library holds.
function withPhotos(lib: Library, photos: Photo[]): Library {
  return addPhotos(lib, photos)
}

// ─── Albums ──────────────────────────────────────────────────────────

export function createAlbum(lib: Library, id: string, name: string) {
  const album: Album = { id, name: name.trim() || 'Untitled', photos: [] }
  return { ...lib, albums: [...lib.albums, album] }
}

// A blank name keeps the old one; with no change, or no such album, it
// returns `lib` itself.
export function renameAlbum(lib: Library, id: string, name: string) {
  const clean = name.trim()
  const album = lib.albums.find(a => a.id === id)
  if (!clean || !album || album.name === clean) return lib

  return mapAlbum(lib, id, a => ({ ...a, name: clean }))
}

export function deleteAlbum(lib: Library, id: string): Library {
  const albums = lib.albums.filter(a => a.id !== id)
  const { [id]: _dropped, ...exports } = lib.exports
  return { ...lib, albums, exports }
}

// Appends the known photos the album lacks, each once; with none to
// add, or no such album, it returns `lib` itself.
export function addToAlbum(lib: Library, id: string, photoIds: string[]) {
  const album = lib.albums.find(a => a.id === id)
  const present = new Set(album?.photos)
  const added = photoIds.filter(p => lib.photos[p] && !present.has(p))
  if (!album || !added.length) return lib

  const photos = [...album.photos, ...new Set(added)]
  return mapAlbum(lib, id, a => ({ ...a, photos }))
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
    return exportNamed(a, name === a.name ? undefined : name)
  })
}

export function albumsByName(lib: Library) {
  return [...lib.albums].sort((a, b) => COLLATOR.compare(a.name, b.name))
}

function mapAlbum(lib: Library, id: string, change: (a: Album) => Album) {
  const albums = lib.albums.map(a => (a.id === id ? change(a) : a))
  return { ...lib, albums }
}

// The album exporting under `name`, or under its own name without one.
function exportNamed(album: Album, name: string | undefined): Album {
  const { exportName: _old, ...rest } = album
  return name === undefined ? rest : { ...rest, exportName: name }
}

// ─── Bookkeeping ─────────────────────────────────────────────────────

// What Photoloft notes for itself beside the user's changes: the Export
// dialog's settings, each album's export name and the files its last
// export wrote, and the size of each original. Undo and redo keep the
// latest of these. Gives `lib` the bookkeeping `from` holds for the
// photos and albums `lib` has; with none different it returns `lib`.
export function withBookkeeping(lib: Library, from: Library): Library {
  const sizes = Object.fromEntries(
    Object.values(from.photos).map(p => [p.id, p.bytes])
  )
  let next = setPhotoSizes(lib, sizes)
  if (from.exportSettings !== lib.exportSettings) {
    next = setExportSettings(next, from.exportSettings)
  }

  const sources = new Map(from.albums.map(a => [a.id, a]))
  for (const album of lib.albums) {
    const record = from.exports[album.id]
    if (record && record !== lib.exports[album.id]) {
      next = setExportRecord(next, album.id, record)
    }
    const source = sources.get(album.id)
    if (source && source.exportName !== album.exportName) {
      next = mapAlbum(next, album.id, a => exportNamed(a, source.exportName))
    }
  }
  return next
}

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

type LibraryFile = { name: string, text: string }
type Picked = LibraryFile & { library: Library, seq: number, repairs: string[] }

// Saves alternate between two files, each tagged with a sequence
// number, so a save cut short by a crash only damages one of them.
// Next to the library each file names the one-time repairs it had.
// Unreadable copies are skipped; a copy from a newer Photoloft throws.
export function pickLibrary(candidates: LibraryFile[]) {
  let best: Picked | null = null

  for (const candidate of candidates) {
    let raw: unknown
    try {
      raw = JSON.parse(candidate.text)
    } catch {
      continue
    }

    const library = migrate(raw)
    const seq = num(record(raw).seq, 0)
    const repairs = list(record(raw).repairs).filter(isString)
    if (!best || seq > best.seq) best = { ...candidate, library, seq, repairs }
  }
  return best
}

export function migrate(raw: unknown): Library {
  const data = record(raw)
  const version = num(data.version, VERSION)
  if (version > VERSION) {
    throw new Error('This library was written by a newer Photoloft')
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
  const defaults = migrateMeta(record(data.metaDefaults))
  const metaDefaults: MetaDefaults = {}
  if (defaults.author) metaDefaults.author = defaults.author
  if (defaults.copyright) metaDefaults.copyright = defaults.copyright
  return {
    version: VERSION,
    photos,
    albums,
    exports,
    exportSettings,
    lastImport,
    metaDefaults
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
    video: migrateVideo(record(raw.video)),
    meta: migrateMeta(record(raw.meta))
  }
}

// Keeps what has the right shape; empty text and keywords count as
// none.
function migrateMeta(raw: Raw): Meta {
  const meta: Meta = {}
  for (const key of META_TEXT) {
    const value = raw[key]
    if (isString(value) && value) meta[key] = value
  }

  const keywords = list(raw.keywords).filter(isString).filter(Boolean)
  if (keywords.length) meta.keywords = keywords
  if (raw.location === null) meta.location = null
  if (isLocation(raw.location)) {
    meta.location = { lat: raw.location.lat, lon: raw.location.lon }
  }
  return meta
}

function migrateVideo(raw: Raw): VideoInfo | null {
  const ext = VIDEO_EXTS.find(e => e === raw.ext)
  if (!ext) return null

  const video: VideoInfo = { duration: num(raw.duration, 0), ext }
  const trim = migrateTrim(record(raw.trim), video.duration)
  return trim ? { ...video, trim } : video
}

// A saved trim stays when it lies inside the clip and keeps at least
// MIN_TRIM of it; one covering the whole clip counts as none.
function migrateTrim(raw: Raw, duration: number): Trim | null {
  const { start, end } = raw
  if (typeof start !== 'number' || typeof end !== 'number') return null

  const inside = start >= 0 && end <= duration
  const whole = start === 0 && end === duration
  const long = end - start >= MIN_TRIM - SLACK
  return inside && long && !whole ? { start, end } : null
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

// Holds `value` between `low` and `high`; `low` wins when they cross.
function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value))
}
