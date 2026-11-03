import { html, nothing } from 'lit-html'
import { classMap } from 'lit-html/directives/class-map.js'
import { live } from 'lit-html/directives/live.js'
import { albumsByName, retime, viewPhotos, type Library } from '../library'
import { formatShift, formatTaken } from '../format'
import { albumFileNames, sanitizeName } from '../naming'
import type { AppState, Dialog, ExportForm } from '../state'
import { realTaken, takenDifference } from '../taken'

export const SIZES: [string, string][] = [
  ['original', 'Original size'],
  ['3840', 'Long edge 3840 px'],
  ['2560', 'Long edge 2560 px'],
  ['2048', 'Long edge 2048 px'],
  ['1600', 'Long edge 1600 px'],
  ['1080', 'Long edge 1080 px'],
  ['custom', 'Custom']
]

const VIDEO_SIDES: [string, string][] = [
  ['720', '720p'],
  ['1080', '1080p'],
  ['0', 'Original size']
]

export const LIMITS: [string, string][] = [
  ['none', 'No limit'],
  ['500000', '500 KB'],
  ['1000000', '1 MB'],
  ['2000000', '2 MB'],
  ['5000000', '5 MB'],
  ['custom', 'Custom']
]

const SHORTCUTS: [string, string][] = [
  ['Click / Ctrl+click / Shift+click', 'Select one / toggle / range'],
  ['Drag on empty space', 'Select with a rectangle'],
  ['Ctrl+A, Esc', 'Select all, clear selection'],
  ['G', 'Add selection to an album'],
  ['S', 'Star or unstar photos to keep'],
  ['Delete', 'Remove from album, or move to trash'],
  ['Space', 'Show the photo large; Space again closes'],
  ['Enter or double-click', 'Edit photo'],
  ['Left / Right', 'Previous / next photo'],
  ['R', 'Crop and straighten'],
  ['\\', 'Before and after'],
  ['Z', 'Zoom to 100 %'],
  ['Ctrl+Shift+C / V', 'Copy / paste settings'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['Esc', 'Back to the grid']
]

export function dialog(state: AppState, lib: Library) {
  const d = state.dialog
  if (!d) return nothing

  return html`
    <div class="dialog-backdrop" data-action="close-dialog">
      <div class="dialog" data-dialog>${body(state, lib, d)}</div>
    </div>
  `
}

function body(state: AppState, lib: Library, d: Dialog) {
  if (d.kind === 'picker') return picker(state, lib, d.query, d.index)
  if (d.kind === 'export') return exportForm(lib, d.form)
  if (d.kind === 'help') return help()
  if (d.kind === 'date') return dateForm(lib, d)

  return html`
    <h3 class="dialog-title">${d.message}</h3>
    <div class="dialog-buttons">
      <button class="button" data-action="close-dialog">Cancel</button>
      <button class="button danger" data-action="confirm">${d.confirm}</button>
    </div>
  `
}

// ─── Album picker ────────────────────────────────────────────────────

export function pickerOptions(lib: Library, query: string) {
  const q = query.trim().toLowerCase()
  const albums = albumsByName(lib).filter(a => a.name.toLowerCase().includes(q))
  const exact = albums.some(a => a.name.toLowerCase() === q)
  return { albums, create: q && !exact ? query.trim() : null }
}

function picker(state: AppState, lib: Library, query: string, index: number) {
  const { albums, create } = pickerOptions(lib, query)
  const count = state.selection.size

  return html`
    <h3 class="dialog-title">
      Add ${count} ${count === 1 ? 'photo' : 'photos'} to album
    </h3>
    <input
      class="input"
      placeholder="Album name"
      data-input="picker"
      data-autofocus
      .value=${live(query)}
    >
    <div class="picker-list">
      ${albums.map((a, i) => html`
        <button
          class=${classMap({ 'picker-item': true, on: i === index })}
          data-action="pick-album"
          data-id=${a.id}
        >
          <i class="icon-book-image"></i> ${a.name}
        </button>
      `)}
      ${create
        ? html`
          <button
            class=${classMap({
              'picker-item': true, on: index === albums.length
            })}
            data-action="pick-new"
          >
            <i class="icon-plus"></i> New album "${create}"
          </button>
        `
        : nothing}
      ${!albums.length && !create
        ? html`<p class="picker-hint">Type a name to create an album.</p>`
        : nothing}
    </div>
  `
}

// ─── Export ──────────────────────────────────────────────────────────

function exportForm(lib: Library, form: ExportForm) {
  const albums = form.albumIds
    .map(id => lib.albums.find(a => a.id === id))
    .filter(a => a !== undefined)
  const single = albums.length === 1 ? albums[0] : null
  const heading = single
    ? `Export "${single.name}"`
    : `Export ${albums.length} albums`
  const folder = single
    ? `Exports/${sanitizeName(single.name)}/`
    : 'Exports/<album>/'

  return html`
    <h3 class="dialog-title">${heading}</h3>
    <div class="form">
      <div class="form-row">
        <span class="form-label">File names</span>
        <div class="segmented">
          ${segment(form.naming === 'album', 'album', 'Album name and number')}
          ${segment(form.naming === 'original', 'original', 'Photo names')}
        </div>
      </div>
      ${form.naming === 'album' ? naming(form, single, lib) : nothing}
      <label class="form-row">
        <span class="form-label">Size</span>
        <select data-change="export-field" data-field="size">
          ${SIZES.map(([value, label]) => html`
            <option value=${value} ?selected=${form.size === value}>
              ${label}
            </option>
          `)}
        </select>
        ${form.size === 'custom'
          ? numberField('customSize', form.customSize, 'px long edge')
          : nothing}
      </label>
      <label class="form-row">
        <span class="form-label">File size limit</span>
        <select data-change="export-field" data-field="limit">
          ${LIMITS.map(([value, label]) => html`
            <option value=${value} ?selected=${form.limit === value}>
              ${label}
            </option>
          `)}
        </select>
        ${form.limit === 'custom'
          ? numberField('customLimit', form.customLimit, 'MB per file')
          : nothing}
      </label>
      <label class="form-row">
        <span class="form-label">Quality</span>
        <input
          type="range"
          min="60"
          max="100"
          step="1"
          .value=${live(String(form.quality))}
          data-input="export-field"
          data-field="quality"
        >
        <output class="form-value">${form.quality}</output>
      </label>
      <label class="form-row">
        <span class="form-label">Location</span>
        <span class="checkbox">
          <input
            type="checkbox"
            .checked=${live(form.stripGps)}
            data-change="export-field"
            data-field="stripGps"
          >
          Remove GPS location
        </span>
      </label>
      ${hasVideos(lib, albums.map(a => a.id))
        ? html`
          <label class="form-row">
            <span class="form-label">Videos</span>
            <select data-change="export-field" data-field="videoSide">
              ${VIDEO_SIDES.map(([value, label]) => html`
                <option value=${value} ?selected=${form.videoSide === value}>
                  ${label}
                </option>
              `)}
            </select>
          </label>
          <p class="form-note">
            Size, file size limit and quality apply to photos.
          </p>
        `
        : nothing}
      <p class="form-note">Saved to ${folder} in your library folder.</p>
    </div>
    <div class="dialog-buttons">
      <button class="button" data-action="close-dialog">Cancel</button>
      <button class="button primary" data-action="run-export">
        <i class="icon-download"></i> Export
      </button>
    </div>
  `
}

function naming(form: ExportForm, single: { id: string } | null, lib: Library) {
  const view = { kind: 'album' as const, id: single?.id ?? '' }
  const count = Math.max(1, viewPhotos(lib, view, 'date').length)
  const names = albumFileNames(form.name || 'Album', count, form.start)
  const preview = count > 1 ? `${names[0]} to ${names.at(-1)}` : names[0]

  return html`
    ${single
      ? html`
        <label class="form-row">
          <span class="form-label">Name</span>
          <input
            class="input"
            .value=${live(form.name)}
            data-input="export-field"
            data-field="name"
          >
        </label>
      `
      : nothing}
    <label class="form-row">
      <span class="form-label">Start at</span>
      ${numberField('start', form.start, '')}
    </label>
    ${single ? html`<p class="form-note">${preview}</p>` : nothing}
  `
}

function hasVideos(lib: Library, albumIds: string[]) {
  return albumIds.some(id => {
    const ids = viewPhotos(lib, { kind: 'album', id }, 'date')
    return ids.some(photo => lib.photos[photo].video)
  })
}

function segment(on: boolean, value: string, label: string) {
  return html`
    <button
      class=${classMap({ chip: true, on })}
      data-action="export-naming"
      data-value=${value}
    >
      ${label}
    </button>
  `
}

function numberField(field: string, value: number, unit: string) {
  return html`
    <input
      class="input input-number"
      type="number"
      min="1"
      .value=${live(String(value))}
      data-input="export-field"
      data-field=${field}
    >
    ${unit ? html`<span class="form-unit">${unit}</span>` : nothing}
  `
}

// ─── Capture time ────────────────────────────────────────────────────

type DateDialog = Extract<Dialog, { kind: 'date' }>

// What applying the dialog would do.
export function dateChange(lib: Library, d: DateDialog) {
  const to = realTaken(d.value.length === 16 ? `${d.value}:00` : d.value)
  const from = lib.photos[d.reference].takenAt
  const dated = d.ids.filter(id => lib.photos[id]?.takenAt).length
  const undated = d.ids.length - dated
  const gap = to && from ? takenDifference(from, to) : null
  const result = to ? retime(lib, d.ids, d.reference, to) : null
  const times = d.ids
    .map(id => result?.photos[id]?.takenAt)
    .filter((t): t is string => Boolean(t))
    .sort()
  const changes = to !== null && (gap !== 0 || undated > 0)
  return { to, from, gap, dated, undated, times, changes }
}

function dateForm(lib: Library, d: DateDialog) {
  const c = dateChange(lib, d)
  const name = lib.photos[d.reference].name
  const intro = c.from
    ? `says it was taken ${formatTaken(c.from, undefined, true)}. ` +
      'Enter when it was really taken.'
    : 'has no date. Enter when it was taken.'
  const notes = dateNotes(c)

  return html`
    <h3 class="dialog-title">Adjust date and time</h3>
    <p class="dialog-text"><strong>${name}</strong> ${intro}</p>
    <label class="form-row">
      <span class="form-label">Taken at</span>
      <input
        class="input"
        type="datetime-local"
        step="1"
        .value=${live(d.value)}
        data-input="date-value"
        data-autofocus
      >
    </label>
    ${notes.map(note => html`<p class="form-note">${note}</p>`)}
    <div class="dialog-buttons">
      <button class="button" data-action="close-dialog">Cancel</button>
      <button
        class="button primary"
        data-action="apply-date"
        ?disabled=${!c.changes}
      >
        Apply
      </button>
    </div>
  `
}

function dateNotes(c: ReturnType<typeof dateChange>) {
  if (!c.to) return ['Enter a date and time.']

  const notes: string[] = []
  const others = c.dated - (c.from ? 1 : 0)
  if (c.from && others) {
    const who = others === 1 ? 'The other photo with a date moves' :
      `The other ${others} with a date move`
    notes.push(`${who} by the same amount (${formatShift(c.gap!)}).`)
  }
  if (!c.from && c.dated) notes.push(`${c.dated} with a date keep theirs.`)

  const spaced = c.undated - (c.from ? 0 : 1)
  if (spaced > 0 && c.from) {
    notes.push(`${spaced} without a date get times one second apart, ` +
      'in the order shown.')
  }
  if (spaced > 0 && !c.from) {
    const follow = spaced === 1 ? '1 more follows' : `${spaced} more follow`
    notes.push(`${follow} one second apart, in the order shown.`)
  }
  if (c.times.length > 1) {
    const first = formatTaken(c.times[0], undefined, true)
    const last = formatTaken(c.times.at(-1)!, undefined, true)
    notes.push(`Earliest ${first}, latest ${last}.`)
  }
  return notes
}

// ─── Help ────────────────────────────────────────────────────────────

function help() {
  return html`
    <h3 class="dialog-title">Keyboard shortcuts</h3>
    <dl class="shortcuts">
      ${SHORTCUTS.map(([keys, what]) => html`<dt>${keys}</dt><dd>${what}</dd>`)}
    </dl>
    <div class="dialog-buttons">
      <button class="button primary" data-action="close-dialog">Close</button>
    </div>
  `
}
