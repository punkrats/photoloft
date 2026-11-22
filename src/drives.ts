import { heldSources, importFound, type Source } from './importer'
import { render } from './render'
import { serviceToken } from './service'
import {
  clickSelection, showToast, type AppState, type DriveBrowser,
  type DriveFile, type Drives, type Listing
} from './state'

type Walk = { files: DriveFile[], skipped: number }

const POLL_MS = 2000
const COLLATOR = new Intl.Collator(undefined, {
  numeric: true, sensitivity: 'base'
})

// Asks the Photoloft service for the drives connected every POLL_MS for
// as long as the page runs, with a new token after a restart of the
// service. Without the service there are no drives.
export async function watchDrives(state: AppState) {
  let token = await serviceToken()
  if (!token) return

  for (;;) {
    const names = await driveNames(token)
    if (names) updateDrives(state, { token, names })
    else token = (await serviceToken()) ?? token
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

async function driveNames(token: string) {
  const init = { headers: tokenHeader(token) }
  const response = await fetch('/api/drives', init).catch(() => null)
  if (!response?.ok) return null
  return (await response.json()).drives as string[]
}

// A drive pulled out while shown takes its view back to All photos.
function updateDrives(state: AppState, drives: Drives) {
  const before = state.drives
  const same = before?.token === drives.token &&
    before.names.join('/') === drives.names.join('/')
  if (same) return

  state.drives = drives
  const view = state.view
  if (view.kind === 'drive' && !drives.names.includes(view.id)) {
    state.view = { kind: 'all' }
    state.browser = null
    showToast(state, `${view.id} was disconnected.`)
  }
  render(state)
}

// Shows the folder at `path` on the drive and reads what it holds.
export async function openDrive(
  state: AppState, drive: string, path: string[]
) {
  const drives = state.drives
  if (!drives) return

  const browser: DriveBrowser = {
    path,
    listing: null,
    error: null,
    selection: new Set(),
    anchor: null,
    held: new Set(),
    checked: null
  }
  state.view = { kind: 'drive', id: drive }
  state.browser = browser
  state.selection = new Set()
  state.mode = 'grid'
  render(state)

  try {
    const query = path.join('/')
    const listing = await ask<Listing>(drives.token, 'list', drive, query)
    listing.folders.sort(COLLATOR.compare)
    listing.files.sort((a, b) => COLLATOR.compare(a.name, b.name))
    browser.listing = listing
  } catch (error) {
    browser.error = String(error)
  }
  render(state)
}

// Finds the files shown that the library holds, again whenever the
// library changed since, once no import or export runs.
export function checkHeld(state: AppState) {
  const { browser, drives, library, view } = state
  if (!browser?.listing || !drives || !library || state.progress) return
  if (view.kind !== 'drive' || browser.checked === library) return

  browser.checked = library
  const files = browser.listing.files
  const sources = files.map(f => driveSource(drives.token, view.id, f))
  void heldSources(state, sources).then(held => {
    if (browser.checked !== library) return
    browser.held = new Set(files.filter((_, i) => held[i]).map(f => f.path))
    render(state)
  })
}

// A click on a file selects it the way a click on a grid cell does.
export function pickFile(state: AppState, path: string, event: MouseEvent) {
  const browser = state.browser
  if (!browser?.listing) return

  const paths = browser.listing.files.map(f => f.path)
  const { selection, anchor } = browser
  Object.assign(browser, clickSelection(paths, selection, anchor, path, event))
}

export function selectAllFiles(state: AppState) {
  const browser = state.browser
  if (!browser?.listing) return
  browser.selection = new Set(browser.listing.files.map(f => f.path))
}

export function importPicked(state: AppState) {
  const { browser, drives, view } = state
  if (!browser?.listing || !drives || view.kind !== 'drive') return

  const files = browser.listing.files.filter(f => browser.selection.has(f.path))
  if (!files.length) return
  browser.selection = new Set()
  const sources = files.map(f => driveSource(drives.token, view.id, f))
  void importFound(state, async () => ({ sources, skipped: 0 }))
}

// Imports the folder shown with all its subfolders.
export function importDriveFolder(state: AppState) {
  const { browser, drives, view } = state
  if (!browser || !drives || view.kind !== 'drive') return

  const path = browser.path.join('/')
  void importFound(state, async () => {
    const found = await ask<Walk>(drives.token, 'walk', view.id, path)
    const sources = found.files.map(f => driveSource(drives.token, view.id, f))
    return { sources, skipped: found.skipped }
  })
}

// An image's address carries the token, as an image sends no headers.
export function thumbUrl(drives: Drives, drive: string, path: string) {
  const query = new URLSearchParams({ drive, path, token: drives.token })
  return `/api/drive/thumb?${query}`
}

// A file on a drive, read in parts or whole through the service.
function driveSource(token: string, drive: string, file: DriveFile): Source {
  const url = driveUrl('file', drive, file.path)
  const headers = tokenHeader(token)
  const fail = () => new Error(`Could not read ${file.name} on ${drive}`)

  return {
    name: file.name,
    size: file.size,
    read: async (start, end) => {
      if (end <= start) return new Uint8Array()
      const range = `bytes=${start}-${end - 1}`
      const init = { headers: { ...headers, Range: range } }
      const response = await fetch(url, init)
      if (response.status !== 206) throw fail()
      return new Uint8Array(await response.arrayBuffer())
    },
    file: async () => {
      const response = await fetch(url, { headers })
      if (!response.ok) throw fail()
      const blob = await response.blob()
      return new File([blob], file.name, { lastModified: file.modified })
    }
  }
}

async function ask<T>(
  token: string, kind: string, drive: string, path: string
) {
  const init = { headers: tokenHeader(token) }
  const response = await fetch(driveUrl(kind, drive, path), init)
  if (!response.ok) throw new Error(`the drive answered ${response.status}`)
  return (await response.json()) as T
}

function driveUrl(kind: string, drive: string, path: string) {
  return `/api/drive/${kind}?${new URLSearchParams({ drive, path })}`
}

function tokenHeader(token: string) {
  return { 'X-Photoloft-Token': token }
}
