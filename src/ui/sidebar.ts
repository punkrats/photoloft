import { html, nothing } from 'lit-html'
import { classMap } from 'lit-html/directives/class-map.js'
import { live } from 'lit-html/directives/live.js'
import { albumsByName, type Album, type Library, type View } from '../library'
import { counts as countsOf, isSaved, type AppState } from '../state'

export function sidebar(state: AppState, lib: Library) {
  const counts = countsOf(state, lib)

  return html`
    <aside class="sidebar">
      <header class="sidebar-head">
        <span class="sidebar-brand"><i class="icon-images"></i> Photoloft</span>
        <span class="sidebar-folder" data-saved=${isSaved(state)}>
          ${state.dirs?.root.name} - ${isSaved(state) ? 'Saved' : 'Saving'}
        </span>
      </header>
      <nav class="sidebar-nav">
        ${viewItem(state, { kind: 'all' }, 'icon-images', 'All photos',
          counts.all)}
        ${counts.import
          ? viewItem(state, { kind: 'import' }, 'icon-history', 'Last import',
            counts.import)
          : nothing}
        ${viewItem(state, { kind: 'unsorted' }, 'icon-inbox', 'Unsorted',
          counts.unsorted)}
        ${viewItem(state, { kind: 'starred' }, 'icon-star', 'Starred',
          counts.starred)}
        ${lib.albums.length
          ? viewItem(state, { kind: 'albums' }, 'icon-layers', 'In albums',
            counts.inAlbums)
          : nothing}
      </nav>
      <div class="sidebar-section">
        <span>Albums</span>
        ${lib.albums.length
          ? html`
            <button
              class="icon-button"
              data-action="export-all"
              title="Export all albums"
            >
              <i class="icon-download"></i>
            </button>
          `
          : nothing}
        <button
          class="icon-button"
          data-action="new-album"
          title="New album"
        >
          <i class="icon-plus"></i>
        </button>
      </div>
      <nav class="sidebar-nav sidebar-albums">
        ${albumsByName(lib).map(a => albumItem(state, a, counts.albums[a.id]))}
        ${lib.albums.length
          ? nothing
          : html`<p class="sidebar-hint">Select photos and press G</p>`}
      </nav>
      <nav class="sidebar-nav sidebar-bottom">
        ${viewItem(state, { kind: 'trash' }, 'icon-trash-2', 'Trash',
          counts.trash)}
      </nav>
    </aside>
  `
}

function viewItem(
  state: AppState, view: View, icon: string, label: string, count: number
) {
  const active = state.view.kind === view.kind

  return html`
    <button
      class=${classMap({ 'nav-item': true, active })}
      data-action="view"
      data-kind=${view.kind}
    >
      <i class=${icon}></i>
      <span class="nav-label">${label}</span>
      <span class="nav-count">${count || nothing}</span>
    </button>
  `
}

function albumItem(state: AppState, album: Album, count: number) {
  const view = state.view
  const active = view.kind === 'album' && view.id === album.id
  const renaming = state.renaming?.kind === 'album' &&
    state.renaming.id === album.id
  const over = state.dropAlbum === album.id

  if (renaming) {
    return html`
      <div class="nav-item active">
        <i class="icon-book-image"></i>
        <input
          class="rename-input"
          data-rename="album"
          data-id=${album.id}
          .value=${live(album.name)}
        >
      </div>
    `
  }

  return html`
    <button
      class=${classMap({ 'nav-item': true, active, 'drop-over': over })}
      data-action="view"
      data-kind="album"
      data-id=${album.id}
      data-dblclick="rename-album"
      data-drop-album=${album.id}
      title="Double-click to rename"
    >
      <i class="icon-book-image"></i>
      <span class="nav-label">${album.name}</span>
      <span class="nav-count">${count || nothing}</span>
    </button>
  `
}
