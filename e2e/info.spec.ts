import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures')

// A 1x1 PNG served for every map tile.
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAj' +
    'CB0C8AAAAASUVORK5CYII=',
  'base64'
)
const MATIRA = {
  display_name: 'Matira, Bora Bora, French Polynesia',
  lat: '-16.5372',
  lon: '-151.7337',
  boundingbox: ['-16.5472', '-16.5272', '-151.7437', '-151.7237']
}

// ─── Helpers ─────────────────────────────────────────────────────────

// The native folder picker cannot be driven, so it hands out folders in
// the browser's private file system, which has the same API.
async function openLibrary(page: Page) {
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory()
      return root.getDirectoryHandle('library', { create: true })
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose library folder' }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
}

// Tests never reach the network: map tiles and place searches get
// canned answers (or fail, with `offline`), everything else is refused.
// Returns the place searches asked for.
async function stubNetwork(page: Page, offline = false) {
  const searches: URL[] = []
  await page.route(url => url.hostname !== '127.0.0.1', route => {
    return route.abort()
  })
  await page.route('https://tile.openstreetmap.org/**', route => {
    if (offline) return route.abort()
    return route.fulfill({ contentType: 'image/png', body: TILE })
  })
  await page.route('https://nominatim.openstreetmap.org/**', route => {
    searches.push(new URL(route.request().url()))
    if (offline) return route.abort()
    return route.fulfill({ json: [MATIRA] })
  })
  return searches
}

async function importPhotos(page: Page, names: string[]) {
  const files = names.map(name => join(FIXTURES, name))
  await page.locator('#import-files').setInputFiles(files)
  await expect(page.locator('.toast')).toContainText('Imported')
}

function cell(page: Page, name: string) {
  return page.locator('.cell', { hasText: name })
}

function field(page: Page, label: string) {
  return page.locator('.dialog').getByLabel(label, { exact: true })
}

async function dismissToast(page: Page) {
  const toast = page.locator('.toast')
  if (await toast.isVisible()) await toast.click()
  await expect(toast).toBeHidden()
}

// Presses the keys before the page draws its next frame, as a fast
// typist does: the app's animation frames wait until the last key.
async function pressInOneFrame(page: Page, keys: string[]) {
  const release = await page.evaluateHandle(() => {
    const request = window.requestAnimationFrame
    const held: FrameRequestCallback[] = []
    window.requestAnimationFrame = callback => -held.push(callback)
    return () => {
      window.requestAnimationFrame = request
      for (const callback of held) request(callback)
    }
  })
  for (const key of keys) await page.keyboard.press(key)
  await release.evaluate(draw => draw())
}

// Adds the selection to a new album of that name and opens it.
async function addToAlbum(page: Page, name: string) {
  await page.keyboard.press('g')
  await page.locator('[data-input="picker"]').fill(name)
  await page.keyboard.press('Enter')
  await page.locator('.nav-item', { hasText: name }).click()
}

async function exportAlbum(page: Page, setup: () => Promise<void>) {
  await dismissToast(page)
  await page.getByRole('button', { name: 'Export' }).first().click()
  await expect(page.locator('.dialog')).toBeVisible()
  await setup()
  await page.locator('.dialog').getByRole('button', { name: 'Export' }).click()
  await expect(page.locator('.toast')).toContainText('Exported')
}

async function readFile(page: Page, path: string[]) {
  const bytes = await page.evaluate(async path => {
    let dir = await navigator.storage.getDirectory()
    for (const part of path.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part)
    }
    const file = await (await dir.getFileHandle(path.at(-1)!)).getFile()
    return [...new Uint8Array(await file.arrayBuffer())]
  }, path)
  return new Uint8Array(bytes)
}

// The info an exported photo carries, as exiftool reads it: XMP Dublin
// Core, the EXIF text tags and the GPS position as signed degrees.
async function exported(page: Page, path: string[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'photoloft-')), 'p.jpg')
  writeFileSync(file, await readFile(page, path))
  const json = execFileSync('exiftool', [
    '-j', '-n', '-G1', '-sep', ', ', '-XMP-dc:all', '-IFD0:Artist',
    '-IFD0:Copyright', '-IFD0:ImageDescription', '-Composite:GPSPosition',
    file
  ]).toString()
  const { SourceFile: _file, ...tags } = JSON.parse(json)[0]
  return tags as Record<string, string | number>
}

function position(tags: Record<string, string | number>) {
  const text = tags['Composite:GPSPosition']
  return text === undefined ? null : String(text).split(' ').map(Number)
}

// ─── Flows ───────────────────────────────────────────────────────────

test('sets info on photos and exports it', async ({ page }) => {
  const searches = await stubNetwork(page)
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg'])
  const dialog = page.locator('.dialog')

  // One photo: texts, and a place found by name, on Enter only.
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('i')
  await expect(dialog.locator('.dialog-title')).toHaveText('Info for 1 photo')
  await field(page, 'Title').fill('Sunset at Matira')
  await field(page, 'Keywords').fill('beach, Bora Bora, family')
  await field(page, 'Author').fill('Ann Example')
  await field(page, 'Copyright').fill('(c) 2026 Ann Example')
  const search = dialog.getByPlaceholder('Search a place or paste')
  await search.pressSequentially('Matira')
  expect(searches).toHaveLength(0)
  await search.press('Enter')
  await dialog.getByRole('button', { name: /Matira, Bora Bora/ }).click()
  await expect(dialog.locator('.place-at')).toHaveText('-16.5372, -151.7337')
  await expect(dialog.locator('.map-pin i')).toBeVisible()
  expect(searches.map(url => Object.fromEntries(url.searchParams))).
    toEqual([{ format: 'jsonv2', limit: '5', q: 'Matira' }])
  await dialog.getByRole('button', { name: 'Apply to 1 photo' }).click()
  await expect(page.locator('.toast')).
    toContainText('Updated the info of 1 photo')

  // The next photo gets the author and copyright offered; pasted
  // coordinates set the pin without asking anyone.
  await cell(page, 'e2e-b.jpg').click()
  await page.getByRole('button', { name: 'Info' }).click()
  await expect(field(page, 'Author')).toHaveValue('Ann Example')
  await expect(field(page, 'Copyright')).toHaveValue('(c) 2026 Ann Example')
  await field(page, 'Description').fill('Lagoon')
  await search.fill(`16°30'01.4"S 151°44'29.4"W`)
  await search.press('Enter')
  await expect(dialog.locator('.place-at')).toHaveText('-16.5004, -151.7415')
  expect(searches).toHaveLength(1)
  await dialog.getByRole('button', { name: 'Apply to 1 photo' }).click()

  // Both: differing fields say so and stay as they are while empty,
  // typing replaces, emptying a shared value removes it.
  await cell(page, 'e2e-a.jpg').click({ modifiers: ['Control'] })
  await page.getByRole('button', { name: 'Info' }).click()
  await expect(dialog.locator('.dialog-title')).toHaveText('Info for 2 photos')
  for (const label of ['Title', 'Description', 'Keywords']) {
    await expect(field(page, label)).toHaveValue('')
    await expect(field(page, label)).
      toHaveAttribute('placeholder', 'Several values')
  }
  await expect(field(page, 'Author')).toHaveValue('Ann Example')
  await expect(dialog.locator('.place-at')).toHaveText('-16.5372, -151.7337')
  await field(page, 'Keywords').fill('lagoon')
  await field(page, 'Copyright').fill('')
  await dialog.getByRole('button', { name: 'Apply to 2 photos' }).click()
  await expect(page.locator('.toast')).
    toContainText('Updated the info of 2 photos. Ctrl+Z undoes it.')

  // Undo brings the copyright back; redo removes it again, as the
  // export shows. Keys pressed while Esc closes the dialog act on the
  // grid: Ctrl+Shift+Z redoes, S stars, and the title field gets
  // nothing.
  await page.keyboard.press('Control+z')
  await page.getByRole('button', { name: 'Info' }).click()
  await expect(field(page, 'Copyright')).toHaveValue('(c) 2026 Ann Example')
  await expect(field(page, 'Copyright')).toHaveAttribute('placeholder', '')
  await expect(field(page, 'Title')).toBeFocused()
  const title = await field(page, 'Title').elementHandle()
  await pressInOneFrame(page, ['Escape', 'Control+Shift+z', 's'])
  await expect(dialog).toBeHidden()
  const redo = page.locator('.toolbar').getByTitle('Redo (Ctrl+Shift+Z)')
  await expect(redo).toBeDisabled()
  const starred = page.locator('.nav-item', { hasText: 'Starred' })
  await expect(starred.locator('.nav-count')).toHaveText('2')
  expect(await title.evaluate(el => (el as HTMLInputElement).value)).toBe('')

  await addToAlbum(page, 'Tahiti')
  await exportAlbum(page, async () => {})
  const folder = ['library', 'Exports', 'Tahiti']
  const a = await exported(page, [...folder, 'Tahiti-001.jpg'])
  expect(a).toMatchObject({
    'XMP-dc:Title': 'Sunset at Matira',
    'XMP-dc:Subject': 'lagoon',
    'XMP-dc:Creator': 'Ann Example',
    'IFD0:Artist': 'Ann Example'
  })
  expect(a['XMP-dc:Rights']).toBeUndefined()
  expect(a['IFD0:Copyright']).toBeUndefined()
  expect(position(a)?.[0]).toBeCloseTo(-16.5372, 4)
  expect(position(a)?.[1]).toBeCloseTo(-151.7337, 4)

  const b = await exported(page, [...folder, 'Tahiti-002.jpg'])
  expect(b).toMatchObject({
    'XMP-dc:Description': 'Lagoon',
    'XMP-dc:Subject': 'lagoon',
    'IFD0:ImageDescription': 'Lagoon'
  })
  expect(b['XMP-dc:Title']).toBeUndefined()
  expect(position(b)?.[0]).toBeCloseTo(-16.500389, 4)
  expect(position(b)?.[1]).toBeCloseTo(-151.7415, 4)
})

test('moves through the Info dialog with the keys', async ({ page }) => {
  const searches = await stubNetwork(page)
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg'])
  await dismissToast(page)
  const dialog = page.locator('.dialog')
  const search = dialog.getByPlaceholder('Search a place or paste')

  // Down and Up move between the fields and stop at the first.
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('i')
  await expect(field(page, 'Title')).toBeFocused()
  for (const [key, label] of [
    ['ArrowDown', 'Description'], ['ArrowDown', 'Keywords'],
    ['ArrowUp', 'Description'], ['ArrowUp', 'Title'], ['ArrowUp', 'Title']
  ] as const) {
    await page.keyboard.press(key)
    await expect(field(page, label)).toBeFocused()
  }
  await page.keyboard.type('Lagoon')

  // Enter in the place search searches and keeps the dialog open; the
  // map keeps the arrows.
  await search.fill('Matira')
  await search.press('Enter')
  await expect(dialog.getByRole('button', { name: /Matira/ })).toBeVisible()
  expect(searches).toHaveLength(1)
  await expect(page.locator('.toast')).toBeHidden()
  await page.locator('.place-map').focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.place-map')).toBeFocused()

  // Enter in a field presses Apply.
  await field(page, 'Title').press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page.locator('.toast')).
    toContainText('Updated the info of 1 photo')
})

test('starts at the camera location and can remove it', async ({ page }) => {
  const searches = await stubNetwork(page, true)
  await openLibrary(page)
  await importPhotos(page, ['exif-mm.jpg', 'exif-ii.jpg'])
  const dialog = page.locator('.dialog')

  // The camera recorded Rome; the map starts there.
  await cell(page, 'exif-mm.jpg').click()
  await page.getByRole('button', { name: 'Info' }).click()
  await expect(dialog.locator('.place-at')).toHaveText('41.9000, 12.5000')

  // Offline, the map and the search say so; coordinates still work.
  await expect(dialog).toContainText('The map could not load.')
  const search = dialog.getByPlaceholder('Search a place or paste')
  await search.fill('Rome')
  await search.press('Enter')
  await expect(dialog).toContainText('The place search failed.')
  expect(searches).toHaveLength(1)
  await search.fill('41.89, 12.49')
  await search.press('Enter')
  await expect(dialog.locator('.place-at')).toHaveText('41.8900, 12.4900')

  // Clicking the map moves the pin; Remove location takes it away.
  await page.locator('.place-map').click({ position: { x: 300, y: 60 } })
  await expect(dialog.locator('.place-at')).not.toHaveText('41.8900, 12.4900')
  await expect(dialog.locator('.place-at')).toHaveText(/^\d+\.\d{4}, \d+/)
  await dialog.getByRole('button', { name: 'Remove location' }).click()
  await expect(dialog.locator('.place-at')).toHaveText('No location')
  await expect(dialog.locator('.map-pin')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Apply to 1 photo' }).click()

  // Exported with camera locations kept, it has none; the other photo
  // keeps the one its camera recorded.
  await cell(page, 'exif-ii.jpg').click({ modifiers: ['Control'] })
  await addToAlbum(page, 'Rome')
  await exportAlbum(page, async () => {
    const strip = page.getByLabel('Remove camera locations')
    await expect(strip).toBeChecked()
    await strip.uncheck()
  })
  const folder = ['library', 'Exports', 'Rome']
  const kept = await exported(page, [...folder, 'Rome-001.jpg'])
  const removed = await exported(page, [...folder, 'Rome-002.jpg'])
  expect(kept['XMP-dc:Title']).toBeUndefined()
  expect(position(kept)?.[0]).toBeCloseTo(41.9, 4)
  expect(position(kept)?.[1]).toBeCloseTo(12.5, 4)
  expect(position(removed)).toBeNull()
})
