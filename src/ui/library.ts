import { html, nothing } from 'lit-html'
import { classMap } from 'lit-html/directives/class-map.js'
import { live } from 'lit-html/directives/live.js'
import { repeat } from 'lit-html/directives/repeat.js'
import { styleMap } from 'lit-html/directives/style-map.js'
import { formatBytes, formatDuration, formatTaken } from '../format'
import {
  cellRect, GAP, gridLayout, HEADER, PAD, type Row, type Section
} from '../grid-layout'
import type { Album, AlbumSort, Library, Photo } from '../library'
import { isEdited } from '../schema'
import {
  currentAlbum, viewIds, viewSections, type AppState
} from '../state'

const SORTS: [AlbumSort, string][] = [
  ['date', 'Date taken'],
  ['name', 'Name'],
  ['size', 'File size']
]
const CUSTOM: [AlbumSort, string] = ['custom', 'Custom order']

const TITLES = {
  all: 'All photos',
  import: 'Last import',
  unsorted: 'Unsorted',
  starred: 'Starred',
  albums: 'In albums',
  trash: 'Trash'
}

export function library(state: AppState, lib: Library) {
  const ids = viewIds(state)
  const album = currentAlbum(state)

  return html`
    <section class="library">
      ${toolbar(state, ids, album)}
      ${selectionBar(state, album)}
      <div class="grid" data-grid>
        ${ids.length ? grid(state, lib, ids) : empty(state, lib)}
      </div>
      <input
        type="file"
        id="import-files"
        accept="image/jpeg,.jpg,.jpeg"
        multiple
        hidden
        data-change="import-input"
      >
    </section>
  `
}

// ─── Toolbar ─────────────────────────────────────────────────────────

function toolbar(state: AppState, ids: string[], album: Album | null) {
  const count = `${ids.length} ${ids.length === 1 ? 'photo' : 'photos'}`

  return html`
    <header class="toolbar">
      <div class="toolbar-title">
        ${title(state, album)}
        <span class="toolbar-count">${count}</span>
      </div>
      <div class="toolbar-actions">
        ${state.view.kind === 'albums' ? nothing : sortControl(state, album)}
        ${album ? albumActions() : viewActions(state)}
        <span class="toolbar-gap"></span>
        ${importButtons()}
        ${historyButtons(state)}
        <button
          class="icon-button"
          data-action="help"
          title="Keyboard shortcuts (?)"
        >
          <i class="icon-keyboard"></i>
        </button>
      </div>
    </header>
  `
}

function title(state: AppState, album: Album | null) {
  if (!album) {
    const kind = state.view.kind as keyof typeof TITLES
    return html`<h2 class="toolbar-heading">${TITLES[kind]}</h2>`
  }

  const renaming = state.renaming?.kind === 'album' &&
    state.renaming.id === album.id
  if (renaming) {
    return html`
      <input
        class="rename-input toolbar-heading"
        data-rename="album"
        data-id=${album.id}
        .value=${live(album.name)}
      >
    `
  }

  return html`
    <h2
      class="toolbar-heading"
      data-dblclick="rename-album"
      data-id=${album.id}
      title="Double-click to rename"
    >
      ${album.name}
    </h2>
  `
}

// One control for every view. Albums also offer their custom order
// (drag to reorder) and remember their choice.
function sortControl(state: AppState, album: Album | null) {
  const current = album ? album.sort ?? 'custom' : state.sort
  const options = album ? [...SORTS, CUSTOM] : SORTS

  return html`
    <label class="select" title="Sort">
      <i class="icon-arrow-down-a-z"></i>
      <select data-change="sort">
        ${options.map(([value, label]) => html`
          <option value=${value} ?selected=${current === value}>
            ${label}
          </option>
        `)}
      </select>
    </label>
  `
}

function albumActions() {
  return html`
    <button class="button primary" data-action="export-album">
      <i class="icon-download"></i> Export
    </button>
    <button class="icon-button" data-action="delete-album" title="Delete album">
      <i class="icon-trash"></i>
    </button>
  `
}

function viewActions(state: AppState) {
  if (state.view.kind === 'import') {
    return html`
      <button class="button" data-action="trash-unalbumed">
        <i class="icon-trash-2"></i> Trash photos not in an album
      </button>
    `
  }
  if (state.view.kind === 'trash') {
    return html`
      <button class="button danger" data-action="empty-trash">
        <i class="icon-trash-2"></i> Empty trash
      </button>
    `
  }

  return nothing
}

function importButtons(main = false) {
  return html`
    <button
      class=${classMap({ button: true, primary: main })}
      data-action="import-folder"
      title="Import a folder with all its subfolders"
    >
      <i class="icon-folder-plus"></i>
      <span class="button-label">Import folder</span>
    </button>
    <button
      class="button"
      data-action="import-files"
      title="Import single photos"
    >
      <i class="icon-image-plus"></i>
      <span class="button-label">Import photos</span>
    </button>
  `
}

export function historyButtons(state: AppState) {
  return html`
    <button
      class="icon-button"
      data-action="undo"
      title="Undo (Ctrl+Z)"
      ?disabled=${state.history.past.length === 0}
    >
      <i class="icon-undo-2"></i>
    </button>
    <button
      class="icon-button"
      data-action="redo"
      title="Redo (Ctrl+Shift+Z)"
      ?disabled=${state.history.future.length === 0}
    >
      <i class="icon-redo-2"></i>
    </button>
  `
}

// ─── Selection ───────────────────────────────────────────────────────

function selectionBar(state: AppState, album: Album | null) {
  const count = state.selection.size
  if (count === 0) return nothing

  const trash = state.view.kind === 'trash'
  const photos = state.library!.photos
  const allStarred = [...state.selection].every(id => photos[id]?.starred)
  return html`
    <div class="selection-bar">
      <span class="selection-count">${count} selected</span>
      ${trash ? trashActions() : html`
        <button class="button primary" data-action="open-picker">
          <i class="icon-book-image"></i> Add to album
          <kbd>G</kbd>
        </button>
        <button class="button" data-action="star">
          <i class="icon-star"></i> ${allStarred ? 'Unstar' : 'Star'}
          <kbd>S</kbd>
        </button>
        <button class="button" data-action="auto-selection">
          <i class="icon-wand-sparkles"></i> Auto
        </button>
        <button class="button" data-action="open-date">
          <i class="icon-calendar-clock"></i> Adjust date
        </button>
        <button
          class="button"
          data-action="paste-settings"
          ?disabled=${!state.clipboard}
        >
          <i class="icon-clipboard-paste"></i> Paste settings
        </button>
        ${state.view.kind === 'albums' ? nothing : html`
          <button class="button" data-action="remove-selection">
            <i class=${album ? 'icon-x' : 'icon-trash-2'}></i>
            ${album ? 'Remove from album' : 'Move to trash'}
          </button>
        `}
      `}
      <span class="toolbar-gap"></span>
      <button class="button" data-action="select-all">Select all</button>
      <button class="button" data-action="clear-selection">Clear</button>
    </div>
  `
}

function trashActions() {
  return html`
    <button class="button primary" data-action="restore-selection">
      <i class="icon-archive-restore"></i> Restore
    </button>
  `
}

// ─── Grid ────────────────────────────────────────────────────────────

function grid(state: AppState, lib: Library, ids: string[]) {
  const album = currentAlbum(state)
  const sort = album
    ? album.sort ?? 'custom'
    : state.view.kind === 'albums' ? 'custom' : state.sort
  const sections = viewSections(state)
  const { width, height, scroll } = state.grid
  const g = gridLayout(width, height, scroll, sections)
  const vars = {
    '--cols': String(g.cols),
    '--cell': `${g.cell}px`,
    '--gap': `${GAP}px`,
    '--pad': `${PAD}px`,
    '--header': `${HEADER}px`,
    '--total': `${g.total}px`
  }
  const key = (row: Row) =>
    row.header ? `h:${sections[row.section].key}` : `r:${row.first}`

  return html`
    <div class="grid-inner" style=${styleMap(vars)}>
      ${repeat(g.visible, key, row => row.header
        ? sectionHeader(sections[row.section], row)
        : cellRow(state, lib, ids.slice(row.first, row.last), row, sort))}
      ${marquee(state)}
      ${dropMarker(state, g)}
    </div>
  `
}

function sectionHeader(section: Section, row: Row) {
  return html`
    <button
      class="grid-header"
      style=${styleMap({ '--y': `${row.y}px` })}
      data-action="view"
      data-kind="album"
      data-id=${section.key}
    >
      ${section.title}
      <span class="toolbar-count">${section.count}</span>
    </button>
  `
}

function cellRow(
  state: AppState, lib: Library, ids: string[], row: Row, sort: AlbumSort
) {
  return html`
    <div class="grid-row" style=${styleMap({ '--y': `${row.y}px` })}>
      ${repeat(ids, (id, i) => `${row.first + i}:${id}`, (id, i) => {
        return cell(state, lib, id, row.first + i, sort)
      })}
    </div>
  `
}

function cell(
  state: AppState, lib: Library, id: string, index: number, sort: AlbumSort
) {
  const photo = lib.photos[id]
  const selected = state.selection.has(id)
  const url = state.thumbs.get(id)
  const detail = sortDetail(lib.photos[id], sort)
  const classes = {
    cell: true,
    selected,
    current: state.current === id,
    edited: isEdited(photo.edit),
    starred: photo.starred
  }

  return html`
    <figure
      class=${classMap(classes)}
      data-action="select"
      data-dblclick="open"
      data-id=${id}
      data-index=${index}
      draggable="true"
    >
      ${url
        ? html`<img class="cell-image" src=${url} alt="" draggable="false">`
        : html`<span class="cell-placeholder"></span>`}
      <button
        class="cell-check"
        data-action="toggle"
        data-id=${id}
        data-index=${index}
        title="Select"
      >
        <i class=${selected ? 'icon-circle-check' : 'icon-circle'}></i>
      </button>
      <span class="cell-marks">
        ${photo.video
          ? html`
            <span class="cell-video" title="Video">
              <i class="icon-play"></i> ${formatDuration(photo.video.duration)}
            </span>
          `
          : nothing}
        <span class="cell-badge" title="Edited">
          <i class="icon-sliders-horizontal"></i>
        </span>
        <button
          class="cell-star"
          data-action="star-one"
          data-id=${id}
          title="Star to keep (S)"
        >
          <i class="icon-star"></i>
        </button>
      </span>
      <figcaption class="cell-name">
        ${detail ? html`<span class="cell-detail">${detail}</span>` : nothing}
        <span class="cell-file">${photo.name}</span>
      </figcaption>
    </figure>
  `
}

// The value the view is sorted by, shown on hover.
function sortDetail(photo: Photo, sort: AlbumSort) {
  if (sort === 'size') return formatBytes(photo.bytes)
  if (sort === 'date') return formatTaken(photo.takenAt)
  return null
}

function marquee(state: AppState) {
  const m = state.marquee
  if (!m) return nothing

  const vars = {
    '--x': `${Math.min(m.start.x, m.end.x)}px`,
    '--y': `${Math.min(m.start.y, m.end.y)}px`,
    '--w': `${Math.abs(m.end.x - m.start.x)}px`,
    '--h': `${Math.abs(m.end.y - m.start.y)}px`
  }
  return html`<div class="marquee" style=${styleMap(vars)}></div>`
}

function dropMarker(state: AppState, g: ReturnType<typeof gridLayout>) {
  if (state.dropIndex === null) return nothing

  const atEnd = state.dropIndex > 0 && state.dropIndex % g.cols === 0
  const rect = cellRect(g, atEnd ? state.dropIndex - 1 : state.dropIndex)
  const x = atEnd ? rect.x + rect.w + GAP / 2 : rect.x - GAP / 2
  const vars = { '--x': `${x}px`, '--y': `${rect.y}px`, '--h': `${rect.h}px` }
  return html`<div class="drop-marker" style=${styleMap(vars)}></div>`
}

function empty(state: AppState, lib: Library) {
  const nothingYet = Object.keys(lib.photos).length === 0
  const text = {
    all: 'No photos yet. Import a folder (subfolders included) or drop ' +
      'photos and folders here.',
    unsorted: 'Every photo is in an album.',
    import: 'Nothing left from the last import.',
    albums: 'No albums yet. Select photos and press G to make one.',
    starred: 'No starred photos. Press S or click the star on a photo ' +
      'to mark it as a keeper.',
    trash: 'Trash is empty.',
    album: 'This album is empty. Select photos in All photos and press G, ' +
      'or drag them onto the album in the sidebar.'
  }[state.view.kind]

  return html`
    <div class="grid-empty">
      <i class=${nothingYet ? 'icon-image-plus' : 'icon-images'}></i>
      <p>${text}</p>
      ${nothingYet
        ? html`<div class="grid-empty-actions">${importButtons(true)}</div>`
        : nothing}
    </div>
  `
}
