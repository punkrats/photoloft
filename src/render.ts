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
  try {
    litRender(app(state), state.root)
  } catch (error) {
    showCrash(error)
    throw error
  }
  focusPending(state)
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

// Inputs that appear in this render (rename fields, the album picker)
// get focus once.
function focusPending(state: AppState) {
  const input = state.root.querySelector<HTMLInputElement>(
    '[data-rename], [data-autofocus]'
  )
  if (!input || input === document.activeElement) return
  if (input.dataset.focused) return

  input.dataset.focused = 'true'
  input.focus()
  input.select()
}
