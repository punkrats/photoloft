import { html, nothing } from 'lit-html'
import { classMap } from 'lit-html/directives/class-map.js'
import { live } from 'lit-html/directives/live.js'
import { formatShift, formatTaken } from '../format'
import { closeView, formatLocation, WORLD_VIEW } from '../geo'
import {
  albumsByName, retime, setMeta, viewPhotos, type Album, type Library,
  type MetaChange
} from '../library'
import type { Meta } from '../meta'
import {
  albumFileNames, previewNames, renamedNames, sanitizeName, splitExtension
} from '../naming'
import {
  targets, type AlbumPick, type AppState, type Dialog, type ExportForm,
  type InfoField, type InfoForm, type Picker
} from '../state'
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
  ['G', 'Add the selection or the open photo to an album'],
  ['R', 'Rename the selection or the open photo'],
  ['Enter / Esc', 'In a dialog: confirm / cancel'],
  ['Up / Down, Tab', 'In a dialog: next or previous field'],
  ['Space on a tick box', 'Tick or untick'],
  ['S', 'Star or unstar photos to keep'],
  ['I', 'Info: title, keywords, author, location'],
  ['Delete', 'Remove from album, or move to trash'],
  ['Space', 'Open the photo; Space again closes, or plays a video'],
  ['Enter or double-click', 'Edit photo'],
  ['Left / Right', 'Previous / next photo'],
  ['C', 'Crop and straighten'],
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
  if (d.kind === 'picker') return picker(state, lib, d)
  if (d.kind === 'export') return exportForm(lib, d.form)
  if (d.kind === 'help') return help()
  if (d.kind === 'date') return dateForm(lib, d)
  if (d.kind === 'info') return info(state, lib, d.form)
  if (d.kind === 'rename') return renameForm(lib, d)

  return html`
    <h3 class="dialog-title">${d.message}</h3>
    <div class="dialog-buttons">
      <button class="button" data-action="close-dialog">Cancel</button>
      <button class="button danger" data-action="confirm">${d.confirm}</button>
    </div>
  `
}

// ─── Album picker ────────────────────────────────────────────────────

// A row of the album picker. A held album holds every one of the
// photos, so it shows ticked and stays so.
export type PickerRow = {
  pick: AlbumPick
  name: string
  ticked: boolean
  held: boolean
}

// The albums whose names hold the typed text, A to Z, then the new
// albums ticked so far that match it, then the typed name as a new
// album when no row has it exactly.
export function pickerRows(lib: Library, d: Picker, ids: string[]) {
  const q = d.query.trim().toLowerCase()
  const matches = (name: string) => name.toLowerCase().includes(q)

  const rows: PickerRow[] = albumsByName(lib)
    .filter(a => matches(a.name))
    .map(a => {
      const photos = new Set(a.photos)
      const held = ids.every(id => photos.has(id))
      const ticked = held || d.ticked.some(p => 'id' in p && p.id === a.id)
      return { pick: { id: a.id }, name: a.name, ticked, held }
    })
  for (const pick of d.ticked) {
    if ('name' in pick && matches(pick.name)) {
      rows.push({ pick, name: pick.name, ticked: true, held: false })
    }
  }

  const name = d.query.trim()
  if (q && !rows.some(row => row.name.toLowerCase() === q)) {
    rows.push({ pick: { name }, name, ticked: false, held: false })
  }
  return rows
}

// The ticks after ticking or unticking the row at `index`, or null
// when it cannot change: a held album stays ticked.
export function toggledTicks(
  lib: Library, d: Picker, ids: string[], index: number
) {
  const row = pickerRows(lib, d, ids)[index]
  if (!row || row.held) return null
  if (!row.ticked) return [...d.ticked, row.pick]
  return d.ticked.filter(pick => pickKey(pick) !== pickKey(row.pick))
}

// What Enter and Add do: add to the ticked albums and to the typed name
// as a new album, or nothing when the typed name is an album's already
// (`taken` is that album's name). Held albums are never ticked.
export function pickerAdd(lib: Library, d: Picker) {
  const name = d.query.trim()
  const album = lib.albums
    .find(a => name && a.name.toLowerCase() === name.toLowerCase())
  if (album) return { picks: [], taken: album.name }

  const typed = { name }
  const known = d.ticked.some(pick => pickKey(pick) === pickKey(typed))
  const picks = !name || known ? d.ticked : [...d.ticked, typed]
  return { picks, taken: null }
}

// Albums are told apart by id, new ones by name with case ignored.
function pickKey(pick: AlbumPick) {
  return 'id' in pick ? `album:${pick.id}` : `new:${pick.name.toLowerCase()}`
}

// Each tick box carries its album's key, so focus stays on the album
// when a render shows the rows in another order.
function picker(state: AppState, lib: Library, d: Picker) {
  const ids = targets(state)
  const rows = pickerRows(lib, d, ids)
  const photos = `${ids.length} ${ids.length === 1 ? 'photo' : 'photos'}`

  return html`
    <h3 class="dialog-title">Add ${photos} to albums</h3>
    <input
      class="input"
      placeholder="Album name"
      data-input="picker"
      data-autofocus
      .value=${live(d.query)}
    >
    ${d.taken
      ? html`
        <p class="picker-hint danger">"${d.taken}" is already an album.</p>
      `
      : nothing}
    <div class="picker-list">
      ${rows.map((row, i) => html`
        <label class=${classMap({ 'picker-item': true, held: row.held })}>
          <span class="checkbox">
            <input
              type="checkbox"
              .checked=${live(row.ticked)}
              ?disabled=${row.held}
              data-action="pick-album"
              data-index=${i}
              data-focus-key=${pickKey(row.pick)}
            >
            ${'id' in row.pick
              ? html`<i class="icon-book-image"></i> ${row.name}`
              : html`<i class="icon-plus"></i> New album "${row.name}"`}
          </span>
        </label>
      `)}
      ${rows.length
        ? nothing
        : html`<p class="picker-hint">Type a name to create an album.</p>`}
    </div>
    <div class="dialog-buttons">
      <button class="button" data-action="close-dialog">Cancel</button>
      <button
        class="button primary"
        data-action="add-to-albums"
        ?disabled=${!pickerAdd(lib, d).picks.length}
      >
        Add
      </button>
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
          Remove camera locations
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

function numberField(
  field: string, value: number, unit: string, input = 'export-field'
) {
  return html`
    <input
      class="input input-number"
      type="number"
      min="1"
      .value=${live(String(value))}
      data-input=${input}
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

// ─── Rename ──────────────────────────────────────────────────────────

type RenameDialog = Extract<Dialog, { kind: 'rename' }>

const TOKENS: [string, string][] = [
  ['{number}', 'Number'],
  ['{date}', 'Date'],
  ['{time}', 'Time'],
  ['{name}', 'Original name']
]

// The field starts with the name of one photo; several get the open
// album's name and a number, or elsewhere keep their own names.
export function newRename(
  lib: Library, ids: string[], album: Album | null
): RenameDialog {
  const [stem] = splitExtension(lib.photos[ids[0]].name)
  const several = album ? `${album.name}-{number}` : '{name}'
  const pattern = ids.length === 1 ? stem : several
  return { kind: 'rename', ids, pattern, start: 1 }
}

// The names Rename gives the photos, in the dialog's order. Start at is
// read as the export reads it.
export function renameNames(lib: Library, d: RenameDialog) {
  const photos = d.ids.map(id => lib.photos[id])
  const start = Math.max(0, Math.round(d.start))
  return renamedNames(d.pattern, photos, start)
}

function renameForm(lib: Library, d: RenameDialog) {
  const n = d.ids.length
  const blank = !d.pattern.trim()
  const names = renameNames(lib, d)
  const { first, last } = previewNames(names)
  const preview = n > 1 ? `${first} to ${last}` : first

  return html`
    <h3 class="dialog-title">Rename ${n} ${n === 1 ? 'photo' : 'photos'}</h3>
    <div class="form">
      <label class="form-row">
        <span class="form-label">Name</span>
        <input
          class="input"
          .value=${live(d.pattern)}
          data-input="rename-field"
          data-field="pattern"
          data-autofocus
        >
      </label>
      <div class="form-row">
        <span class="form-label">Insert:</span>
        <div class="chips">
          ${TOKENS.map(([token, label]) => html`
            <button
              class="chip"
              data-action="rename-insert"
              data-token=${token}
            >
              ${label}
            </button>
          `)}
        </div>
      </div>
      ${d.pattern.includes('{number}')
        ? html`
          <label class="form-row">
            <span class="form-label">Start at</span>
            ${numberField('start', d.start, '', 'rename-field')}
          </label>
        `
        : nothing}
      ${blank ? nothing : html`<p class="form-note">${preview}</p>`}
    </div>
    <div class="dialog-buttons">
      <button class="button" data-action="close-dialog">Cancel</button>
      <button
        class="button primary"
        data-action="apply-rename"
        ?disabled=${blank}
      >
        Rename
      </button>
    </div>
  `
}

// ─── Info ────────────────────────────────────────────────────────────

const INFO_FIELDS: [InfoField, string][] = [
  ['title', 'Title'],
  ['description', 'Description'],
  ['keywords', 'Keywords'],
  ['author', 'Author'],
  ['copyright', 'Copyright']
]

// Each field as the dialog shows it: the text all the photos share
// (empty when none has a value), or null when they differ.
export function sharedText(lib: Library, ids: string[]) {
  const metas = ids.map(id => lib.photos[id]?.meta).filter(Boolean)
  const shared = {} as Record<InfoField, string | null>
  for (const [field] of INFO_FIELDS) {
    const values = new Set(metas.map(meta => metaText(meta, field)))
    shared[field] = values.size === 1 ? [...values][0] : null
  }
  return shared
}

function metaText(meta: Meta, field: InfoField) {
  if (field === 'keywords') return (meta.keywords ?? []).join(', ')
  return meta[field] ?? ''
}

// Fields start with the shared text; author and copyright fall back to
// the last ones set when no photo has one. The map starts at the first
// photo's added location; the camera's is looked up after opening.
export function newInfoForm(lib: Library, ids: string[]): InfoForm {
  const shared = sharedText(lib, ids)
  const text = {} as Record<InfoField, string>
  for (const [field] of INFO_FIELDS) text[field] = shared[field] ?? ''
  for (const field of ['author', 'copyright'] as const) {
    if (shared[field] === '') text[field] = lib.metaDefaults[field] ?? ''
  }

  const added = lib.photos[ids[0]]?.meta.location ?? null
  return {
    ids,
    text,
    pin: added,
    moved: false,
    view: added ? closeView(added) : WORLD_VIEW,
    query: '',
    places: [],
    note: null,
    searches: 0
  }
}

// What applying the dialog would do. A field showing several values
// keeps them while left empty, one showing the shared value keeps it
// while unchanged; anything else replaces, and emptied removes. The
// location changes only when the user placed or removed the pin.
export function infoChange(lib: Library, form: InfoForm) {
  const shared = sharedText(lib, form.ids)
  const change: MetaChange = {}
  for (const [field] of INFO_FIELDS) {
    const typed = form.text[field]
    const several = shared[field] === null
    if (several ? !typed.trim() : typed === shared[field]) continue

    if (field === 'keywords') change.keywords = { set: typed.split(',') }
    else change[field] = { set: typed }
  }
  if (form.moved) change.location = { set: form.pin }

  const changes = setMeta(lib, form.ids, change) !== lib
  return { shared, change, changes }
}

function info(state: AppState, lib: Library, form: InfoForm) {
  const c = infoChange(lib, form)
  const n = form.ids.length
  const count = `${n} ${n === 1 ? 'photo' : 'photos'}`

  return html`
    <h3 class="dialog-title">Info for ${count}</h3>
    <div class="form">
      ${INFO_FIELDS.map(([field, label]) => html`
        <label class="form-row">
          <span class="form-label">${label}</span>
          <input
            class="input"
            placeholder=${c.shared[field] === null ? 'Several values' : ''}
            .value=${live(form.text[field])}
            data-input="info-text"
            data-field=${field}
            ?data-autofocus=${field === 'title'}
          >
        </label>
        ${field === 'keywords'
          ? html`<p class="form-note">Separate keywords with commas</p>`
          : nothing}
      `)}
      ${location(state, form)}
    </div>
    <div class="dialog-buttons">
      <button class="button" data-action="close-dialog">Cancel</button>
      <button
        class="button primary"
        data-action="apply-info"
        ?disabled=${!c.changes}
      >
        Apply to ${count}
      </button>
    </div>
  `
}

// Enter in the search field submits its form, which clicks the search
// button.
function location(state: AppState, form: InfoForm) {
  return html`
    <div class="form-row">
      <span class="form-label">Location</span>
      <form class="place-search">
        <input
          class="input"
          placeholder="Search a place or paste coordinates"
          .value=${live(form.query)}
          data-input="info-query"
        >
        <button
          class="icon-button"
          type="submit"
          data-action="info-search"
          title="Search"
        >
          <i class="icon-search"></i>
        </button>
      </form>
    </div>
    <div class="form-indent">
      ${form.places.length ? places(form) : nothing}
      ${form.note ? html`<p class="form-hint">${form.note}</p>` : nothing}
      ${state.map?.element ?? nothing}
      ${state.map?.failed
        ? html`
          <p class="form-hint">
            The map could not load. Pasted coordinates still work.
          </p>
        `
        : nothing}
      ${pin(form)}
    </div>
  `
}

function places(form: InfoForm) {
  return html`
    <div class="picker-list">
      ${form.places.map((place, i) => html`
        <button class="picker-item" data-action="info-place" data-index=${i}>
          <i class="icon-map-pin"></i>
          <span class="place-name">${place.name}</span>
        </button>
      `)}
    </div>
  `
}

function pin(form: InfoForm) {
  if (!form.pin) {
    return html`
      ${form.moved ? html`<p class="place-at">No location</p>` : nothing}
      <p class="form-hint">Click the map to place a pin</p>
    `
  }

  return html`
    <p class="place-at">${formatLocation(form.pin)}</p>
    <p class="form-hint">Click the map to move the pin</p>
    <div>
      <button class="button" data-action="info-remove-location">
        <i class="icon-map-pin-off"></i> Remove location
      </button>
    </div>
  `
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
