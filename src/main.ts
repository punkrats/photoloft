import {
  addSelectionTo, change, clicks, commitRename, doubleClicks, input,
  removeSelection, tickHighlighted
} from './actions'
import { commit, redoChange, saveNow, undoChange } from './commit'
import {
  closeEditor, copySettings, endCropDrag, ensureRenderer, finishHorizon,
  loadCurrent, moveCropDrag, openPhoto, pasteSettings, pickWhite,
  startCropDrag, step, togglePlay
} from './editing'
import type { Handle } from './geometry'
import {
  cellsInRect, gridLayout, insertionIndex, revealScroll
} from './grid-layout'
import { importEntries } from './importer'
import { moveInAlbum } from './library'
import { paint } from './paint'
import { flush, render, RENDERED } from './render'
import {
  currentAlbum, currentPhoto, initialState, selectedIds, targets, viewIds,
  viewSections, type AppState, type Point
} from './state'
import { hasAccess, rememberedLibrary } from './storage'
import { pickerRows } from './ui/dialogs'
import { loadVisibleThumbs } from './thumbs'

const PHOTOS_TYPE = 'application/x-photoloft-photos'
const TOAST_MS = 5000

const root = document.getElementById('app')!
const state = initialState(root)

boot()

// Opens the remembered library right away when the browser still allows
// access; otherwise the start screen asks for one click.
async function boot() {
  wire(state)
  const remembered = await rememberedLibrary()
  state.remembered = remembered
  render(state)
  if (remembered && (await hasAccess(remembered))) {
    clicks['reopen-library'](state, {}, new Event('boot'))
  }
}

function wire(state: AppState) {
  const root = state.root
  root.addEventListener('click', e => onClick(state, e))
  root.addEventListener('dblclick', e => onDoubleClick(state, e))
  root.addEventListener('input', e => onInput(state, e))
  root.addEventListener('change', e => onChange(state, e))
  root.addEventListener('focusout', e => onFocusOut(state, e))
  root.addEventListener('pointerdown', e => onPointerDown(state, e))
  root.addEventListener('pointermove', e => onPointerMove(state, e))
  root.addEventListener('pointerup', e => onPointerUp(state, e))
  root.addEventListener('scroll', e => onScroll(state, e), true)
  root.addEventListener('dragstart', e => onDragStart(state, e))
  root.addEventListener('dragover', e => onDragOver(state, e))
  root.addEventListener('dragleave', e => onDragLeave(state, e))
  root.addEventListener('drop', e => onDrop(state, e))
  root.addEventListener('dragend', () => clearDrag(state))
  root.addEventListener(RENDERED, () => afterRender(state))
  window.addEventListener('keydown', e => onKey(state, e))
  window.addEventListener('beforeunload', e => onUnload(state, e))
}

// ─── After each render ───────────────────────────────────────────────

function afterRender(state: AppState) {
  ensureRenderer(state)
  observeSizes(state)
  if (state.mode !== 'grid') void loadCurrent(state)
  paint(state)
  loadVisibleThumbs(state)
  followFilmstrip(state)
  revealCurrent(state)
  centreZoom(state)
  hideToastLater(state)
}

// The grid and the stage hide each other. A hidden element reports a
// 0 x 0 box; keeping its last real size keeps the grid's layout, and
// with it the scroll position, while the editor is open.
function observeSizes(state: AppState) {
  const watch = (selector: string, apply: (r: DOMRectReadOnly) => void) => {
    const el = state.root.querySelector<HTMLElement>(selector)
    if (!el || el.dataset.observed) return

    el.dataset.observed = 'true'
    new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      if (r.width === 0 && r.height === 0) return

      apply(r)
      render(state)
    }).observe(el)
  }

  watch('[data-grid]', r => {
    state.grid.width = r.width
    state.grid.height = r.height
  })
  watch('[data-stage]', r => {
    state.editor.stage = { width: r.width, height: r.height }
  })
}

function followFilmstrip(state: AppState) {
  if (state.mode === 'grid' || state.editor.stripFor === state.current) return

  const item = state.root.querySelector('.film-item.current')
  if (!item) return
  state.editor.stripFor = state.current
  item.scrollIntoView({ inline: 'center', block: 'nearest' })
}

// Back from the editor, the grid returns to where it was and scrolls
// only as far as needed to show the photo last viewed.
function revealCurrent(state: AppState) {
  const grid = state.root.querySelector<HTMLElement>('[data-grid]')
  if (state.mode !== 'grid' || !state.grid.reveal || !grid) return

  state.grid.reveal = false
  const index = viewIds(state).indexOf(state.current ?? '')
  if (index < 0) return

  const { scroll, height } = state.grid
  grid.scrollTop = revealScroll(currentGrid(state), index, scroll, height)
}

function centreZoom(state: AppState) {
  if (!state.editor.centre) return

  const stage = state.root.querySelector<HTMLElement>('[data-stage]')
  if (!stage) return
  state.editor.centre = false
  stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2
  stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2
}

function hideToastLater(state: AppState) {
  const toast = state.toast
  if (!toast || state.toastTimer) return

  state.toastTimer = window.setTimeout(() => {
    state.toastTimer = null
    if (state.toast === toast) state.toast = null
    render(state)
  }, TOAST_MS)
}

// ─── Clicks and form input ───────────────────────────────────────────

function onClick(state: AppState, e: MouseEvent) {
  const target = e.target as HTMLElement
  const el = target.closest<HTMLElement>('[data-action]')
  const dialog = target.closest('[data-dialog]')
  if (!el || (dialog && el.contains(dialog))) return

  const action = el.dataset.action!
  if (action === 'select' && state.marqueeMoved) return

  const handler = clicks[action]
  if (!handler) return
  if (el.tagName === 'BUTTON' || action === 'select') e.preventDefault()
  handler(state, el.dataset, e)
  render(state)
}

function onDoubleClick(state: AppState, e: MouseEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-dblclick]')
  if (!el) return

  doubleClicks[el.dataset.dblclick!]?.(state, el.dataset, e)
  render(state)
}

function onInput(state: AppState, e: Event) {
  const el = e.target as HTMLInputElement
  if (el.dataset.input) input(state, el)
}

function onChange(state: AppState, e: Event) {
  const el = e.target as HTMLInputElement
  if (el.dataset.change) change(state, el)
}

function onFocusOut(state: AppState, e: FocusEvent) {
  const el = e.target as HTMLInputElement
  if (el.dataset.rename) commitRename(state, el)
}

// ─── Keyboard ────────────────────────────────────────────────────────

// Closing a dialog, a rename or the editor leaves its field focused
// until the next frame removes or hides it. A key pressed meanwhile
// draws that frame first and then goes to the page.
function onKey(state: AppState, e: KeyboardEvent) {
  flush(state)
  const target = e.target as HTMLElement
  const el = target.checkVisibility() ? target : document.body
  if (el instanceof HTMLInputElement && el.dataset.rename) {
    renameKey(state, el, e)
    return
  }
  if (el instanceof HTMLInputElement && el.dataset.input === 'picker') {
    pickerKey(state, e)
    return
  }

  if (isTyping(el, e.key) && e.key !== 'Escape') return

  const handled = shortcut(state, e)
  if (handled) {
    e.preventDefault()
    render(state)
  }
}

// Sliders and checkboxes keep only their own keys, so shortcuts still
// work right after dragging a slider.
function isTyping(el: HTMLElement, key: string) {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLSelectElement) return true
  if (!(el instanceof HTMLInputElement)) return false
  if (el.type === 'range') return /^(Arrow|Home|End|Page)/.test(key)
  if (el.type === 'checkbox') return key === ' '
  return true
}

function renameKey(state: AppState, el: HTMLInputElement, e: KeyboardEvent) {
  if (e.key === 'Enter') commitRename(state, el)
  if (e.key !== 'Escape') return

  state.renaming = null
  render(state)
}

// Arrows move the highlight, Enter ticks or unticks the highlighted
// row, Ctrl+Enter adds to the ticked albums, Esc closes.
function pickerKey(state: AppState, e: KeyboardEvent) {
  const d = state.dialog
  if (d?.kind !== 'picker' || !state.library) return

  const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 }
  if (e.key in moves) {
    e.preventDefault()
    const last = pickerRows(state.library, d, targets(state)).length - 1
    const index = Math.max(0, Math.min(last, d.index + moves[e.key]))
    state.dialog = { ...d, index }
  }
  const enter = e.key === 'Enter'
  if (enter && (e.ctrlKey || e.metaKey)) clicks['add-ticked'](state, {}, e)
  else if (enter) tickHighlighted(state)
  if (e.key === 'Escape') state.dialog = null
  render(state)
}

function shortcut(state: AppState, e: KeyboardEvent) {
  if (!state.library) return false

  const ctrl = e.ctrlKey || e.metaKey
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key

  if (key === 'Escape') return escape(state)
  if (state.dialog) return false
  if (key === '?') {
    state.dialog = { kind: 'help' }
    return true
  }
  if (ctrl && key === 'z') {
    if (e.shiftKey) redoChange(state)
    else undoChange(state)
    return true
  }
  if (ctrl && key === 'y') {
    redoChange(state)
    return true
  }
  if (ctrl && e.shiftKey && key === 'c' && state.mode !== 'grid') {
    copySettings(state)
    return true
  }
  if (ctrl && e.shiftKey && key === 'v') {
    pasteSettings(state, targets(state))
    return true
  }
  if (ctrl) return key === 'a' && state.mode === 'grid' && selectAll(state)

  return state.mode === 'grid' ? gridKey(state, key) : editorKey(state, key)
}

function escape(state: AppState) {
  if (state.dialog) state.dialog = null
  else if (state.editor.tool !== 'none') state.editor.tool = 'none'
  else if (state.mode === 'crop') state.mode = 'edit'
  else if (state.mode === 'edit') closeEditor(state)
  else state.selection = new Set()
  return true
}

function selectAll(state: AppState) {
  state.selection = new Set(viewIds(state))
  return true
}

function gridKey(state: AppState, key: string) {
  const ids = viewIds(state)
  const at = ids.indexOf(state.current ?? '')
  const cols = currentGrid(state).cols
  const moves: Record<string, number> = {
    ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols
  }

  if (key in moves && ids.length) {
    const next = ids[Math.min(ids.length - 1, Math.max(0, at + moves[key]))]
    state.selection = new Set([next])
    state.current = next
    state.anchor = next
    return true
  }
  const focused = state.current && ids.includes(state.current)
    ? state.current
    : ids.find(id => state.selection.has(id))
  if ((key === 'Enter' || key === ' ') && focused) {
    openPhoto(state, focused)
    return true
  }
  if (key === 'g' && state.selection.size) {
    clicks['open-picker'](state, {}, new Event('key'))
    return true
  }
  if (key === 'Delete' || key === 'Backspace') {
    removeSelection(state)
    return true
  }
  if (key === 's' && state.selection.size) {
    clicks.star(state, {}, new Event('key'))
    return true
  }
  if (key === 'i' && state.selection.size) {
    clicks['open-info'](state, {}, new Event('key'))
    return true
  }
  return false
}

function editorKey(state: AppState, key: string) {
  const actions: Record<string, () => void> = {
    ArrowLeft: () => step(state, -1),
    ArrowRight: () => step(state, 1),
    g: () => clicks['open-picker'](state, {}, new Event('key')),
    r: () => clicks['crop-tool'](state, {}, new Event('key')),
    z: () => clicks['toggle-zoom'](state, {}, new Event('key')),
    s: () => clicks.star(state, {}, new Event('key')),
    '\\': () => {
      state.before = !state.before
    },

    // Space leaves the editor on a photo and plays or pauses a video;
    // in the crop tool it only plays or pauses.
    ' ': () => {
      const video = currentPhoto(state)?.video
      if (state.mode === 'edit' && !video) closeEditor(state)
      else togglePlay(state)
    },
    k: () => {
      togglePlay(state)
    }
  }

  const action = actions[key]
  if (!action) return false
  action()
  return true
}

// ─── Pointer: marquee, crop, straighten, eyedropper ─────────────────

function framePoint(state: AppState, e: PointerEvent): Point | null {
  const frame = state.root.querySelector<HTMLElement>('[data-frame]')
  if (!frame) return null

  const rect = frame.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function gridPoint(state: AppState, e: PointerEvent): Point | null {
  const grid = state.root.querySelector<HTMLElement>('[data-grid]')
  if (!grid) return null

  const rect = grid.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top + grid.scrollTop }
}

function onPointerDown(state: AppState, e: PointerEvent) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement

  if (state.mode === 'crop' && target.closest('[data-frame]')) {
    cropPointerDown(state, e, target)
    return
  }
  if (state.mode === 'edit' && state.editor.tool === 'eyedropper') {
    const point = target.closest('[data-frame]') && framePoint(state, e)
    if (point) pickWhite(state, point)
    render(state)
    return
  }

  const onBackground = target.closest('[data-grid]') &&
    !target.closest('.cell, .grid-header')
  if (state.mode !== 'grid' || !onBackground) return

  const start = gridPoint(state, e)!
  const additive = e.ctrlKey || e.metaKey || e.shiftKey
  const base = new Set(additive ? state.selection : [])
  state.marquee = { start, end: start, base }
  state.marqueeMoved = false
  target.setPointerCapture(e.pointerId)
}

function cropPointerDown(
  state: AppState, e: PointerEvent, target: HTMLElement
) {
  const point = framePoint(state, e)!
  target.setPointerCapture(e.pointerId)
  e.preventDefault()

  if (state.editor.tool === 'horizon') {
    state.editor.horizon = { start: point, end: point }
    render(state)
    return
  }

  const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle
  if (handle) startCropDrag(state, handle as Handle, point)
}

function onPointerMove(state: AppState, e: PointerEvent) {
  if (state.editor.drag) {
    moveCropDrag(state, framePoint(state, e)!)
    return
  }
  if (state.editor.horizon) {
    const end = framePoint(state, e)!
    state.editor.horizon = { ...state.editor.horizon, end }
    render(state)
    return
  }

  const m = state.marquee
  if (!m) return
  const end = gridPoint(state, e)!
  const moved = Math.hypot(end.x - m.start.x, end.y - m.start.y) > 4
  state.marqueeMoved ||= moved
  state.marquee = { ...m, end }
  if (state.marqueeMoved) selectInMarquee(state)
  render(state)
}

function selectInMarquee(state: AppState) {
  const m = state.marquee!
  const ids = viewIds(state)
  const g = currentGrid(state)
  const rect = {
    x: Math.min(m.start.x, m.end.x),
    y: Math.min(m.start.y, m.end.y),
    w: Math.abs(m.end.x - m.start.x),
    h: Math.abs(m.end.y - m.start.y)
  }
  const hits = cellsInRect(g, rect, ids.length).map(i => ids[i])
  state.selection = new Set([...m.base, ...hits])
}

function onPointerUp(state: AppState, e: PointerEvent) {
  if (state.editor.drag) {
    endCropDrag(state)
    render(state)
    return
  }
  if (state.editor.horizon) {
    finishHorizon(state)
    render(state)
    return
  }
  if (!state.marquee) return

  if (!state.marqueeMoved && !(e.ctrlKey || e.metaKey || e.shiftKey)) {
    state.selection = new Set()
  }
  state.marquee = null
  setTimeout(() => {
    state.marqueeMoved = false
  })
  render(state)
}

function onScroll(state: AppState, e: Event) {
  const el = e.target as HTMLElement
  if (!(el instanceof HTMLElement) || !el.matches('[data-grid]')) return

  state.grid.scroll = el.scrollTop
  render(state)
}

// ─── Drag and drop ───────────────────────────────────────────────────

function onDragStart(state: AppState, e: DragEvent) {
  const cell = (e.target as HTMLElement).closest<HTMLElement>('.cell')
  if (!cell || !e.dataTransfer) return

  const id = cell.dataset.id!
  if (!state.selection.has(id)) {
    state.selection = new Set([id])
    state.anchor = id
  }
  state.dragIds = selectedIds(state)
  e.dataTransfer.setData(PHOTOS_TYPE, state.dragIds.join(','))
  e.dataTransfer.effectAllowed = 'copyMove'
  render(state)
}

function onDragOver(state: AppState, e: DragEvent) {
  const types = e.dataTransfer?.types ?? []
  const target = e.target as HTMLElement

  if (types.includes('Files')) {
    e.preventDefault()
    if (!state.draggingFiles) {
      state.draggingFiles = true
      render(state)
    }
    return
  }
  if (!types.includes(PHOTOS_TYPE)) return

  const album = target.closest<HTMLElement>('[data-drop-album]')
  const overGrid = target.closest('[data-grid]') && currentAlbum(state)
  if (album || overGrid) e.preventDefault()

  const dropAlbum = album?.dataset.dropAlbum ?? null
  const dropIndex = overGrid ? reorderIndex(state, e) : null
  if (dropAlbum === state.dropAlbum && dropIndex === state.dropIndex) return

  state.dropAlbum = dropAlbum
  state.dropIndex = dropIndex
  render(state)
}

function reorderIndex(state: AppState, e: DragEvent) {
  const point = gridPoint(state, e as unknown as PointerEvent)!
  const ids = viewIds(state)
  const g = currentGrid(state)
  return insertionIndex(g, point.x, point.y, ids.length)
}

function currentGrid(state: AppState) {
  const { width, height, scroll } = state.grid
  return gridLayout(width, height, scroll, viewSections(state))
}

function onDragLeave(state: AppState, e: DragEvent) {
  if (e.relatedTarget) return
  clearDrag(state)
}

function onDrop(state: AppState, e: DragEvent) {
  e.preventDefault()
  const transfer = e.dataTransfer
  if (!transfer) return

  if (transfer.types.includes('Files')) {

    // Handles must be requested while the event is being dispatched.
    const items = [...transfer.items].filter(i => i.kind === 'file')
    const handles = items.map(i => i.getAsFileSystemHandle())
    clearDrag(state)
    void Promise.all(handles).then(list => {
      const entries = list.filter((h): h is FileSystemHandle => h !== null)
      void importEntries(state, entries)
    })
    return
  }

  const album = currentAlbum(state)
  if (state.dropAlbum) {
    addSelectionTo(state, [{ id: state.dropAlbum }])
  } else if (album && state.dropIndex !== null) {
    const ids = state.dragIds
    commit(state, moveInAlbum(state.library!, album.id, ids, state.dropIndex))
  }
  clearDrag(state)
}

function clearDrag(state: AppState) {
  state.draggingFiles = false
  state.dropAlbum = null
  state.dropIndex = null
  state.dragIds = []
  render(state)
}

function onUnload(state: AppState, e: BeforeUnloadEvent) {
  if (!state.saveTimer && !state.saving) return

  void saveNow(state)
  e.preventDefault()
}
