import { html, nothing } from 'lit-html'
import { styleMap } from 'lit-html/directives/style-map.js'
import type { AppState } from '../state'
import { dialog } from './dialogs'
import { editor } from './editor'
import { library } from './library'
import { panel } from './panel'
import { sidebar } from './sidebar'
import { welcome } from './welcome'

export function app(state: AppState) {
  const lib = state.library
  if (!lib) return welcome(state)

  return html`
    <div class="app" data-mode=${state.mode}>
      ${sidebar(state, lib)}
      <main class="main">
        ${library(state, lib)}
        ${editor(state, lib)}
      </main>
      ${state.mode === 'edit' || state.mode === 'crop' ? panel(state) : nothing}
      ${dialog(state, lib)}
      ${progress(state)}
      ${state.toast
        ? html`
          <div class="toast" data-action="dismiss-toast" title="Click to close">
            ${state.toast.text}
          </div>
        `
        : nothing}
      ${state.draggingFiles
        ? html`
          <div class="drop-overlay">
            <i class="icon-image-plus"></i> Drop photos to import
          </div>
        `
        : nothing}
    </div>
  `
}

function progress(state: AppState) {
  const p = state.progress
  if (!p) return nothing

  const share = p.total ? p.done / p.total : 0
  const vars = { '--progress': String(share) }
  const count = p.total ? `${p.done} / ${p.total}` : p.done
  return html`
    <div class="progress">
      <span class="progress-label">${p.label} ${count}</span>
      ${p.total
        ? html`<span class="progress-bar" style=${styleMap(vars)}></span>`
        : nothing}
      <button class="button" data-action="cancel-progress">Cancel</button>
    </div>
  `
}
