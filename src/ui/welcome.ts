import { html, nothing } from 'lit-html'
import type { AppState } from '../state'

export function welcome(state: AppState) {
  const remembered = state.remembered

  return html`
    <section class="welcome">
      <h1 class="welcome-title"><i class="icon-images"></i> Photoloft</h1>
      <p class="welcome-text">
        Photoloft keeps your photos, albums and edits in one folder.
        Choose an empty folder, for example Pictures/Photoloft.
      </p>
      <div class="welcome-actions">
        ${remembered
          ? html`
            <button class="button primary" data-action="reopen-library">
              <i class="icon-folder-open"></i> Open ${remembered.name}
            </button>
            <button class="button" data-action="choose-library">
              Choose another folder
            </button>
          `
          : html`
            <button class="button primary" data-action="choose-library">
              <i class="icon-folder-open"></i> Choose library folder
            </button>
          `}
      </div>
      ${state.error
        ? html`<p class="welcome-error">${state.error}</p>`
        : nothing}
    </section>
  `
}
