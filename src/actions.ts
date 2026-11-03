import { commit, redoChange, replaceLibrary, undoChange } from './commit'
import {
  autoCurrent, autoSelection, autoWhiteBalanceCurrent, closeEditor,
  copySettings, flip, openPhoto, pasteSettings, resetColour, resetCrop,
  resetSlider, rotate, seek, setAspect, setSlider, swapOrientation,
  togglePlay
} from './editing'
import { exportDialog, runExport } from './export'
import { emptyHistory } from './history'
import { importEntries } from './importer'
import {
  addToAlbum, createAlbum, deleteAlbum, emptyTrash, removeFromAlbum,
  notInAlbums, renameAlbum, renamePhoto, restorePhotos, setAlbumSort,
  retime, setPhotoSizes, toggleStars, trashPhotos, type AlbumSort
} from './library'
import { render } from './render'
import type { Aspect, SliderKey } from './schema'
import {
  currentAlbum, endCoalescing, showToast, viewIds, type AppState,
  type ExportForm
} from './state'
import {
  chooseImportFolder, chooseLibrary, deletePhotoFiles, grantAccess,
  openLibrary, readOriginal, rememberLibrary
} from './storage'
import { localIso } from './mp4'
import { dateChange, pickerOptions } from './ui/dialogs'

type Data = DOMStringMap
type Handler = (state: AppState, data: Data, event: Event) => void

// ─── Library folder ──────────────────────────────────────────────────

async function openFrom(state: AppState, handle: FileSystemDirectoryHandle) {
  state.error = null
  try {
    if (!(await grantAccess(handle))) {
      state.error = 'Lightbox needs read and write access to the folder.'
      return
    }
    const { dirs, library, restored } = await openLibrary(handle)
    state.dirs = dirs
    state.library = library
    state.history = emptyHistory()
    await rememberLibrary(handle)
    void recordSizes(state)
    if (restored) {
      showToast(state, `The library file was damaged. Restored ${restored}.`)
    }
  } catch (error) {
    state.error = `Could not open the library: ${String(error)}`
  } finally {
    render(state)
  }
}

async function importFolder(state: AppState) {
  try {
    await importEntries(state, [await chooseImportFolder()])
  } catch (error) {
    if ((error as DOMException).name === 'AbortError') return
    showToast(state, `Could not read the folder: ${String(error)}`)
    render(state)
  }
}

// Photos imported before file sizes were recorded get them once, so
// sorting by size covers the whole library.
async function recordSizes(state: AppState) {
  const missing = Object.values(state.library!.photos)
    .filter(p => !p.bytes)
    .map(p => p.id)
  if (!missing.length || !state.dirs) return

  const sizes: Record<string, number> = {}
  for (const id of missing) {
    try {
      const photo = state.library!.photos[id]
      sizes[id] = (await readOriginal(state.dirs, photo)).size
    } catch {
      // Missing original; nothing to record.
    }
  }
  replaceLibrary(state, setPhotoSizes(state.library!, sizes))
}

async function chooseFolder(state: AppState) {
  try {
    await openFrom(state, await chooseLibrary())
  } catch (error) {
    if ((error as DOMException).name === 'AbortError') return
    state.error = String(error)
    render(state)
  }
}

// ─── Selection ───────────────────────────────────────────────────────

function select(state: AppState, id: string, event: MouseEvent) {
  const ids = viewIds(state)
  const additive = event.ctrlKey || event.metaKey

  if (event.shiftKey && state.anchor && ids.includes(state.anchor)) {
    const ends = [ids.indexOf(state.anchor), ids.indexOf(id)]
    const [a, b] = ends.sort((x, y) => x - y)
    const range = ids.slice(a, b + 1)
    state.selection = new Set(additive ? [...state.selection, ...range] : range)
  } else if (additive) {
    toggle(state, id)
  } else {
    state.selection = new Set([id])
    state.anchor = id
  }
  state.current = id
}

function toggle(state: AppState, id: string) {
  const selection = new Set(state.selection)
  if (selection.has(id)) selection.delete(id)
  else selection.add(id)

  state.selection = selection
  state.anchor = id
  state.current = id
}

// Selected ids in the order they appear in the view.
export function selectedIds(state: AppState) {
  return viewIds(state).filter(id => state.selection.has(id))
}

function targets(state: AppState) {
  if (state.mode !== 'grid') return state.current ? [state.current] : []
  return selectedIds(state)
}

// ─── Albums ──────────────────────────────────────────────────────────

function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

export function addSelectionTo(
  state: AppState, albumId: string | null, name = ''
) {
  const lib = state.library
  if (!lib) return

  const id = albumId ?? newId()
  const created = albumId ? lib : createAlbum(lib, id, name)
  const ids = targets(state)
  commit(state, addToAlbum(created, id, ids))

  const album = state.library!.albums.find(a => a.id === id)!
  state.dialog = null
  const count = `${ids.length} ${plural(ids.length)}`
  showToast(state, `Added ${count} to ${album.name}.`)
  render(state)
}

export function pickHighlighted(state: AppState) {
  const d = state.dialog
  if (d?.kind !== 'picker' || !state.library) return

  const { albums, create } = pickerOptions(state.library, d.query)
  const album = albums[d.index]
  if (album) addSelectionTo(state, album.id)
  else if (create) addSelectionTo(state, null, create)
}

export function commitRename(state: AppState, input: HTMLInputElement) {
  const r = state.renaming
  if (!r || !state.library || r.id !== input.dataset.id) return

  state.renaming = null
  const lib = r.kind === 'album'
    ? renameAlbum(state.library, r.id, input.value)
    : renamePhoto(state.library, r.id, input.value)
  commit(state, lib)
  render(state)
}

export function removeSelection(state: AppState) {
  const lib = state.library
  const ids = targets(state)
  if (!lib || ids.length === 0 || state.view.kind === 'trash') return

  if (state.view.kind === 'albums') return

  const album = currentAlbum(state)
  if (album) {
    commit(state, removeFromAlbum(lib, album.id, ids))
    const text = `Removed ${ids.length} from ${album.name}.`
    showToast(state, `${text} Ctrl+Z undoes it.`)
  } else {
    commit(state, trashPhotos(lib, ids, new Date().toISOString()))
    showToast(state, `Moved ${ids.length} to the trash. Ctrl+Z undoes it.`)
  }
  if (state.mode !== 'grid') closeEditor(state)
  render(state)
}

// The time entered belongs to the first selected photo in the order
// shown; the others move with it or follow it. A photo without a date
// starts at noon today.
function openDateDialog(state: AppState) {
  const ids = targets(state)
  if (!ids.length) return

  const reference = ids[0]
  const today = `${localIso(new Date()).slice(0, 10)}T12:00:00`
  const value = state.library!.photos[reference].takenAt ?? today
  state.dialog = { kind: 'date', ids, reference, value }
}

function applyDate(state: AppState) {
  const d = state.dialog
  if (d?.kind !== 'date' || !state.library) return

  const { to, changes } = dateChange(state.library, d)
  if (!to || !changes) return

  state.dialog = null
  commit(state, retime(state.library, d.ids, d.reference, to))
  showToast(state, 'Updated the capture times. Ctrl+Z undoes it.')
}

function trashUnalbumed(state: AppState) {
  const lib = state.library!
  const ids = notInAlbums(lib, viewIds(state))
  commit(state, trashPhotos(lib, ids, new Date().toISOString()))
  const count = `${ids.length} ${plural(ids.length)}`
  showToast(state, `Moved ${count} to the Trash. Ctrl+Z undoes it.`)
}

async function emptyTheTrash(state: AppState) {
  if (!state.library || !state.dirs) return

  const before = state.library
  const { library, removed } = emptyTrash(before)
  state.history = emptyHistory()
  replaceLibrary(state, library)
  for (const id of removed) {
    const url = state.thumbs.get(id)
    if (url) URL.revokeObjectURL(url)
    state.thumbs.delete(id)
  }
  await deletePhotoFiles(state.dirs, removed.map(id => before.photos[id]))
  const count = `${removed.length} ${plural(removed.length)}`
  showToast(state, `Deleted ${count} for good.`)
  render(state)
}

// ─── Click actions ───────────────────────────────────────────────────

export const clicks: Record<string, Handler> = {
  'choose-library': state => void chooseFolder(state),
  'reopen-library': state => {
    if (state.remembered) void openFrom(state, state.remembered)
  },

  view: (state, data) => {
    const kind = data.kind as AppState['view']['kind']
    state.view = kind === 'album'
      ? { kind, id: data.id! }
      : { kind } as AppState['view']
    state.selection = new Set()
    state.anchor = null
    state.grid.scroll = 0
    state.mode = 'grid'
    const grid = state.root.querySelector('[data-grid]')
    if (grid) grid.scrollTop = 0
  },

  'new-album': state => {
    const id = newId()
    commit(state, createAlbum(state.library!, id, 'New album'))
    state.view = { kind: 'album', id }
    state.renaming = { kind: 'album', id }
    state.selection = new Set()
  },
  'export-album': state => {
    const album = currentAlbum(state)
    if (album) exportDialog(state, [album.id])
  },
  'export-all': state => {
    const ids = state.library!.albums.map(a => a.id)
    if (ids.length) exportDialog(state, ids)
    else showToast(state, 'Create an album first.')
  },
  'delete-album': state => {
    const album = currentAlbum(state)
    if (!album) return
    commit(state, deleteAlbum(state.library!, album.id))
    state.view = { kind: 'all' }
    const text = `Deleted the album ${album.name}. Its photos stay.`
    showToast(state, `${text} Ctrl+Z undoes it.`)
  },
  'empty-trash': state => {
    state.dialog = {
      kind: 'confirm',
      message: 'Delete the photos in the trash for good?',
      confirm: 'Delete',
      action: 'empty-trash'
    }
  },
  confirm: state => {
    const d = state.dialog
    state.dialog = null
    if (d?.kind !== 'confirm') return
    if (d.action === 'empty-trash') void emptyTheTrash(state)
    if (d.action === 'trash-unalbumed') trashUnalbumed(state)
  },
  'trash-unalbumed': state => {
    const ids = notInAlbums(state.library!, viewIds(state))
    if (!ids.length) {
      showToast(state, 'Every photo of this import is in an album.')
      return
    }
    const count = `${ids.length} ${plural(ids.length)}`
    const verb = ids.length === 1 ? 'is' : 'are'
    state.dialog = {
      kind: 'confirm',
      message: `Move ${count} that ${verb} in no album to the Trash?`,
      confirm: 'Move to Trash',
      action: 'trash-unalbumed'
    }
  },

  'import-files': state => {
    state.root.querySelector<HTMLInputElement>('#import-files')?.click()
  },
  'import-folder': state => void importFolder(state),

  undo: state => undoChange(state),
  redo: state => redoChange(state),
  help: state => {
    state.dialog = { kind: 'help' }
  },

  select: (state, data, event) => select(state, data.id!, event as MouseEvent),
  toggle: (state, data) => toggle(state, data.id!),
  open: (state, data) => openPhoto(state, data.id!),
  'select-all': state => {
    state.selection = new Set(viewIds(state))
  },
  'clear-selection': state => {
    state.selection = new Set()
  },
  'open-picker': state => {
    if (!targets(state).length) return
    state.dialog = { kind: 'picker', query: '', index: 0 }
  },
  'pick-album': (state, data) => addSelectionTo(state, data.id!),
  'pick-new': state => pickHighlighted(state),
  'auto-selection': state => void autoSelection(state),
  'open-date': state => openDateDialog(state),
  'apply-date': state => applyDate(state),
  star: state => {
    const ids = targets(state)
    if (ids.length) commit(state, toggleStars(state.library!, ids))
  },
  'star-one': (state, data) => {
    commit(state, toggleStars(state.library!, [data.id!]))
  },
  'paste-settings': state => pasteSettings(state, targets(state)),
  'remove-selection': state => removeSelection(state),
  'restore-selection': state => {
    const ids = selectedIds(state)
    commit(state, restorePhotos(state.library!, ids))
    showToast(state, `Restored ${ids.length} ${plural(ids.length)}.`)
  },

  'close-editor': state => closeEditor(state),
  'toggle-before': state => {
    state.before = !state.before
  },
  'toggle-zoom': state => {
    state.zoom = !state.zoom
    state.editor.centre = state.zoom
  },
  'crop-tool': state => {
    state.mode = state.mode === 'crop' ? 'edit' : 'crop'
    state.zoom = false
    state.editor.tool = 'none'
  },
  'crop-done': state => {
    state.mode = 'edit'
    state.editor.tool = 'none'
  },
  auto: state => void autoCurrent(state),
  play: state => {
    togglePlay(state)
  },
  'auto-wb': state => void autoWhiteBalanceCurrent(state),
  'copy-settings': state => copySettings(state),
  'reset-all': state => resetColour(state),
  eyedropper: state => {
    const on = state.editor.tool === 'eyedropper'
    state.editor.tool = on ? 'none' : 'eyedropper'
    if (state.mode === 'crop') state.mode = 'edit'
  },
  aspect: (state, data) => setAspect(state, data.aspect as Aspect),
  'swap-crop': state => swapOrientation(state),
  rotate: (state, data) => rotate(state, Number(data.turn)),
  flip: state => flip(state),
  horizon: state => {
    state.editor.tool = state.editor.tool === 'horizon' ? 'none' : 'horizon'
  },
  'reset-crop': state => resetCrop(state),

  'close-dialog': state => {
    state.dialog = null
  },
  'export-naming': (state, data) => {
    if (state.dialog?.kind !== 'export') return
    state.dialog.form.naming = data.value as ExportForm['naming']
  },
  'run-export': state => {
    const d = state.dialog
    if (d?.kind === 'export') void runExport(state, d.form)
  },
  'cancel-progress': state => {
    if (state.progress) state.progress.cancelled = true
  },
  'dismiss-toast': state => {
    state.toast = null
  }
}

export const doubleClicks: Record<string, Handler> = {
  open: (state, data) => openPhoto(state, data.id!),
  'rename-album': (state, data) => {
    state.renaming = { kind: 'album', id: data.id! }
  },
  'rename-photo': state => {
    if (state.current) state.renaming = { kind: 'photo', id: state.current }
  },
  'reset-slider': (state, data) => resetSlider(state, data.key as SliderKey)
}

// ─── Form input ──────────────────────────────────────────────────────

export function input(state: AppState, el: HTMLInputElement) {
  const kind = el.dataset.input
  if (kind === 'slider') {
    setSlider(state, el.dataset.key as SliderKey, Number(el.value))
    return
  }
  if (kind === 'picker' && state.dialog?.kind === 'picker') {
    state.dialog = { kind: 'picker', query: el.value, index: 0 }
    render(state)
    return
  }
  if (kind === 'export-field') exportField(state, el)
  if (kind === 'seek') seek(state, Number(el.value))
  if (kind === 'date-value' && state.dialog?.kind === 'date') {
    state.dialog = { ...state.dialog, value: el.value }
    render(state)
  }
}

export function change(state: AppState, el: HTMLInputElement) {
  const kind = el.dataset.change
  if (kind === 'slider-end') endCoalescing(state)
  if (kind === 'sort') sortBy(state, el.value as AlbumSort)
  if (kind === 'export-field') exportField(state, el)
  if (kind === 'import-input') {
    const files = [...(el.files ?? [])]
    el.value = ''
    void importEntries(state, files)
  }
}

function sortBy(state: AppState, sort: AlbumSort) {
  const album = currentAlbum(state)
  if (album) commit(state, setAlbumSort(state.library!, album.id, sort))
  else if (sort !== 'custom') state.sort = sort
  render(state)
}

function exportField(state: AppState, el: HTMLInputElement) {
  if (state.dialog?.kind !== 'export') return

  const form = state.dialog.form as Record<string, unknown>
  const field = el.dataset.field!
  const current = form[field]
  if (typeof current === 'boolean') form[field] = el.checked
  else if (typeof current === 'number') form[field] = Number(el.value) || 0
  else form[field] = el.value
  render(state)
}

function plural(n: number) {
  return n === 1 ? 'photo' : 'photos'
}
