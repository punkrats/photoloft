import type { MapView, Place } from './geo'
import { emptyHistory, recordChange, type History } from './history'
import { plain, type Section } from './grid-layout'
import {
  albumSections, libraryCounts, viewPhotos, type Library, type Sort,
  type View
} from './library'
import type { Handle } from './geometry'
import type { PlaceMap } from './map'
import type { Location } from './meta'
import type { Renderer } from './pipeline'
import type { Colour, Crop } from './schema'
import type { Dirs } from './storage'
import type { Histogram } from './ui/histogram'

// preview shows the photo large without editing tools (Space).
export type Mode = 'grid' | 'preview' | 'edit' | 'crop'
type Counts = ReturnType<typeof libraryCounts>

export type ExportForm = {
  albumIds: string[]
  name: string
  start: number
  naming: 'album' | 'original'
  size: string
  customSize: number
  limit: string
  customLimit: number
  quality: number
  stripGps: boolean
  videoSide: string
}

export type InfoField =
  'title' | 'description' | 'keywords' | 'author' | 'copyright'

// The Info dialog: the text in each field, the pin and whether the user
// placed or removed it, where the map looks (a new object moves it),
// and the place search. `searches` counts searches sent, so only the
// latest answer shows.
export type InfoForm = {
  ids: string[]
  text: Record<InfoField, string>
  pin: Location | null
  moved: boolean
  view: MapView
  query: string
  places: Place[]
  note: string | null
  searches: number
}

export type Dialog =
  | { kind: 'picker', query: string, index: number }
  | { kind: 'export', form: ExportForm }
  | { kind: 'confirm', message: string, confirm: string, action: string }
  | { kind: 'help' }
  | { kind: 'date', ids: string[], reference: string, value: string }
  | { kind: 'info', form: InfoForm }

export type Progress = {
  label: string
  done: number
  total: number
  cancelled: boolean
}

export type Point = { x: number, y: number }

export type CropDrag = {
  handle: Handle
  start: Point
  crop: Crop
  last: Crop
  ratio: number | null
}

export type Editor = {
  renderer: Renderer | null
  loaded: string | null
  loading: string | null
  bitmap: ImageBitmap | null
  sampler: OffscreenCanvasRenderingContext2D | null
  stage: { width: number, height: number }
  drag: CropDrag | null
  horizon: { start: Point, end: Point } | null
  tool: 'none' | 'horizon' | 'eyedropper'
  histogram: Histogram | null
  histogramKey: unknown
  histogramTimer: number | null
  centre: boolean
  stripFor: string | null
  video: HTMLVideoElement | null
  playing: boolean
  time: number
}

export type AppState = {
  root: HTMLElement
  library: Library | null
  dirs: Dirs | null
  remembered: FileSystemDirectoryHandle | null
  error: string | null

  view: View
  sort: Sort
  selection: Set<string>
  anchor: string | null
  current: string | null
  mode: Mode
  before: boolean
  zoom: boolean

  dialog: Dialog | null
  renaming: { kind: 'album' | 'photo', id: string } | null
  progress: Progress | null
  toast: { text: string, at: number } | null

  history: History
  clipboard: Colour | null

  grid: { width: number, height: number, scroll: number, reveal: boolean }
  marquee: { start: Point, end: Point, base: Set<string> } | null
  marqueeMoved: boolean
  dragIds: string[]
  dropIndex: number | null
  dropAlbum: string | null
  draggingFiles: boolean

  thumbs: Map<string, string>
  thumbsPending: Set<string>
  thumbQueue: Set<string>
  thumbTimer: number | null
  thumbBusy: boolean
  offscreen: Renderer | null
  map: PlaceMap | null
  viewCache: { key: unknown[], ids: string[] } | null
  countsCache: { library: Library, counts: Counts } | null
  editor: Editor
  saveTimer: number | null
  saving: Promise<void> | null
  saveQueued: boolean
  dirtySince: number | null
  frame: number
  toastTimer: number | null
}

export function initialState(root: HTMLElement): AppState {
  return {
    root,
    library: null,
    dirs: null,
    remembered: null,
    error: null,
    view: { kind: 'all' },
    sort: 'date',
    selection: new Set(),
    anchor: null,
    current: null,
    mode: 'grid',
    before: false,
    zoom: false,
    dialog: null,
    renaming: null,
    progress: null,
    toast: null,
    history: emptyHistory(),
    clipboard: null,
    grid: { width: 0, height: 0, scroll: 0, reveal: false },
    marquee: null,
    marqueeMoved: false,
    dragIds: [],
    dropIndex: null,
    dropAlbum: null,
    draggingFiles: false,
    thumbs: new Map(),
    thumbsPending: new Set(),
    thumbQueue: new Set(),
    thumbTimer: null,
    thumbBusy: false,
    offscreen: null,
    map: null,
    viewCache: null,
    countsCache: null,
    editor: {
      renderer: null,
      loaded: null,
      loading: null,
      bitmap: null,
      sampler: null,
      stage: { width: 0, height: 0 },
      drag: null,
      horizon: null,
      tool: 'none',
      histogram: null,
      histogramKey: null,
      histogramTimer: null,
      centre: false,
      stripFor: null,
      video: null,
      playing: false,
      time: 0
    },
    saveTimer: null,
    saving: null,
    saveQueued: false,
    dirtySince: null,
    frame: 0,
    toastTimer: null
  }
}

// Ids of the photos in the current view, recomputed only when the
// library, view or sort changed.
export function viewIds(state: AppState) {
  if (!state.library) return []

  const key = [state.library, state.view, state.sort]
  const cached = state.viewCache
  if (cached && cached.key.every((part, i) => part === key[i])) {
    return cached.ids
  }

  const ids = viewPhotos(state.library, state.view, state.sort)
  state.viewCache = { key, ids }
  return ids
}

export function counts(state: AppState, library: Library) {
  if (state.countsCache?.library !== library) {
    state.countsCache = { library, counts: libraryCounts(library) }
  }
  return state.countsCache.counts
}

// Sections of the current view for the grid: one per album in the In
// albums view, one without a header elsewhere.
export function viewSections(state: AppState): Section[] {
  if (!state.library) return []
  if (state.view.kind !== 'albums') return plain(viewIds(state).length)

  return albumSections(state.library).map(s => ({
    title: s.album.name, count: s.ids.length, key: s.album.id
  }))
}

export function currentPhoto(state: AppState) {
  if (!state.library || !state.current) return null
  return state.library.photos[state.current] ?? null
}

export function infoForm(state: AppState) {
  return state.dialog?.kind === 'info' ? state.dialog.form : null
}

export function currentAlbum(state: AppState) {
  const view = state.view
  if (view.kind !== 'album' || !state.library) return null
  return state.library.albums.find(a => a.id === view.id) ?? null
}

// Records the change for undo and swaps the library in.
export function applyLibrary(
  state: AppState, next: Library, tag: string | null = null
) {
  const before = state.library
  if (!before || next === before) return null

  state.history = recordChange(state.history, before, tag, Date.now())
  state.library = next
  return before
}

export function isSaved(state: AppState) {
  return !state.saveTimer && !state.saving && !state.saveQueued
}

export function endCoalescing(state: AppState) {
  state.history = { ...state.history, tag: null }
}

export function showToast(state: AppState, text: string) {
  state.toast = { text, at: Date.now() }
}
