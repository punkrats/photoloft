import { html, nothing } from 'lit-html'
import { classMap } from 'lit-html/directives/class-map.js'
import { repeat } from 'lit-html/directives/repeat.js'
import { thumbUrl } from '../drives'
import { formatBytes } from '../format'
import type { AppState, DriveBrowser, DriveFile, Drives } from '../state'
import { historyButtons } from './library'

// The folder shown on a drive: its subfolders, which open on a click,
// and its photos and videos, which select like the grid's cells and
// show whether the library holds them.
export function driveBrowser(state: AppState) {
  const { browser, drives, view } = state
  if (!browser || !drives || view.kind !== 'drive') return nothing

  return html`
    <section class="library">
      ${toolbar(state, view.id, browser)}
      ${selectionBar(state, browser)}
      <div class="drive-grid">${contents(drives, view.id, browser)}</div>
    </section>
  `
}

function toolbar(state: AppState, drive: string, browser: DriveBrowser) {
  const n = browser.listing?.files.length ?? 0
  const count = browser.listing ? `${n} ${n === 1 ? 'photo' : 'photos'}` : ''

  return html`
    <header class="toolbar">
      <div class="toolbar-title">
        <nav class="drive-crumbs">${crumbs(drive, browser.path)}</nav>
        <span class="toolbar-count">${count}</span>
      </div>
      <div class="toolbar-actions">
        <button
          class="button primary"
          data-action="drive-import-folder"
          title="Import this folder with all its subfolders"
          ?disabled=${state.progress !== null || !browser.listing}
        >
          <i class="icon-folder-plus"></i> Import folder
        </button>
        <span class="toolbar-gap"></span>
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

// The drive and each folder on the way to the one shown.
function crumbs(drive: string, path: string[]) {
  return [drive, ...path].map((name, i) => html`
    ${i ? html`<i class="icon-chevron-right"></i>` : nothing}
    <button
      class="drive-crumb"
      data-action="drive-folder"
      data-path=${path.slice(0, i).join('/')}
    >
      ${name}
    </button>
  `)
}

function selectionBar(state: AppState, browser: DriveBrowser) {
  const count = browser.selection.size
  if (count === 0) return nothing

  return html`
    <div class="selection-bar">
      <span class="selection-count">${count} selected</span>
      <button
        class="button primary"
        data-action="drive-import"
        ?disabled=${state.progress !== null}
      >
        <i class="icon-image-plus"></i> Import
      </button>
      <span class="toolbar-gap"></span>
      <button class="button" data-action="drive-select-all">Select all</button>
      <button class="button" data-action="drive-clear">Clear</button>
    </div>
  `
}

function contents(drives: Drives, drive: string, browser: DriveBrowser) {
  if (browser.error) {
    const text = `Could not read this folder: ${browser.error}`
    return note('icon-hard-drive', text)
  }
  if (!browser.listing) {
    return note('icon-loader-circle', 'Reading the drive…')
  }

  const { folders, files } = browser.listing
  if (!folders.length && !files.length) {
    return note('icon-folder', 'No photos, videos or folders here.')
  }
  return html`
    ${folders.map(name => folderTile(browser, name))}
    ${repeat(files, f => f.path, f => fileTile(drives, drive, browser, f))}
  `
}

function folderTile(browser: DriveBrowser, name: string) {
  return html`
    <button
      class="drive-tile drive-folder"
      data-action="drive-folder"
      data-path=${[...browser.path, name].join('/')}
    >
      <span class="drive-thumb"><i class="icon-folder"></i></span>
      <span class="drive-name">${name}</span>
    </button>
  `
}

function fileTile(
  drives: Drives, drive: string, browser: DriveBrowser, file: DriveFile
) {
  const selected = browser.selection.has(file.path)
  const held = browser.held.has(file.path)
  const classes = { 'drive-tile': true, 'drive-file': true, selected, held }

  return html`
    <button
      class=${classMap(classes)}
      data-action="drive-pick"
      data-path=${file.path}
      title=${`${file.name}, ${formatBytes(file.size)}`}
    >
      <span class="drive-thumb">
        <img loading="lazy" alt="" src=${thumbUrl(drives, drive, file.path)}>
      </span>
      <span class="drive-name">${file.name}</span>
      ${held
        ? html`<i class="icon-circle-check drive-held" title="Imported"></i>`
        : nothing}
    </button>
  `
}

function note(icon: string, text: string) {
  return html`
    <div class="grid-empty drive-note">
      <i class=${icon}></i>
      <p>${text}</p>
    </div>
  `
}
