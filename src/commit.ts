import { redo, undo } from './history'
import { withBookkeeping, type Library } from './library'
import { render } from './render'
import { applyLibrary, showToast, viewIds, type AppState } from './state'
import { saveLibrary } from './storage'
import { refreshThumbs } from './thumbs'

const SAVE_DELAY = 700
const SAVE_MAX_WAIT = 2000

// Every library change goes through here: undo history, thumbnails of
// changed edits, selection upkeep, saving, rendering.
export function commit(
  state: AppState, next: Library, tag: string | null = null
) {
  const before = applyLibrary(state, next, tag)
  if (before) afterChange(state, before)
}

// Takes the bookkeeping of `next` (`withBookkeeping`) and nothing else,
// without an undo step; undo and redo keep it as it is.
export function applyBookkeeping(state: AppState, next: Library) {
  const before = state.library
  if (!before) return

  const after = withBookkeeping(before, next)
  if (after === before) return
  state.library = after
  afterChange(state, before)
}

export function undoChange(state: AppState) {
  if (!state.library) return

  const result = undo(state.history, state.library)
  if (!result) return

  const before = state.library
  state.history = result.history
  state.library = result.library
  afterChange(state, before)
}

export function redoChange(state: AppState) {
  if (!state.library) return

  const result = redo(state.history, state.library)
  if (!result) return

  const before = state.library
  state.history = result.history
  state.library = result.library
  afterChange(state, before)
}

function afterChange(state: AppState, before: Library) {
  const after = state.library!
  if (after.photos !== before.photos) {
    const changed = Object.keys(after.photos).filter(id => {
      const old = before.photos[id]
      return old && old.edit !== after.photos[id].edit
    })
    if (changed.length) refreshThumbs(state, changed)
  }

  const visible = new Set(viewIds(state))
  for (const id of state.selection) {
    if (!visible.has(id)) state.selection.delete(id)
  }
  if (state.current && !after.photos[state.current]) {
    state.current = null
    state.mode = 'grid'
  }

  scheduleSave(state)
  render(state)
}

// Saves once changes pause, and at the latest SAVE_MAX_WAIT after the
// first unsaved change, so steady activity cannot postpone it forever.
export function scheduleSave(state: AppState) {
  const now = Date.now()
  state.dirtySince ??= now
  const due = state.dirtySince + SAVE_MAX_WAIT - now
  const wait = Math.max(0, Math.min(SAVE_DELAY, due))

  if (state.saveTimer) clearTimeout(state.saveTimer)
  state.saveTimer = window.setTimeout(() => void saveNow(state), wait)
}

// Saves never overlap: a save requested while one runs is done right
// after it, with the library as it is by then.
export async function saveNow(state: AppState): Promise<void> {
  if (state.saveTimer) clearTimeout(state.saveTimer)
  state.saveTimer = null
  if (!state.dirs || !state.library) return

  if (state.saving) {
    state.saveQueued = true
    return state.saving
  }

  state.dirtySince = null
  state.saving = saveLibrary(state.dirs, state.library)
    .catch(error => {
      showToast(state, `Could not save the library: ${String(error)}`)
      render(state)
    })
    .finally(() => {
      state.saving = null
      render(state)
      if (!state.saveQueued) return
      state.saveQueued = false
      void saveNow(state)
    })
  return state.saving
}
