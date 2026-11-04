import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { colourParams, develop, type RGB } from '../src/colour'
import { exifTags, jpegInfo } from '../src/exif'
import { colourOf, NEUTRAL_EDIT } from '../src/schema'

const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures')
const PHOTOS = [
  'e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg', 'e2e-d.jpg', 'e2e-portrait.jpg',
  'e2e-flat.jpg'
]
const EXPORTS = ['library', 'Exports', 'Rome 2026']

// ─── Helpers ─────────────────────────────────────────────────────────

// The native folder picker cannot be driven, so it hands out folders in
// the browser's private file system, which has the same API: `library`
// for the library, and `window.importPath` when importing a folder.
async function openLibrary(page: Page) {
  await page.addInitScript(() => {
    const page = window as unknown as { importPath?: string[] }
    window.showDirectoryPicker = async options => {
      const importing = options?.id === 'lightbox-import'
      const path = importing ? page.importPath ?? [] : ['library']
      let dir = await navigator.storage.getDirectory()
      for (const part of path) {
        dir = await dir.getDirectoryHandle(part, { create: true })
      }
      return dir
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose library folder' }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
}

// Waits for the library file to be written, so a reload sees the
// latest changes.
async function saved(page: Page) {
  await expect(page.locator('[data-saved="true"]')).toBeVisible()
}

async function importPhotos(page: Page, names: string[]) {
  const files = names.map(name => join(FIXTURES, name))
  await page.locator('#import-files').setInputFiles(files)
  await expect(page.locator('.toast')).toContainText('Imported')
}

// Copies fixtures into the private file system, `path: fixture`.
async function writeFixtures(page: Page, files: Record<string, string>) {
  for (const [path, name] of Object.entries(files)) {
    const bytes = [...readFileSync(join(FIXTURES, name))]
    await page.evaluate(async ({ path, bytes }) => {
      const parts = path.split('/')
      let dir = await navigator.storage.getDirectory()
      for (const part of parts.slice(0, -1)) {
        dir = await dir.getDirectoryHandle(part, { create: true })
      }
      const handle = await dir.getFileHandle(parts.at(-1)!, { create: true })
      const stream = await handle.createWritable()
      await stream.write(new Uint8Array(bytes))
      await stream.close()
    }, { path, bytes })
  }
}

async function importFolder(page: Page, path: string[]) {
  await dismissToast(page)
  await page.evaluate(path => {
    (window as unknown as { importPath: string[] }).importPath = path
  }, path)
  const toolbar = page.locator('.toolbar')
  await toolbar.getByRole('button', { name: 'Import folder' }).click()
  await expect(page.locator('.toast')).toBeVisible()
}

function slider(page: Page, label: string) {
  return page.locator('.slider', { hasText: label }).locator('output')
}

function cell(page: Page, name: string) {
  return page.locator('.cell', { hasText: name })
}

function names(page: Page) {
  return page.locator('.cell .cell-file')
}

async function listFiles(page: Page, path: string[]) {
  return page.evaluate(async path => {
    let dir = await navigator.storage.getDirectory()
    for (const part of path) dir = await dir.getDirectoryHandle(part)
    const found: string[] = []
    for await (const entry of dir.values()) found.push(entry.name)
    return found.sort()
  }, path)
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

async function writeFile(page: Page, path: string[], text: string) {
  await page.evaluate(async ({ path, text }) => {
    let dir = await navigator.storage.getDirectory()
    for (const part of path.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part)
    }
    const handle = await dir.getFileHandle(path.at(-1)!, { create: true })
    const stream = await handle.createWritable()
    await stream.write(text)
    await stream.close()
  }, { path, text })
}

async function meanColour(page: Page, path: string[]) {
  return page.evaluate(async path => {
    let dir = await navigator.storage.getDirectory()
    for (const part of path.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part)
    }
    const file = await (await dir.getFileHandle(path.at(-1)!)).getFile()
    const bitmap = await createImageBitmap(file)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    const sum = [0, 0, 0]
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) sum[c] += data[i + c]
    }
    return sum.map(s => s / (data.length / 4))
  }, path)
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

// Adds to a new album of that name from the open album dialog.
async function pickAlbum(page: Page, name: string) {
  await page.locator('[data-input="picker"]').fill(name)
  await page.keyboard.press('Enter')
  await expect(page.locator('.dialog')).toBeHidden()
}

async function exportAlbum(page: Page, setup: (dialog: Page) => Promise<void>) {
  await dismissToast(page)
  await page.getByRole('button', { name: 'Export' }).first().click()
  await expect(page.locator('.dialog')).toBeVisible()
  await setup(page)
  await page.locator('.dialog').getByRole('button', { name: 'Export' }).click()
  await expect(page.locator('.toast')).toContainText('Exported')
}

// ─── Flows ───────────────────────────────────────────────────────────

test('imports, sorts into an album, edits and exports', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, [...PHOTOS, 'not-a-jpeg.png'])
  await expect(page.locator('.toast')).toContainText('Imported 6 photos')
  await expect(page.locator('.toast')).toContainText('1 skipped')
  await expect(page.locator('.cell')).toHaveCount(6)
  await expect(names(page)).toHaveText(PHOTOS)

  // EXIF orientation is applied: the sideways photo shows landscape.
  const portrait = cell(page, 'e2e-portrait.jpg').locator('img')
  await expect(portrait).toHaveJSProperty('complete', true)
  const shape = await portrait.evaluate((img: HTMLImageElement) =>
    [img.naturalWidth, img.naturalHeight])
  expect(shape[0]).toBeGreaterThan(shape[1])

  // Select two photos and add them to a new album with G.
  await cell(page, 'e2e-a.jpg').click()
  await cell(page, 'e2e-b.jpg').click({ modifiers: ['Control'] })
  await expect(page.locator('.selection-count')).toHaveText('2 selected')
  await page.keyboard.press('g')
  await pickAlbum(page, 'Rome 2026')
  await expect(page.locator('.toast')).
    toContainText('Added 2 photos to Rome 2026')

  // Drag a third photo onto the album in the sidebar.
  const album = page.locator('[data-drop-album]', { hasText: 'Rome 2026' })
  await cell(page, 'e2e-flat.jpg').click()
  await cell(page, 'e2e-flat.jpg').dragTo(album)
  await expect(album.locator('.nav-count')).toHaveText('3')

  // Unsorted lists what is in no album.
  await page.locator('.nav-item', { hasText: 'Unsorted' }).click()
  await expect(page.locator('.cell')).toHaveCount(3)

  // Reorder inside the album by dragging the flat photo to the front.
  await album.click()
  await expect(names(page)).
    toHaveText(['e2e-a.jpg', 'e2e-b.jpg', 'e2e-flat.jpg'])
  await cell(page, 'e2e-flat.jpg').dragTo(cell(page, 'e2e-a.jpg'), {
    targetPosition: { x: 4, y: 40 }
  })
  await expect(names(page)).
    toHaveText(['e2e-flat.jpg', 'e2e-a.jpg', 'e2e-b.jpg'])

  // Edit the flat photo.
  await cell(page, 'e2e-flat.jpg').dblclick()
  await expect(page.locator('.editor')).toBeVisible()
  await expect(page.locator('.stage')).not.toHaveClass(/loading/)
  await page.locator('input[data-key="exposure"]').fill('1')
  await page.locator('input[data-key="temperature"]').fill('40')
  await expect(slider(page, 'Exposure')).toHaveText('1.00')
  await page.keyboard.press('Escape')
  await expect(page.locator('.library')).toBeVisible()

  // Export with album names, a size cap and EXIF carried over.
  await exportAlbum(page, async () => {
    await page.locator('.dialog .input').first().fill('Rome')
    await page.locator('[data-field="size"]').selectOption('custom')
    await page.locator('[data-field="customSize"]').fill('200')
  })
  expect(await listFiles(page, EXPORTS)).
    toEqual(['Rome-001.jpg', 'Rome-002.jpg', 'Rome-003.jpg'])

  const second = await readFile(page, [...EXPORTS, 'Rome-002.jpg'])
  expect(jpegInfo(second)).toMatchObject({ width: 200, height: 150 })
  expect(exifTags(second).get('exif.0x9003')).toBe('2024:01:01 10:00:00')

  // The GPU output matches the reference maths.
  const flat = await readFile(page, [...EXPORTS, 'Rome-001.jpg'])
  expect(jpegInfo(flat)).toMatchObject({ width: 64, height: 48 })
  const source: RGB = [150 / 255, 120 / 255, 90 / 255]
  const edit = { ...colourOf(NEUTRAL_EDIT), exposure: 1, temperature: 40 }
  const params = colourParams(edit)
  const expected = develop(source, params).map(v => v * 255)
  const actual = await meanColour(page, [...EXPORTS, 'Rome-001.jpg'])
  actual.forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThan(3))

  // A size limit forces smaller files.
  const sizes = await Promise.all(['Rome-002.jpg', 'Rome-003.jpg'].map(name =>
    readFile(page, [...EXPORTS, name]).then(b => b.length)))
  const limit = Math.floor(Math.max(...sizes) * 0.6)
  await exportAlbum(page, async () => {
    await page.locator('[data-field="limit"]').selectOption('custom')
    const megabytes = String(limit / 1_000_000)
    await page.locator('[data-field="customLimit"]').fill(megabytes)
  })
  for (const name of await listFiles(page, EXPORTS)) {
    const bytes = await readFile(page, [...EXPORTS, name])
    expect(bytes.length).toBeLessThanOrEqual(limit)
  }

  // A re-export removes files of photos taken out of the album and
  // leaves hand-added files alone.
  await writeFile(page, [...EXPORTS, 'notes.txt'], 'mine')
  await cell(page, 'e2e-b.jpg').click()
  await page.keyboard.press('Delete')
  await expect(page.locator('.cell')).toHaveCount(2)
  await exportAlbum(page, async () => {
    await page.locator('[data-field="limit"]').selectOption('none')
  })
  expect(await listFiles(page, EXPORTS)).
    toEqual(['Rome-001.jpg', 'Rome-002.jpg', 'notes.txt'])

  // Everything survives a reload.
  await saved(page)
  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.locator('.nav-item', { hasText: 'Rome 2026' }).click()
  await expect(names(page)).toHaveText(['e2e-flat.jpg', 'e2e-a.jpg'])
  await cell(page, 'e2e-flat.jpg').dblclick()
  await expect(slider(page, 'Exposure')).toHaveText('1.00')
})

test('selects with a rectangle and runs Auto on it', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, PHOTOS)

  const first = await cell(page, 'e2e-a.jpg').boundingBox()
  const grid = await page.locator('[data-grid]').boundingBox()
  await page.mouse.move(grid!.x + grid!.width - 5, grid!.y + grid!.height - 5)
  await page.mouse.down()
  await page.mouse.move(first!.x + 20, first!.y + 20, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.selection-count')).toHaveText('6 selected')

  const bar = page.locator('.selection-bar')
  await bar.getByRole('button', { name: 'Auto' }).click()
  await expect(page.locator('.toast')).toContainText('Auto applied to 6 photos')

  // Auto leaves white balance alone; its own button warms the blue photo.
  await cell(page, 'e2e-b.jpg').dblclick()
  await expect(page.locator('.stage')).not.toHaveClass(/loading/)
  const temperature = slider(page, 'Temperature')
  await expect(temperature).toHaveText('0')
  await page.getByTitle('Remove a colour cast automatically').click()
  await expect.poll(async () => Number(await temperature.textContent())).
    toBeGreaterThan(0)
})

test('crops to a square and rotates', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg'])
  await cell(page, 'e2e-a.jpg').dblclick()
  await expect(page.locator('.stage')).not.toHaveClass(/loading/)

  await page.keyboard.press('c')
  await expect(page.locator('.crop-box')).toBeVisible()
  await page.getByRole('button', { name: '1:1' }).click()
  await page.locator('input[data-key="angle"]').fill('10')
  const box = await page.locator('.crop-box').boundingBox()
  expect(Math.abs(box!.width - box!.height)).toBeLessThan(2)
  await page.getByRole('button', { name: 'Done' }).click()

  const shape = async () => {
    const img = page.locator('.film-item img')
    return img.evaluate((el: HTMLImageElement) => {
      return el.naturalWidth / el.naturalHeight
    })
  }
  await expect.poll(shape, { timeout: 10_000 }).toBeCloseTo(1, 1)

  await page.keyboard.press('c')
  await page.getByTitle('Rotate right').click()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(shape, { timeout: 10_000 }).toBeLessThan(1)
})

test('trashes, undoes, restores and empties the trash', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg'])

  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('Delete')
  await expect(page.locator('.cell')).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await expect(page.locator('.cell')).toHaveCount(2)

  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('Delete')
  await page.locator('.nav-item', { hasText: 'Trash' }).click()
  await expect(page.locator('.cell')).toHaveCount(1)
  await cell(page, 'e2e-a.jpg').click()
  await page.getByRole('button', { name: 'Restore' }).click()
  await expect(page.locator('.cell')).toHaveCount(0)

  await page.locator('.nav-item', { hasText: 'All photos' }).click()
  await cell(page, 'e2e-b.jpg').click()
  await page.keyboard.press('Delete')
  await page.locator('.nav-item', { hasText: 'Trash' }).click()
  await page.getByRole('button', { name: 'Empty trash' }).click()
  await page.locator('.dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.locator('.toast')).toContainText('Deleted 1 photo for good')
  const originals = await listFiles(page, ['library', '.library', 'originals'])
  expect(originals).toHaveLength(1)
})

test('confirms with Enter and moves with Up and Down', async ({ page }) => {
  const dialog = page.locator('.dialog')
  const cancel = dialog.getByRole('button', { name: 'Cancel' })
  const confirm = dialog.getByRole('button', { name: 'Delete' })
  const empty = page.getByRole('button', { name: 'Empty trash' })
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg'])
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('Delete')
  await page.locator('.nav-item', { hasText: 'Trash' }).click()

  // Focus stays on the button behind the dialog, which counts as the
  // page: Down goes to the first button and the arrows stop at the
  // ends. Space presses the focused Cancel.
  await empty.click()
  for (const [key, to] of [
    ['ArrowDown', cancel], ['ArrowDown', confirm], ['ArrowDown', confirm],
    ['ArrowUp', cancel], ['ArrowUp', cancel]
  ] as const) {
    await page.keyboard.press(key)
    await expect(to).toBeFocused()
  }
  await page.keyboard.press(' ')
  await expect(dialog).toBeHidden()
  await expect(page.locator('.cell')).toHaveCount(1)

  // Enter from behind the dialog presses Delete.
  await empty.click()
  await page.keyboard.press('Enter')
  await expect(page.locator('.toast')).toContainText('Deleted 1 photo for good')
})

test('applies a date with Enter once it changes', async ({ page }) => {
  const dialog = page.locator('.dialog')
  const taken = dialog.locator('input[type="datetime-local"]')
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-c.jpg'])
  await expect(names(page)).toHaveText(['e2e-a.jpg', 'e2e-c.jpg'])

  // Unchanged, Apply is disabled and Enter leaves the dialog open. The
  // date field keeps Up and Down for its own values.
  await cell(page, 'e2e-a.jpg').click()
  await page.getByRole('button', { name: 'Adjust date' }).click()
  await expect(taken).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(taken).toBeFocused()

  await taken.fill('2030-01-01T12:00')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page.locator('.toast')).
    toContainText('Updated the capture times')
  await expect(names(page)).toHaveText(['e2e-c.jpg', 'e2e-a.jpg'])
})

test('recovers from damaged library files', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg'])
  await saved(page)

  // Reopening makes a backup; then both save slots get damaged.
  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.cell')).toHaveCount(2)
  for (const slot of ['library-a.json', 'library-b.json']) {
    await writeFile(page, ['library', '.library', slot], '{"vers')
  }

  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.toast')).toContainText('was damaged')
  await expect(page.locator('.cell')).toHaveCount(2)
})

test('reopens a folder remembered under the former name', async ({ page }) => {
  await page.goto('/')

  // The database, store and key an existing install wrote.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const folder = await root.getDirectoryHandle('Lightbox', { create: true })
    const open = indexedDB.open('lightbox', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('handles')
    const db = await new Promise<IDBDatabase>(resolve => {
      open.onsuccess = () => resolve(open.result)
    })
    const tx = db.transaction('handles', 'readwrite')
    tx.objectStore('handles').put(folder, 'library')
    await new Promise(resolve => { tx.oncomplete = resolve })
    db.close()
  })

  await page.reload()
  await expect(page.locator('.sidebar-folder')).toContainText('Lightbox')
})

test('keeps saving during non-stop changes', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg'])
  await saved(page)
  await cell(page, 'e2e-a.jpg').dblclick()
  await expect(page.locator('.stage')).not.toHaveClass(/loading/)

  const exposure = page.locator('input[data-key="exposure"]')
  for (let i = 1; i <= 15; i++) {
    await exposure.fill(String(i / 10))
    await page.waitForTimeout(200)
  }

  // Changes never paused for long, yet the file was written meanwhile.
  const slots = ['library-a.json', 'library-b.json']
  const seqs = await Promise.all(slots.map(async slot => {
    const bytes = await readFile(page, ['library', '.library', slot])
    return JSON.parse(new TextDecoder().decode(bytes)).seq as number
  }))
  expect(Math.max(...seqs)).toBeGreaterThanOrEqual(2)
})

test('imports a folder with all its subfolders, once', async ({ page }) => {
  await openLibrary(page)
  await writeFixtures(page, {
    'card/a.jpg': 'e2e-a.jpg',
    'card/2024/rome/b.jpg': 'e2e-b.jpg',
    'card/2024/rome/deeper/c.JPG': 'e2e-c.jpg',
    'card/2024/copy-of-b.jpg': 'e2e-b.jpg',
    'card/.thumbnails/d.jpg': 'e2e-d.jpg',
    'card/Other App/thumbs/13/0f3a.jpg': 'e2e-portrait.jpg',
    'card/Catalog Previews.lrdata/e.jpg': 'e2e-flat.jpg',
    'card/notes.png': 'not-a-jpeg.png'
  })

  await importFolder(page, ['card'])
  const toast = page.locator('.toast')
  await expect(toast).toContainText('Imported 3 photos')
  await expect(toast).toContainText('1 already imported')
  await expect(toast).toContainText('1 skipped')
  await expect(page.locator('.cell')).toHaveCount(3)

  // The same folder again adds nothing.
  await importFolder(page, ['card'])
  await expect(toast).toContainText('Imported 0 photos')
  await expect(toast).toContainText('4 already imported')
  await expect(page.locator('.cell')).toHaveCount(3)
})

test('never imports its own library folder', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg'])
  await writeFixtures(page, {
    'library/Exports/Trip/Trip-001.jpg': 'e2e-b.jpg',
    'other/c.jpg': 'e2e-c.jpg'
  })

  // Picking the folder that holds both skips the library inside it.
  await importFolder(page, [])
  await expect(page.locator('.toast')).toContainText('Imported 1 photo.')
  await expect(page.locator('.cell')).toHaveCount(2)

  await importFolder(page, ['library'])
  await expect(page.locator('.toast')).
    toContainText('This is the Photoloft library folder')
})

test('stars photos to keep', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg'])

  // S stars the selection; the star on a thumbnail stars that photo.
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('s')
  await cell(page, 'e2e-c.jpg').hover()
  await cell(page, 'e2e-c.jpg').locator('.cell-star').click()

  const starred = page.locator('.nav-item', { hasText: 'Starred' })
  await expect(starred.locator('.nav-count')).toHaveText('2')
  await starred.click()
  await expect(names(page)).toHaveText(['e2e-a.jpg', 'e2e-c.jpg'])

  // In the editor S toggles the photo on screen.
  await cell(page, 'e2e-a.jpg').dblclick()
  const star = page.locator('.editor-bar').getByTitle('Star to keep (S)')
  const on = /(^|\s)on(\s|$)/
  await expect(star).toHaveClass(on)
  await page.keyboard.press('s')
  await expect(star).not.toHaveClass(on)
  await page.keyboard.press('Escape')
  await expect(names(page)).toHaveText(['e2e-c.jpg'])

  await page.keyboard.press('Control+z')
  await expect(names(page)).toHaveText(['e2e-a.jpg', 'e2e-c.jpg'])
})

test('takes keys pressed right after Esc as shortcuts', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg', 'clip.mp4'])
  const starred = page.locator('.nav-item', { hasText: 'Starred' })
  const selected = page.locator('.cell.selected .cell-file')
  const value = (el: HTMLElement | SVGElement) => (el as HTMLInputElement).value

  // Esc closes the album picker; S in the same frame stars the photo.
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('g')
  const picker = page.locator('[data-input="picker"]')
  await expect(picker).toBeFocused()
  const query = await picker.elementHandle()
  await pressInOneFrame(page, ['Escape', 's'])
  await expect(page.locator('.dialog')).toBeHidden()
  await expect(starred.locator('.nav-count')).toHaveText('1')
  expect(await query.evaluate(value)).toBe('')

  // Esc ends renaming the photo in the editor; S stars it.
  await cell(page, 'e2e-b.jpg').dblclick()
  await page.locator('.editor-name').dblclick()
  const rename = page.locator('.rename-input')
  await expect(rename).toBeFocused()
  const name = await rename.elementHandle()
  await pressInOneFrame(page, ['Escape', 's'])
  await expect(page.locator('h2.editor-name')).toHaveText('e2e-b.jpg')
  await expect(starred.locator('.nav-count')).toHaveText('2')
  expect(await name.evaluate(value)).toBe('e2e-b.jpg')

  // Esc closes the editor from a slider; the arrow moves on in the grid
  // and leaves the slider alone.
  const exposure = page.locator('input[data-key="exposure"]')
  await exposure.focus()
  const slider = await exposure.elementHandle()
  await pressInOneFrame(page, ['Escape', 'ArrowLeft'])
  await expect(page.locator('.app')).toHaveAttribute('data-mode', 'grid')
  await expect(selected).toHaveText('e2e-a.jpg')
  expect(await slider.evaluate(value)).toBe('0')

  // The same from the seek bar of a video, which stays in the page
  // while the editor is hidden.
  await cell(page, 'clip.mp4').click()
  await page.keyboard.press(' ')
  await page.locator('.transport-seek').focus()
  await pressInOneFrame(page, ['Escape', 'ArrowLeft'])
  await expect(page.locator('.app')).toHaveAttribute('data-mode', 'grid')
  await expect(selected).toHaveText('e2e-b.jpg')
})

test('shows every photo while scrolling a large library', async ({ page }) => {
  await openLibrary(page)
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('many', { create: true })
    for (let i = 0; i < 60; i++) {
      const canvas = new OffscreenCanvas(32, 24)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = `hsl(${i * 6}, 60%, 50%)`
      ctx.fillRect(0, 0, 32, 24)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg' })
      const name = `p${String(i).padStart(3, '0')}.jpg`
      const handle = await dir.getFileHandle(name, { create: true })
      const stream = await handle.createWritable()
      await stream.write(blob)
      await stream.close()
    }
  })
  await importFolder(page, ['many'])
  await expect(page.locator('.toast')).toContainText('Imported 60 photos')
  await page.locator('[data-change="sort"]').selectOption('name')

  const grid = page.locator('[data-grid]')
  for (const at of [0.5, 1]) {
    await grid.evaluate((el, at) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) * at
    }, at)
    const index = Math.min(59, Math.round(59 * at))
    const name = `p${String(index).padStart(3, '0')}.jpg`
    await expect(cell(page, name)).toBeInViewport()
  }
})

test('sorts an album with one control', async ({ page }) => {
  const added = ['e2e-c.jpg', 'e2e-a.jpg', 'e2e-d.jpg', 'e2e-b.jpg']
  const size = (name: string) => statSync(join(FIXTURES, name)).size
  const bySize = [...added].sort((a, b) => size(b) - size(a))

  await openLibrary(page)
  await importPhotos(page, added)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('g')
  await pickAlbum(page, 'Trip')
  await page.locator('.nav-item', { hasText: 'Trip' }).click()

  const sort = page.locator('[data-change="sort"]')
  await expect(sort).toHaveValue('custom')
  await sort.selectOption('size')
  await expect(names(page)).toHaveText(bySize)
  const detail = cell(page, bySize[0]).locator('.cell-detail')
  await expect(detail).toHaveText(/^\d+ KB$/)

  await sort.selectOption('date')
  await expect(cell(page, 'e2e-a.jpg').locator('.cell-detail')).
    toContainText('2024')

  await sort.selectOption('name')
  await expect(names(page)).toHaveText([...added].sort())
  await expect(page.locator('.cell-detail')).toHaveCount(0)

  // Dragging while sorted keeps what is shown and makes it custom.
  const shown = [...added].sort()
  await cell(page, shown[3]).dragTo(cell(page, shown[0]), {
    targetPosition: { x: 4, y: 40 }
  })
  await expect(names(page)).toHaveText([shown[3], ...shown.slice(0, 3)])
  await expect(sort).toHaveValue('custom')
})

test('shows photos whose camera wrote a placeholder date', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['zero-date.jpg', 'e2e-a.jpg'])

  // Sorted by date, the undated photo comes last and says so.
  await expect(names(page)).toHaveText(['e2e-a.jpg', 'zero-date.jpg'])
  await cell(page, 'zero-date.jpg').hover()
  await expect(cell(page, 'zero-date.jpg').locator('.cell-detail')).
    toHaveText('No date')
  await expect(page.locator('#crash')).toBeHidden()
})

test('opens the selected photo in the editor with Space', async ({ page }) => {
  const app = page.locator('.app')
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg'])

  await cell(page, 'e2e-b.jpg').click()
  await page.keyboard.press(' ')
  await expect(app).toHaveAttribute('data-mode', 'edit')
  await expect(page.locator('.editor-name')).toHaveText('e2e-b.jpg')
  await expect(page.locator('.stage')).not.toHaveClass(/loading/)
  await expect(page.locator('.panel')).toBeVisible()
  await expect(page.locator('.filmstrip')).toBeVisible()

  // Enter presses a focused button in the editor.
  const star = page.locator('.editor-bar [data-action="star"]')
  await star.focus()
  await page.keyboard.press('Enter')
  await expect(star).toHaveClass(/\bon\b/)

  // Arrows step through; Space returns with the last photo selected.
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.editor-name')).toHaveText('e2e-c.jpg')
  await page.keyboard.press(' ')
  await expect(app).toHaveAttribute('data-mode', 'grid')
  await expect(page.locator('.cell.selected')).toHaveCount(1)
  const selected = page.locator('.cell.selected .cell-file')
  await expect(selected).toHaveText('e2e-c.jpg')

  // C opens and leaves the crop tool. There Space leaves a photo alone;
  // Esc goes back to editing, and Space from there to the grid.
  await page.keyboard.press(' ')
  await page.keyboard.press('c')
  await expect(app).toHaveAttribute('data-mode', 'crop')
  await page.keyboard.press('c')
  await expect(app).toHaveAttribute('data-mode', 'edit')
  await page.keyboard.press('c')
  await expect(app).toHaveAttribute('data-mode', 'crop')
  await page.keyboard.press(' ')
  await page.keyboard.press('Escape')
  await expect(app).toHaveAttribute('data-mode', 'edit')
  await page.keyboard.press(' ')
  await expect(app).toHaveAttribute('data-mode', 'grid')
})

test('adds the photo shown in the editor to an album', async ({ page }) => {
  const title = page.locator('.dialog-title')
  const button = page.locator('.editor-bar [data-action="open-picker"]')
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg'])

  await cell(page, 'e2e-a.jpg').click()
  await cell(page, 'e2e-c.jpg').click({ modifiers: ['Control'] })
  await cell(page, 'e2e-b.jpg').click({ modifiers: ['Control'] })
  await expect(page.locator('.cell.selected')).toHaveCount(3)
  await page.keyboard.press('Enter')
  await expect(page.locator('.editor-name')).toHaveText('e2e-b.jpg')

  // G and the header button both offer the photo shown.
  await page.keyboard.press('g')
  await expect(title).toHaveText('Add 1 photo to albums')
  await page.keyboard.press('Escape')
  await expect(page.locator('.dialog')).toBeHidden()
  await button.click()
  await expect(title).toHaveText('Add 1 photo to albums')
  await pickAlbum(page, 'Keepers')
  await expect(page.locator('.toast')).
    toContainText('Added 1 photo to Keepers')
  await expect(page.locator('.app')).toHaveAttribute('data-mode', 'edit')

  await page.keyboard.press('Escape')
  await page.locator('.nav-item', { hasText: 'Keepers' }).click()
  await expect(names(page)).toHaveText(['e2e-b.jpg'])

  // The trash has no button, and G there opens nothing, so ? still
  // opens the shortcut list.
  await page.locator('.nav-item', { hasText: 'All photos' }).click()
  await cell(page, 'e2e-c.jpg').click()
  await page.keyboard.press('Delete')
  await page.locator('.nav-item', { hasText: 'Trash' }).click()
  await cell(page, 'e2e-c.jpg').dblclick()
  await expect(page.locator('.editor-name')).toHaveText('e2e-c.jpg')
  await expect(button).toHaveCount(0)
  await page.keyboard.press('g')
  await page.keyboard.press('?')
  await expect(title).toHaveText('Keyboard shortcuts')
})

function albumCount(page: Page, name: string) {
  const album = page.locator('[data-drop-album]', { hasText: name })
  return album.locator('.nav-count')
}

test('adds photos to several albums at once', async ({ page }) => {
  const dialog = page.locator('.dialog')
  const field = page.locator('[data-input="picker"]')
  const add = dialog.getByRole('button', { name: 'Add' })
  const toast = page.locator('.toast')
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg'])

  // With nothing ticked or typed, Add is disabled.
  await cell(page, 'e2e-c.jpg').click()
  await page.keyboard.press('g')
  await expect(add).toBeDisabled()

  // Space on the offered new album ticks it and clears the field; the
  // next name typed on the row goes to the field. A typed name with
  // ticks adds to all of them, and the toast counts more than three.
  for (const name of ['Keepers', 'Rome', 'Atlantic']) {
    await page.keyboard.type(name)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press(' ')
    await expect(field).toHaveValue('')
  }
  await page.keyboard.type('Bora')
  await expect(field).toBeFocused()
  await add.click()
  await expect(toast).toContainText('Added 1 photo to 4 albums.')

  // Two albums and a new one, by keyboard alone.
  await cell(page, 'e2e-a.jpg').click()
  await cell(page, 'e2e-b.jpg').click({ modifiers: ['Control'] })
  await page.keyboard.press('g')
  for (const name of ['kee', 'rome']) {
    await page.keyboard.type(name)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press(' ')
  }
  await page.keyboard.type('Moorea')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(toast).
    toContainText('Added 2 photos to Keepers, Rome and Moorea.')
  await expect(albumCount(page, 'Keepers')).toHaveText('3')
  await expect(albumCount(page, 'Rome')).toHaveText('3')
  await expect(albumCount(page, 'Moorea')).toHaveText('2')
  await expect(albumCount(page, 'Atlantic')).toHaveText('1')

  // One Ctrl+Z takes all of it back, the new album included.
  await page.keyboard.press('Control+z')
  await expect(page.locator('.nav-item', { hasText: 'Moorea' })).
    toHaveCount(0)
  await expect(albumCount(page, 'Keepers')).toHaveText('1')
  await expect(albumCount(page, 'Rome')).toHaveText('1')
})

test('keeps albums that hold the photos ticked', async ({ page }) => {
  const dialog = page.locator('.dialog')
  const field = page.locator('[data-input="picker"]')
  const add = dialog.getByRole('button', { name: 'Add' })
  const rows = dialog.locator('.picker-item')
  const row = (name: string) => rows.filter({ hasText: name })
  const box = (name: string) => row(name).locator('input[type="checkbox"]')
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg'])

  // Keepers holds both photos, Rome one of them.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('g')
  await pickAlbum(page, 'Keepers')
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('g')
  await pickAlbum(page, 'Rome')

  // Keepers shows ticked and greyed and stays ticked; Rome is an
  // ordinary row. Keepers alone leaves Add disabled.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('g')
  await expect(box('Keepers')).toBeChecked()
  await expect(box('Keepers')).toBeDisabled()
  await expect(row('Keepers')).toHaveClass(/\bheld\b/)
  await expect(box('Rome')).not.toBeChecked()
  await expect(add).toBeDisabled()
  await row('Keepers').click({ force: true })
  await expect(box('Keepers')).toBeChecked()

  // A click ticks Rome and leaves focus on it.
  await row('Rome').click()
  await expect(box('Rome')).toBeChecked()
  await expect(box('Rome')).toBeFocused()
  await expect(add).toBeEnabled()

  // Ticks survive another filter; ticked new albums stay listed until
  // unticked, and the field takes focus when the row goes.
  await page.keyboard.type('Tahiti')
  await expect(row('Rome')).toHaveCount(0)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press(' ')
  await page.keyboard.type('Moorea')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press(' ')
  await expect(rows).toHaveText([
    'Keepers', 'Rome', 'New album "Tahiti"', 'New album "Moorea"'
  ])
  await expect(rows.locator('input:checked')).toHaveCount(4)
  await row('Moorea').click()
  await expect(row('Moorea')).toHaveCount(0)
  await expect(field).toBeFocused()

  // Rome gets the photo it lacked.
  await page.keyboard.press('Enter')
  await expect(page.locator('.toast')).
    toContainText('Added 2 photos to Rome and Tahiti.')
  await expect(albumCount(page, 'Rome')).toHaveText('2')
  await expect(albumCount(page, 'Tahiti')).toHaveText('2')
  await expect(albumCount(page, 'Keepers')).toHaveText('2')
})

test('drops on an album only the photos it lacks', async ({ page }) => {
  const toast = page.locator('.toast')
  const tahiti = page.locator('[data-drop-album]', { hasText: 'Tahiti' })
  const folder = page.locator('.sidebar-folder')
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg'])
  await cell(page, 'e2e-b.jpg').click()
  await page.keyboard.press('g')
  await pickAlbum(page, 'Tahiti')

  // Three photos on an album holding one: the other two go in, once.
  await page.keyboard.press('Control+a')
  await cell(page, 'e2e-a.jpg').dragTo(tahiti)
  await expect(toast).toContainText('Added 2 photos to Tahiti.')
  await expect(albumCount(page, 'Tahiti')).toHaveText('3')
  await tahiti.click()
  await expect(names(page)).
    toHaveText(['e2e-b.jpg', 'e2e-a.jpg', 'e2e-c.jpg'])

  // Dropped again they change nothing: no save is due right after, and
  // Ctrl+Z takes back the drop before.
  await page.locator('.nav-item', { hasText: 'All photos' }).click()
  await page.keyboard.press('Control+a')
  await saved(page)
  await cell(page, 'e2e-a.jpg').dragTo(tahiti)
  await expect(toast).toContainText('Tahiti already holds these 3 photos.')
  expect(await folder.getAttribute('data-saved')).toBe('true')
  await page.keyboard.press('Control+z')
  await expect(albumCount(page, 'Tahiti')).toHaveText('1')

  await cell(page, 'e2e-b.jpg').click()
  await cell(page, 'e2e-b.jpg').dragTo(tahiti)
  await expect(toast).toContainText('Tahiti already holds this photo.')
  await expect(albumCount(page, 'Tahiti')).toHaveText('1')
})

test('leaves no undo step when an import changes nothing', async ({ page }) => {
  const photos = ['e2e-a.jpg', 'e2e-b.jpg']
  const known = 'Imported 0 photos. 2 already imported.'
  const toast = page.locator('.toast')
  const folder = page.locator('.sidebar-folder')
  const starred = page.locator('.nav-item', { hasText: 'Starred' })
  const rome = page.locator('[data-drop-album]', { hasText: 'Rome' })
  await openLibrary(page)
  await importPhotos(page, photos)
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('s')
  await expect(starred.locator('.nav-count')).toHaveText('1')

  // The same photos again change nothing: no save is due right after,
  // and Ctrl+Z takes back the star before.
  await saved(page)
  await dismissToast(page)
  await importPhotos(page, photos)
  await expect(toast).toContainText(known)
  expect(await folder.getAttribute('data-saved')).toBe('true')
  await page.keyboard.press('Control+z')
  await expect(starred.locator('.nav-count')).toHaveText('')

  // With an album open, the known photo it lacks joins it.
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('g')
  await pickAlbum(page, 'Rome')
  await rome.click()
  await dismissToast(page)
  await importPhotos(page, photos)
  await expect(toast).toContainText(known)
  await expect(albumCount(page, 'Rome')).toHaveText('2')
  await expect(names(page)).toHaveText(photos)

  // Once the album holds both, the import changes nothing either.
  await saved(page)
  await dismissToast(page)
  await importPhotos(page, photos)
  await expect(toast).toContainText(known)
  expect(await folder.getAttribute('data-saved')).toBe('true')
  await page.keyboard.press('Control+z')
  await expect(albumCount(page, 'Rome')).toHaveText('1')
})

test('moves through the album dialog with the keys', async ({ page }) => {
  const dialog = page.locator('.dialog')
  const field = page.locator('[data-input="picker"]')
  const add = dialog.getByRole('button', { name: 'Add' })
  const error = dialog.locator('.picker-hint.danger')
  const rows = dialog.locator('.picker-item')
  const box = (name: string) =>
    rows.filter({ hasText: name }).locator('input[type="checkbox"]')
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg'])
  for (const name of ['Rome', 'Tahiti']) {
    await cell(page, 'e2e-b.jpg').click()
    await page.keyboard.press('g')
    await pickAlbum(page, name)
  }
  await dismissToast(page)

  // Enter with nothing ticked or typed goes to the field.
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('g')
  await expect(field).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(box('Rome')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(field).toBeFocused()
  await expect(dialog).toBeVisible()

  // Down and Up move between the field and the rows.
  for (const [key, to] of [
    ['ArrowDown', box('Rome')], ['ArrowDown', box('Tahiti')],
    ['ArrowUp', box('Rome')], ['ArrowUp', field], ['ArrowUp', field]
  ] as const) {
    await page.keyboard.press(key)
    await expect(to).toBeFocused()
  }

  // Space ticks the filtered row and clears the field; focus stays on
  // the album where the full list shows it.
  await page.keyboard.type('ta')
  await page.keyboard.press('ArrowDown')
  await expect(box('Tahiti')).toBeFocused()
  await page.keyboard.press(' ')
  await expect(field).toHaveValue('')
  await expect(box('Tahiti')).toBeChecked()
  await expect(box('Tahiti')).toBeFocused()
  await expect(box('Rome')).not.toBeChecked()

  // A letter on a row goes to the field. An album's own name, in any
  // case, shows an error and adds nothing until the field changes.
  await page.keyboard.press('t')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('t')
  await page.keyboard.type('ahiti')
  await expect(add).toBeDisabled()
  await page.keyboard.press('Enter')
  await expect(error).toHaveText('"Tahiti" is already an album.')
  await expect(dialog).toBeVisible()
  await expect(box('Tahiti')).toBeChecked()
  await page.keyboard.press('Backspace')
  await expect(error).toHaveCount(0)

  // With the field empty, Enter adds to the ticked albums.
  await field.fill('')
  await expect(add).toBeEnabled()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page.locator('.toast')).
    toContainText('Added 1 photo to Tahiti.')
  await expect(albumCount(page, 'Tahiti')).toHaveText('2')

  // A new name typed: Enter creates the album and adds to it.
  await page.keyboard.press('g')
  await page.keyboard.type('Moorea')
  await expect(add).toBeEnabled()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(albumCount(page, 'Moorea')).toHaveText('1')
})

test('clears what the last import put in no album', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg'])
  await dismissToast(page)
  await importPhotos(page, ['e2e-c.jpg', 'e2e-d.jpg', 'e2e-a.jpg'])

  const last = page.locator('.nav-item', { hasText: 'Last import' })
  await expect(last.locator('.nav-count')).toHaveText('2')
  await last.click()
  await expect(names(page)).toHaveText(['e2e-c.jpg', 'e2e-d.jpg'])

  await cell(page, 'e2e-c.jpg').click()
  await page.keyboard.press('g')
  await pickAlbum(page, 'Keepers')

  const clear = 'Trash photos not in an album'
  await page.getByRole('button', { name: clear }).click()
  const dialog = page.locator('.dialog')
  await expect(dialog).toContainText('1 photo')
  await dialog.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(names(page)).toHaveText(['e2e-c.jpg'])
  const trash = page.locator('.nav-item', { hasText: 'Trash' })
  await expect(trash.locator('.nav-count')).toHaveText('1')
})

test('lists the photos of every album on one page', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg'])
  for (const [name, photos] of [
    ['Rome', ['e2e-a.jpg', 'e2e-b.jpg']],
    ['Atlantic', ['e2e-b.jpg', 'e2e-c.jpg']]
  ] as const) {
    await page.locator('.nav-item', { hasText: 'All photos' }).click()
    await cell(page, photos[0]).click()
    await cell(page, photos[1]).click({ modifiers: ['Control'] })
    await page.keyboard.press('g')
    await pickAlbum(page, name)
  }

  await page.locator('.nav-item', { hasText: 'In albums' }).click()
  await expect(page.locator('.grid-header')).toHaveText([
    /Atlantic\s*2/, /Rome\s*2/
  ])
  await expect(names(page)).toHaveText([
    'e2e-b.jpg', 'e2e-c.jpg', 'e2e-a.jpg', 'e2e-b.jpg'
  ])

  // e2e-b shows in both albums and counts once.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('g')
  await expect(page.locator('.dialog-title')).
    toHaveText('Add 3 photos to albums')
  await page.keyboard.press('Escape')

  await page.locator('.grid-header', { hasText: 'Rome' }).click()
  await expect(page.locator('.toolbar-heading')).toHaveText('Rome')
})

// Size and first pixel of a video, read with ffprobe and ffmpeg.
function inspectVideo(bytes: Uint8Array) {
  const file = join(mkdtempSync(join(tmpdir(), 'photoloft-')), 'v.mp4')
  writeFileSync(file, bytes)
  const probe = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height', '-of', 'csv=p=0', file
  ]).toString().trim()
  const pixel = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-frames:v', '1', '-vf',
    'scale=in_color_matrix=bt709:in_range=tv,format=rgb24',
    '-f', 'rawvideo', '-'
  ])
  return { size: probe, pixel: [...pixel.subarray(0, 3)] }
}

test('imports, plays, grades and exports videos', async ({ page }) => {
  const videos = ['clip.mp4', 'VID_20240108_093000.mp4', 'flat.mp4']
  await openLibrary(page)
  await importPhotos(page, [...videos, 'e2e-a.jpg', 'broken.mp4'])
  await expect(page.locator('.toast')).toContainText('Imported 4')
  await expect(page.locator('.toast')).
    toContainText('1 video could not be played in this browser')
  await expect(page.locator('.cell-video')).toHaveCount(3)
  await expect(cell(page, 'clip.mp4').locator('.cell-video')).
    toContainText('0:02')

  // The phone clip, stored sideways, shows upright.
  const phone = cell(page, 'VID_20240108_093000.mp4').locator('img')
  await expect(phone).toHaveJSProperty('complete', true)
  const shape = await phone.evaluate((img: HTMLImageElement) =>
    img.naturalWidth / img.naturalHeight)
  expect(shape).toBeLessThan(1)

  // Space opens a video paused; Space and K play and pause it, Esc
  // closes it.
  await cell(page, 'clip.mp4').click()
  await page.keyboard.press(' ')
  await expect(page.locator('.app')).toHaveAttribute('data-mode', 'edit')
  await expect(page.locator('.stage')).not.toHaveClass(/loading/)
  const play = page.locator('.transport [data-action="play"] i')
  await expect(play).toHaveClass('icon-play')
  await page.keyboard.press(' ')
  await expect(play).toHaveClass('icon-pause')
  await page.keyboard.press('k')
  await expect(play).toHaveClass('icon-play')
  await page.keyboard.press('Escape')
  await expect(page.locator('.app')).toHaveAttribute('data-mode', 'grid')

  // Grade the flat clip, then export all three videos as an album.
  await cell(page, 'flat.mp4').dblclick()
  await expect(page.locator('.stage')).not.toHaveClass(/loading/)
  await page.locator('input[data-key="exposure"]').fill('1')
  await page.keyboard.press('Escape')
  await cell(page, videos[0]).click()
  for (const name of videos.slice(1)) {
    await cell(page, name).click({ modifiers: ['Control'] })
  }
  await page.keyboard.press('g')
  await pickAlbum(page, 'Trip')
  await page.locator('.nav-item', { hasText: 'Trip' }).click()

  await exportAlbum(page, async () => {
    await expect(page.locator('[data-field="videoSide"]')).toHaveValue('720')
  })
  await expect(page.locator('.toast')).toContainText('Exported 3 files')

  const folder = ['library', 'Exports', 'Trip']
  const files = await listFiles(page, folder)
  expect(files).toEqual(['Trip-001.mp4', 'Trip-002.mp4', 'Trip-003.mp4'])
  const results = []
  for (const name of files) {
    results.push(inspectVideo(await readFile(page, [...folder, name])))
  }
  expect(results.map(r => r.size).sort()).
    toEqual(['240,320', '320,240', '64,48'])

  // The graded clip comes out with the preview's colour maths.
  const flat = results.find(r => r.size === '64,48')!
  const edit = { ...colourOf(NEUTRAL_EDIT), exposure: 1 }
  const decoded: RGB = [149 / 255, 118 / 255, 96 / 255]
  const expected = develop(decoded, colourParams(edit)).map(v => v * 255)
  flat.pixel.forEach((v, i) => {
    expect(Math.abs(v - expected[i])).toBeLessThan(6)
  })
})

test('trims a video with keys and grips', async ({ page }) => {
  const transport = page.locator('.transport')
  const bar = page.locator('.transport-bar')
  const seek = page.locator('.transport-seek')
  const markIn = page.getByTitle('Mark in (I)')
  const markOut = page.getByTitle('Mark out (O)')
  const trimmed = transport.locator('.toolbar-count', { hasText: 'Trimmed' })
  const reset = transport.getByRole('button', { name: 'Reset trim' })
  const folder = page.locator('.sidebar-folder')
  await openLibrary(page)
  await importPhotos(page, ['clip.mp4', 'VID_20240108_093000.mp4', 'e2e-a.jpg'])
  await cell(page, 'clip.mp4').dblclick()
  await expect(page.locator('.stage')).not.toHaveClass(/loading/)
  await expect(markIn).toHaveValue('0')
  await expect(markOut).toHaveValue('2')
  await expect(trimmed).toHaveCount(0)
  const height = (await transport.boundingBox())!.height

  // 2 jumps to 20 % and I marks in there; 8 and O mark out at 80 %. The
  // clock keeps counting the whole clip, the parts outside turn grey.
  await page.keyboard.press('2')
  await expect(seek).toHaveValue('0.4')
  await page.keyboard.press('i')
  await expect(trimmed).toHaveText('Trimmed to 0:02')
  await page.keyboard.press('8')
  await page.keyboard.press('o')
  await expect(trimmed).toHaveText('Trimmed to 0:01')
  await expect(markIn).toHaveValue('0.4')
  await expect(markOut).toHaveValue('1.6')
  await expect(transport.locator('.toolbar-count').first()).
    toHaveText('0:02 / 0:02')
  await expect(bar).toHaveCSS('--in', '0.2')
  await expect(bar).toHaveCSS('--out', '0.8')
  await expect(reset).toBeVisible()
  expect((await transport.boundingBox())!.height).toBe(height)

  // Each mark is one undo step; a mark that changes nothing saves
  // nothing and leaves no step.
  await page.keyboard.press('Control+z')
  await expect(trimmed).toHaveText('Trimmed to 0:02')
  await page.keyboard.press('Control+z')
  await expect(trimmed).toHaveCount(0)
  await page.keyboard.press('Control+Shift+z')
  await page.keyboard.press('Control+Shift+z')
  await expect(trimmed).toHaveText('Trimmed to 0:01')
  await expect(folder).toHaveAttribute('data-saved', 'true')
  await page.keyboard.press('o')
  expect(await folder.getAttribute('data-saved')).toBe('true')
  await page.keyboard.press('Control+z')
  await expect(markOut).toHaveValue('2')
  await page.keyboard.press('Control+Shift+z')
  await expect(markOut).toHaveValue('1.6')

  // Play from the out mark, or from a grey part, starts at the in mark
  // and pauses at the out mark.
  const played = await page.evaluateHandle(() => {
    const seen: number[] = []
    const look = () => {
      const icon = document.querySelector('.transport [data-action="play"] i')
      const seek = document.querySelector<HTMLInputElement>('.transport-seek')
      if (icon?.matches('.icon-pause') && seek) seen.push(Number(seek.value))
      requestAnimationFrame(look)
    }
    look()
    return seen
  })
  const play = transport.locator('[data-action="play"] i')
  for (const key of ['8', '0']) {
    await page.keyboard.press(key)
    await played.evaluate(seen => seen.splice(0))
    await page.keyboard.press('k')
    await expect(play).toHaveClass('icon-pause')
    await expect(play).toHaveClass('icon-play')
    const seen = await played.jsonValue()
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0.39)
    expect(Math.max(...seen)).toBeLessThan(1.8)
    expect(Number(await seek.inputValue())).toBeGreaterThanOrEqual(1.59)
  }

  // A grip drags to the start of the clip and shows the frame there; a
  // grip dragged past the other stops a second short of it. Each drag
  // is one undo step.
  await dismissToast(page)
  const box = (await bar.boundingBox())!
  const middle = box.y + box.height / 2
  const at = (share: number) => box.x + 2 + (box.width - 4) * share
  const drag = async (from: number, to: number) => {
    await page.mouse.move(at(from), middle)
    await page.mouse.down()
    await page.mouse.move(at((from + to) / 2), middle, { steps: 4 })
    await page.mouse.move(at(to), middle, { steps: 4 })
    await page.mouse.up()
  }
  await drag(0.2, -0.1)
  await expect(markIn).toHaveValue('0')
  await expect(seek).toHaveValue('0')
  await expect(trimmed).toHaveText('Trimmed to 0:02')
  await drag(0.8, 0)
  await expect(markOut).toHaveValue('1')
  await expect(seek).toHaveValue('1')
  await page.keyboard.press('Control+z')
  await expect(markOut).toHaveValue('1.6')
  await page.keyboard.press('Control+z')
  await expect(markIn).toHaveValue('0.4')

  // Reset trim is one undo step too.
  await reset.click()
  await expect(trimmed).toHaveCount(0)
  await expect(reset).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(trimmed).toHaveText('Trimmed to 0:01')

  // Copy and paste settings leave the trims alone.
  await page.keyboard.press('Control+Shift+c')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.editor-name')).
    toHaveText('VID_20240108_093000.mp4')
  await page.keyboard.press('Control+Shift+v')
  await expect(trimmed).toHaveCount(0)
  await page.keyboard.press('Control+Shift+c')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Control+Shift+v')
  await expect(trimmed).toHaveText('Trimmed to 0:01')

  // On a photo the keys do nothing.
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.editor-name')).toHaveText('e2e-a.jpg')
  await page.keyboard.press('i')
  await expect(page.locator('.dialog')).toBeHidden()

  // The grid shows the trimmed length, also after a reload.
  await page.keyboard.press('Escape')
  const label = cell(page, 'clip.mp4').locator('.cell-video')
  await expect(label).toHaveText('0:01')
  await saved(page)
  await page.reload()
  await expect(label).toHaveText('0:01')

  await page.keyboard.press('?')
  await expect(shortcut(page, 'I / O on a video')).toHaveText('Mark in / out')
  await expect(shortcut(page, '0 to 9 on a video')).
    toHaveText('Jump to 0 % ... 90 %')
})

test('corrects the capture time of a group', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg'])

  // a and b were taken a day apart by a camera with a wrong clock.
  await cell(page, 'e2e-b.jpg').click()
  await cell(page, 'e2e-a.jpg').click({ modifiers: ['Control'] })
  await page.getByRole('button', { name: 'Adjust date' }).click()
  const dialog = page.locator('.dialog')
  await expect(dialog).toContainText('e2e-a.jpg')
  await dialog.locator('input[type="datetime-local"]').
    fill('2026-05-31T15:31')
  await expect(dialog).toContainText('+881 days 5 h 31 min')
  await dialog.getByRole('button', { name: 'Apply' }).click()

  // Sorted by date, both now come after c, still a day apart.
  const order = ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg']
  await expect(names(page)).toHaveText(['e2e-c.jpg', 'e2e-a.jpg', 'e2e-b.jpg'])
  await page.keyboard.press('Control+z')
  await expect(names(page)).toHaveText(order)
  await page.keyboard.press('Control+Shift+z')

  // Exports carry the corrected time.
  await cell(page, 'e2e-b.jpg').click()
  await page.keyboard.press('g')
  await pickAlbum(page, 'Fixed')
  await page.locator('.nav-item', { hasText: 'Fixed' }).click()
  await exportAlbum(page, async () => {})
  const file = ['library', 'Exports', 'Fixed', 'Fixed-001.jpg']
  const bytes = await readFile(page, file)
  expect(exifTags(bytes).get('exif.0x9003')).toBe('2026:06:01 15:31:00')
})

test('dates photos that had none, keeping their order', async ({ page }) => {
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'plain.jpg', 'zero-date.jpg'])
  await expect(names(page)).
    toHaveText(['e2e-a.jpg', 'plain.jpg', 'zero-date.jpg'])

  await cell(page, 'plain.jpg').click()
  await cell(page, 'zero-date.jpg').click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: 'Adjust date' }).click()
  const dialog = page.locator('.dialog')
  // The time entered is the first selected one's; the rest count
  // forward from it.
  await expect(dialog).toContainText('plain.jpg has no date')
  await dialog.locator('input[type="datetime-local"]').
    fill('2023-12-31T23:59')
  await expect(dialog).toContainText('1 more follows one second apart')
  await dialog.getByRole('button', { name: 'Apply' }).click()

  // Both now come before e2e-a, still in their order.
  await expect(names(page)).
    toHaveText(['plain.jpg', 'zero-date.jpg', 'e2e-a.jpg'])

  // The photo without any EXIF gets the date written on export.
  await cell(page, 'plain.jpg').click()
  await page.keyboard.press('g')
  await pickAlbum(page, 'Dated')
  await page.locator('.nav-item', { hasText: 'Dated' }).click()
  await exportAlbum(page, async () => {})
  const file = ['library', 'Exports', 'Dated', 'Dated-001.jpg']
  const bytes = await readFile(page, file)
  expect(exifTags(bytes).get('exif.0x9003')).toBe('2023:12:31 23:59:00')
})

// ─── Rename ──────────────────────────────────────────────────────────

function renameField(page: Page) {
  return page.locator('.dialog [data-field="pattern"]')
}

function chip(page: Page, name: string) {
  return page.locator('.dialog').getByRole('button', { name, exact: true })
}

async function cursor(page: Page) {
  return renameField(page).evaluate((el: HTMLInputElement) => {
    return [el.selectionStart, el.selectionEnd]
  })
}

test('renames the selection with placeholders', async ({ page }) => {
  const order = ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg', 'clip.mp4']
  const dialog = page.locator('.dialog')
  const field = renameField(page)
  const start = dialog.locator('[data-field="start"]')
  const preview = dialog.locator('.form-note')
  await openLibrary(page)
  await importPhotos(page, order)
  await expect(names(page)).toHaveText(order)

  // With nothing selected R opens nothing, so ? still opens the list.
  await page.keyboard.press('r')
  await page.keyboard.press('?')
  await expect(page.locator('.dialog-title')).toHaveText('Keyboard shortcuts')
  await page.keyboard.press('Escape')

  // Several photos elsewhere keep their names, selected so typing
  // replaces them; Start at waits for a number.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('r')
  await expect(page.locator('.dialog-title')).toHaveText('Rename 4 photos')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('{name}')
  await expect(preview).toHaveText('e2e-a.jpg to clip.mp4')
  await expect(start).toHaveCount(0)
  await page.keyboard.type('Trip ')
  await expect(field).toHaveValue('Trip ')

  // Insert types at the cursor and hands the field back.
  await chip(page, 'Number').click()
  await expect(field).toHaveValue('Trip {number}')
  await expect(field).toBeFocused()
  expect(await cursor(page)).toEqual([13, 13])
  await expect(start).toHaveValue('1')
  await expect(preview).toHaveText('Trip 001.jpg to Trip 004.mp4')

  // Numbers count from Start at in the order shown; Enter renames.
  await start.fill('9')
  await expect(preview).toHaveText('Trip 009.jpg to Trip 012.mp4')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page.locator('.toast')).toHaveText('Renamed 4 photos.')
  await expect(names(page)).toHaveText([
    'Trip 009.jpg', 'Trip 010.jpg', 'Trip 011.jpg', 'Trip 012.mp4'
  ])

  // One Ctrl+Z takes the whole rename back.
  await page.keyboard.press('Control+z')
  await expect(names(page)).toHaveText(order)
})

test('fills in dates, times and names, typed or inserted', async ({ page }) => {
  const dialog = page.locator('.dialog')
  const field = renameField(page)
  const preview = dialog.locator('.form-note')
  const rename = dialog.getByRole('button', { name: 'Rename' })
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg'])
  await cell(page, 'e2e-a.jpg').click()
  await cell(page, 'e2e-b.jpg').click({ modifiers: ['Control'] })
  await page.keyboard.press('r')
  await expect(field).toBeFocused()

  await page.keyboard.press('End')
  await page.keyboard.type('_')
  await chip(page, 'Time').click()
  await expect(field).toHaveValue('{name}_{time}')
  await expect(preview).
    toHaveText('e2e-a_10-00-00.jpg to e2e-b_10-00-00.jpg')

  // Over a selection the token replaces it.
  await field.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 6))
  await chip(page, 'Date').click()
  await expect(field).toHaveValue('{date}_{time}')
  await expect(field).toBeFocused()
  expect(await cursor(page)).toEqual([6, 6])
  await expect(preview).
    toHaveText('2024-01-01_10-00-00.jpg to 2024-01-02_10-00-00.jpg')

  // Typed by hand they work the same; equal names get -2, and unknown
  // braces stay.
  await field.fill('{time}')
  await expect(preview).toHaveText('10-00-00.jpg to 10-00-00-2.jpg')
  await field.fill('{foo}')
  await expect(preview).toHaveText('{foo}.jpg to {foo}-2.jpg')

  // A blank name greys Rename, and Enter leaves the dialog open.
  await field.fill('  ')
  await expect(rename).toBeDisabled()
  await expect(preview).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()

  // Down reaches the Insert buttons; Enter on one inserts.
  await field.fill('')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
  await expect(chip(page, 'Original name')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(field).toHaveValue('{name}')
  await expect(field).toBeFocused()
  await expect(rename).toBeEnabled()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(names(page)).toHaveText(['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg'])
})

test('renames in an album and in the editor', async ({ page }) => {
  const dialog = page.locator('.dialog')
  const title = page.locator('.dialog-title')
  const field = renameField(page)
  const toast = page.locator('.toast')
  const name = page.locator('.editor-name')
  const folder = page.locator('.sidebar-folder')
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg', 'e2e-c.jpg'])
  await page.keyboard.press('Control+a')
  await page.keyboard.press('g')
  await pickAlbum(page, 'Moorea')
  await page.locator('.nav-item', { hasText: 'Moorea' }).click()

  // Several photos in an album get its name and a number.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('r')
  await expect(field).toHaveValue('Moorea-{number}')
  await expect(dialog.locator('.form-note')).
    toHaveText('Moorea-001.jpg to Moorea-003.jpg')
  await page.keyboard.press('Enter')
  await expect(toast).toHaveText('Renamed 3 photos.')
  await expect(names(page)).
    toHaveText(['Moorea-001.jpg', 'Moorea-002.jpg', 'Moorea-003.jpg'])

  // One photo starts from its name without the extension.
  await cell(page, 'Moorea-002.jpg').click()
  await page.keyboard.press('r')
  await expect(title).toHaveText('Rename 1 photo')
  await expect(field).toHaveValue('Moorea-002')
  await expect(dialog.locator('.form-note')).toHaveText('Moorea-002.jpg')
  await page.keyboard.press('Escape')

  // R in the editor renames the photo shown.
  await cell(page, 'Moorea-001.jpg').dblclick()
  await expect(name).toHaveText('Moorea-001.jpg')
  await page.keyboard.press('r')
  await expect(title).toHaveText('Rename 1 photo')
  await expect(field).toBeFocused()
  await page.keyboard.type('Beach')
  await page.keyboard.press('Enter')
  await expect(name).toHaveText('Beach.jpg')
  await expect(toast).toHaveText('Renamed 1 photo.')

  // A rename that changes no name saves nothing, and Ctrl+Z takes back
  // the rename before. The editor hides the sidebar, so the save flag
  // is read as an attribute.
  await expect(folder).toHaveAttribute('data-saved', 'true')
  await dismissToast(page)
  await page.keyboard.press('r')
  await expect(field).toHaveValue('Beach')
  await page.keyboard.press('Enter')
  await expect(toast).toHaveText('Renamed 1 photo.')
  expect(await folder.getAttribute('data-saved')).toBe('true')
  await page.keyboard.press('Control+z')
  await expect(name).toHaveText('Moorea-001.jpg')
})

// The description the shortcut list gives a key.
function shortcut(page: Page, keys: string) {
  const hasText = new RegExp(`^${keys}$`)
  const term = page.locator('.shortcuts dt', { hasText })
  return term.locator('xpath=following-sibling::dd[1]')
}

test('moves crop and straighten to C', async ({ page }) => {
  const app = page.locator('.app')
  const title = page.locator('.dialog-title')
  await openLibrary(page)
  await importPhotos(page, ['e2e-a.jpg', 'e2e-b.jpg'])
  await cell(page, 'e2e-a.jpg').dblclick()
  await expect(page.locator('.stage')).not.toHaveClass(/loading/)
  await expect(page.getByTitle('Crop and straighten (C)')).toBeVisible()

  // R in the crop tool does nothing, so C still leaves it.
  await page.keyboard.press('c')
  await expect(app).toHaveAttribute('data-mode', 'crop')
  await page.keyboard.press('r')
  await page.keyboard.press('c')
  await expect(app).toHaveAttribute('data-mode', 'edit')
  await expect(page.locator('.dialog')).toBeHidden()

  await page.keyboard.press('?')
  await expect(shortcut(page, 'C')).toHaveText('Crop and straighten')
  await expect(shortcut(page, 'R')).
    toHaveText('Rename the selection or the open photo')
  await page.keyboard.press('Escape')

  // In the Trash R opens nothing, in the grid or the editor.
  await page.keyboard.press('Escape')
  await expect(app).toHaveAttribute('data-mode', 'grid')
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('Delete')
  await page.locator('.nav-item', { hasText: 'Trash' }).click()
  await cell(page, 'e2e-a.jpg').click()
  await page.keyboard.press('r')
  await page.keyboard.press('?')
  await expect(title).toHaveText('Keyboard shortcuts')
  await page.keyboard.press('Escape')
  await cell(page, 'e2e-a.jpg').dblclick()
  await expect(page.locator('.editor-name')).toHaveText('e2e-a.jpg')
  await page.keyboard.press('r')
  await page.keyboard.press('?')
  await expect(title).toHaveText('Keyboard shortcuts')
})
