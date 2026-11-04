import {
  commit, redoChange, replaceLibrary, scheduleSave, undoChange
} from './commit'
import {
  autoCurrent, autoSelection, autoWhiteBalanceCurrent, closeEditor,
  copySettings, dragTrim, flip, openPhoto, pasteSettings, resetColour,
  resetCrop, resetSlider, resetTrim, rotate, seek, setAspect, setSlider,
  swapOrientation, togglePlay
} from './editing'
import { exportDialog, runExport } from './export'
import { formatList } from './format'
import { emptyHistory } from './history'
import { importEntries } from './importer'
import {
  addToAlbum, createAlbum, deleteAlbum, emptyTrash, fixTaken,
  removeFromAlbum, notInAlbums, renameAlbum, renamePhoto, renamePhotos,
  restorePhotos, setAlbumSort, retime, setMeta, setPhotoSizes, toggleStars,
  trashPhotos, type AlbumSort, type TakenFix, type TrimEdge
} from './library'
import { ensureMap, pickPlace, searchPlace, showCameraLocation } from './map'
import { render } from './render'
import type { Aspect, SliderKey } from './schema'
import {
  currentAlbum, endCoalescing, infoForm, selectedIds, showToast, targets,
  viewIds, type AlbumPick, type AppState, type ExportForm, type InfoField
} from './state'
import {
  chooseImportFolder, chooseLibrary, deletePhotoFiles, grantAccess,
  openLibrary, readOriginal, rememberLibrary
} from './storage'
import { headerTaken, localIso, olympusTaken, readMoov } from './mp4'
import {
  dateChange, infoChange, newInfoForm, newRename, pickerAdd, renameNames,
  toggledTicks
} from './ui/dialogs'

type Data = DOMStringMap
type Handler = (state: AppState, data: Data, event: Event) => void

const OLYMPUS_REPAIR = 'olympus-video-times'

// ─── Library folder ──────────────────────────────────────────────────

async function openFrom(state: AppState, handle: FileSystemDirectoryHandle) {
  state.error = null
  try {
    if (!(await grantAccess(handle))) {
      state.error = 'Photoloft needs read and write access to the folder.'
      return
    }
    const { dirs, library, restored } = await openLibrary(handle)
    state.dirs = dirs
    state.library = library
    state.history = emptyHistory()
    await rememberLibrary(handle)
    void recordSizes(state)
    void correctOlympusTimes(state)
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

// Clips whose header holds an Olympus camera's local clock reading were
// stored with it read as UTC. Once per library, those whose time is
// still that get the camera's, as one undo step. The mark sits in
// `Dirs`, outside undo, so a reload after Ctrl+Z leaves them alone.
async function correctOlympusTimes(state: AppState) {
  const dirs = state.dirs
  if (!dirs || dirs.repairs.includes(OLYMPUS_REPAIR)) return

  const fixes: TakenFix[] = []
  for (const photo of Object.values(state.library!.photos)) {
    if (!photo.video) continue
    try {
      const moov = await readMoov(await readOriginal(dirs, photo))
      const camera = moov && olympusTaken(moov)
      if (!moov || camera?.header !== 'local') continue
      fixes.push({ id: photo.id, from: headerTaken(moov), to: camera.taken })
    } catch {
      // Missing original; the clip keeps its time.
    }
  }
  if (state.dirs !== dirs) return

  dirs.repairs.push(OLYMPUS_REPAIR)
  const lib = state.library!
  const fixed = fixTaken(lib, fixes)
  if (fixed === lib) {
    scheduleSave(state)
    return
  }

  commit(state, fixed)
  const changed = fixes.filter(f => fixed.photos[f.id] !== lib.photos[f.id])
  const what = changed.length === 1
    ? 'the capture time of 1 Olympus video'
    : `the capture times of ${changed.length} Olympus videos`
  showToast(state, `Corrected ${what}. Ctrl+Z undoes it.`)
  render(state)
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

// ─── Albums ──────────────────────────────────────────────────────────

function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

// Adds `targets(state)` to every album picked, creating the new ones,
// as one change that one undo takes back. An add that puts no photo
// anywhere changes nothing; the toast counts the photos that went in.
export function addSelectionTo(state: AppState, picks: AlbumPick[]) {
  if (!state.library || !picks.length) return

  const photos = targets(state)
  const before = state.library
  let lib = before
  const ids: string[] = []
  for (const pick of picks) {
    const id = 'id' in pick ? pick.id : newId()
    if ('name' in pick) lib = createAlbum(lib, id, pick.name)
    lib = addToAlbum(lib, id, photos)
    ids.push(id)
  }
  commit(state, lib)

  const names = ids.map(id => lib.albums.find(a => a.id === id)!.name)
  const where = names.length > 3 ? `${names.length} albums` : formatList(names)
  const had = ids
    .map(id => before.albums.find(a => a.id === id)?.photos)
    .map(list => new Set(list))
  const added = photos.filter(p => had.some(held => !held.has(p)))
  state.dialog = null
  if (added.length) {
    const count = `${added.length} ${plural(added.length)}`
    showToast(state, `Added ${count} to ${where}.`)
  } else {
    const n = photos.length
    const these = n === 1 ? 'this photo' : `these ${n} photos`
    const hold = names.length === 1 ? 'holds' : 'hold'
    showToast(state, `${where} already ${hold} ${these}.`)
  }
  render(state)
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

function openInfoDialog(state: AppState) {
  const ids = targets(state)
  if (!ids.length || state.view.kind === 'trash') return

  const lib = state.library!
  const form = newInfoForm(lib, ids)
  ensureMap(state)
  state.dialog = { kind: 'info', form }
  if (lib.photos[ids[0]].meta.location === undefined) {
    void showCameraLocation(state, form)
  }
}

function applyInfo(state: AppState) {
  const form = infoForm(state)
  if (!form || !state.library) return

  const { change, changes } = infoChange(state.library, form)
  if (!changes) return

  state.dialog = null
  commit(state, setMeta(state.library, form.ids, change))
  const count = `${form.ids.length} ${plural(form.ids.length)}`
  showToast(state, `Updated the info of ${count}. Ctrl+Z undoes it.`)
}

function openRenameDialog(state: AppState) {
  const ids = targets(state)
  if (!ids.length || state.view.kind === 'trash') return

  state.dialog = newRename(state.library!, ids, currentAlbum(state))
}

// Types the placeholder over the field's selection, which the field
// keeps while the button has focus, and leaves the cursor after it.
function insertToken(state: AppState, token: string) {
  const d = state.dialog
  const field = state.root
    .querySelector<HTMLInputElement>('[data-dialog] [data-field="pattern"]')
  if (d?.kind !== 'rename' || !field) return

  const { selectionStart, selectionEnd } = field
  const end = field.value.length
  field.focus()
  field.setRangeText(token, selectionStart ?? end, selectionEnd ?? end, 'end')
  state.dialog = { ...d, pattern: field.value }
}

// One change for all the photos; one that renames none records nothing.
function applyRename(state: AppState) {
  const d = state.dialog
  if (d?.kind !== 'rename' || !state.library || !d.pattern.trim()) return

  const names = renameNames(state.library, d)
  const named = Object.fromEntries(d.ids.map((id, i) => [id, names[i]]))
  state.dialog = null
  commit(state, renamePhotos(state.library, named))
  const count = `${d.ids.length} ${plural(d.ids.length)}`
  showToast(state, `Renamed ${count}.`)
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
    if (!targets(state).length || state.view.kind === 'trash') return
    state.dialog = { kind: 'picker', query: '', ticked: [], taken: null }
  },

  // A click or Space on a tick box ticks or unticks its row and clears
  // the field, so leftover filter text never names a new album.
  'pick-album': (state, data) => {
    const d = state.dialog
    if (d?.kind !== 'picker' || !state.library) return

    const index = Number(data.index)
    const ticked = toggledTicks(state.library, d, targets(state), index)
    if (ticked) state.dialog = { ...d, ticked, query: '', taken: null }
  },

  // Add and Enter: adds, or says the typed name is an album already,
  // or with nothing to add goes to the field.
  'add-to-albums': state => {
    const d = state.dialog
    if (d?.kind !== 'picker' || !state.library) return

    const { picks, taken } = pickerAdd(state.library, d)
    if (taken) state.dialog = { ...d, taken }
    else if (picks.length) addSelectionTo(state, picks)
    else state.root.querySelector<HTMLElement>('[data-input="picker"]')?.focus()
  },
  'auto-selection': state => void autoSelection(state),
  'open-date': state => openDateDialog(state),
  'apply-date': state => applyDate(state),
  'open-info': state => openInfoDialog(state),
  'apply-info': state => applyInfo(state),
  'open-rename': state => openRenameDialog(state),
  'rename-insert': (state, data) => insertToken(state, data.token!),
  'apply-rename': state => applyRename(state),
  'info-search': state => void searchPlace(state),
  'info-place': (state, data) => pickPlace(state, Number(data.index)),
  'info-remove-location': state => {
    const form = infoForm(state)
    if (!form) return
    form.pin = null
    form.moved = true
  },
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
  'reset-trim': state => resetTrim(state),
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
    state.dialog = { ...state.dialog, query: el.value, taken: null }
    render(state)
    return
  }
  if (kind === 'export-field') exportField(state, el)
  if (kind === 'seek') seek(state, Number(el.value))
  if (kind === 'trim') {
    dragTrim(state, el.dataset.edge as TrimEdge, Number(el.value))
  }
  if (kind === 'date-value' && state.dialog?.kind === 'date') {
    state.dialog = { ...state.dialog, value: el.value }
    render(state)
  }
  if (kind === 'info-text' || kind === 'info-query') infoInput(state, el)
  if (kind === 'rename-field') renameField(state, el)
}

function infoInput(state: AppState, el: HTMLInputElement) {
  const form = infoForm(state)
  if (!form) return

  if (el.dataset.input === 'info-query') form.query = el.value
  else form.text[el.dataset.field as InfoField] = el.value
  render(state)
}

function renameField(state: AppState, el: HTMLInputElement) {
  const d = state.dialog
  if (d?.kind !== 'rename') return

  state.dialog = el.dataset.field === 'start'
    ? { ...d, start: Number(el.value) || 0 }
    : { ...d, pattern: el.value }
  render(state)
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
