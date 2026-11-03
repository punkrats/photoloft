import { render as litRender } from 'lit-html'
import type { AppState } from './state'
import { app } from './ui/app'

export const RENDERED = 'photoloft:rendered'

// Batches renders into one per animation frame. Listeners for
// RENDERED do the work that needs the fresh DOM (painting the canvas,
// loading visible thumbnails).
export function render(state: AppState) {
  if (state.frame) return

  state.frame = requestAnimationFrame(() => draw(state))
}

// Draws a pending render at once, for a key that must find the page as
// the state already describes it.
export function flush(state: AppState) {
  if (!state.frame) return

  cancelAnimationFrame(state.frame)
  draw(state)
}

function draw(state: AppState) {
  state.frame = 0
  const active = document.activeElement as HTMLElement | null
  const key = active?.dataset?.focusKey
  try {
    litRender(app(state), state.root)
  } catch (error) {
    showCrash(error)
    throw error
  }
  focusPending(state, key)
  state.root.dispatchEvent(new CustomEvent(RENDERED))
}

// A failed render leaves the previous screen in place and the app seems
// frozen. Say what happened instead; the library file is separate and
// stays as last saved.
function showCrash(error: unknown) {
  const note = document.getElementById('crash')
  if (!note) return

  const what = `Photoloft could not show this screen (${String(error)}).`
  note.hidden = false
  note.textContent =
    `${what} Your library is safe. Please reload, and report this message.`
}

// Inputs that appear in this render (rename fields, a dialog's first
// field) get focus once. lit reuses elements by position, so a focused
// `data-focus-key` row that now shows another item hands focus to its
// key, or to the dialog's first field when that item is gone.
function focusPending(state: AppState, key: string | undefined) {
  const root = state.root
  const active = document.activeElement as HTMLElement | null
  if (key && active?.dataset?.focusKey !== key) {
    const keyed = `[data-focus-key="${CSS.escape(key)}"]`
    const target = root.querySelector<HTMLElement>(keyed) ??
      root.querySelector<HTMLElement>('[data-dialog] [data-autofocus]')
    target?.focus()
  }

  const input = root.querySelector<HTMLInputElement>(
    '[data-rename], [data-autofocus]'
  )
  if (!input || input === document.activeElement) return
  if (input.dataset.focused) return

  input.dataset.focused = 'true'
  input.focus()
  input.select()
}
