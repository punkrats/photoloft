import { expect, test, type Page } from '@playwright/test'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MEDIA_ROOT } from './media'

const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures')

// ─── Helpers ─────────────────────────────────────────────────────────

// The native folder picker cannot be driven, so it hands out a folder
// in the browser's private file system as the library.
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

// Connects a drive: a folder under the media folder the Photoloft
// service watches, holding fixtures at the paths given. Returns what
// pulls it out again.
function connect(name: string, files: Record<string, string>) {
  const root = join(MEDIA_ROOT, name)
  for (const [path, fixture] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(FIXTURES, fixture), target)
  }
  return () => rmSync(root, { recursive: true, force: true })
}

// Closes the message showing, if any, in one step in the page, as a
// message also closes by itself after 5 s.
async function dismissToast(page: Page) {
  const toast = page.locator('.toast')
  await toast.evaluateAll((found: HTMLElement[]) => {
    found.forEach(el => el.click())
  })
  await expect(toast).toBeHidden()
}

// ─── Flows ───────────────────────────────────────────────────────────

test('imports photos picked on a drive and marks them', async ({ page }) => {
  const name = `CARD-${test.info().workerIndex}-${Date.now()}`
  const drive = page.locator('.sidebar .nav-item', { hasText: name })
  const folders = page.locator('.drive-folder')
  const files = page.locator('.drive-file')
  const held = files.filter({ has: page.locator('.drive-held') })
  const count = page.locator('.selection-count')
  const toast = page.locator('.toast')
  await openLibrary(page)
  await expect(drive).toHaveCount(0)

  const pull = connect(name, {
    'DCIM/100TEST/P2.JPG': 'e2e-a.jpg',
    'DCIM/100TEST/P10.jpg': 'e2e-portrait.jpg',
    'DCIM/100TEST/C1.MOV': 'clip.mp4',
    'DCIM/100TEST/notes.png': 'not-a-jpeg.png',
    'DCIM/thumbs/T.jpg': 'e2e-c.jpg',
    '.Trashes/D.jpg': 'e2e-d.jpg',
    'MISC/B.jpg': 'e2e-b.jpg'
  })
  try {
    // The drive shows in the sidebar and opens at its top folder.
    await expect(drive).toBeVisible()
    await drive.click()
    await expect(page.locator('.drive-crumbs')).toHaveText(name)
    await expect(folders).toHaveText(['DCIM', 'MISC'])
    await expect(files).toHaveCount(0)

    // Photos and videos show in name order with thumbnails, the
    // sideways photo upright.
    await folders.filter({ hasText: 'DCIM' }).click()
    await expect(folders).toHaveText(['100TEST', 'thumbs'])
    await folders.filter({ hasText: '100TEST' }).click()
    await expect(page.locator('.drive-crumbs button')).
      toHaveText([name, 'DCIM', '100TEST'])
    await expect(files.locator('.drive-name')).
      toHaveText(['C1.MOV', 'P2.JPG', 'P10.jpg'])
    const portrait = files.filter({ hasText: 'P10.jpg' }).locator('img')
    await expect(portrait).toHaveJSProperty('complete', true)
    const shape = await portrait.evaluate((img: HTMLImageElement) => {
      return [img.naturalWidth, img.naturalHeight]
    })
    expect(shape[1]).toBeGreaterThan(0)
    expect(shape[0]).toBeGreaterThan(shape[1])

    // Ctrl+A picks every file, Esc none.
    await page.keyboard.press('Control+a')
    await expect(count).toHaveText('3 selected')
    await page.keyboard.press('Escape')
    await expect(count).toHaveCount(0)

    // Two picked go in and show as imported.
    await files.filter({ hasText: 'P2.JPG' }).click()
    await files.filter({ hasText: 'C1.MOV' }).click({ modifiers: ['Control'] })
    await expect(count).toHaveText('2 selected')
    await page.locator('[data-action="drive-import"]').click()
    await expect(toast).toContainText('Imported 2 photos.')
    await expect(held.locator('.drive-name')).toHaveText(['C1.MOV', 'P2.JPG'])
    await expect(count).toHaveCount(0)

    // Import folder at the top takes the rest. Imported, hidden and
    // cached files stay out; the PNG counts as skipped.
    await page.locator('.drive-crumbs button', { hasText: name }).click()
    await dismissToast(page)
    await page.locator('[data-action="drive-import-folder"]').click()
    await expect(toast).toContainText(
      'Imported 2 photos. 2 already imported. 1 skipped')
    await page.locator('.nav-item', { hasText: 'All photos' }).click()
    await expect(page.locator('.cell')).toHaveCount(4)

    // Pulling the drive takes it off the sidebar, and its view goes
    // back to All photos.
    await drive.click()
    await expect(folders).toHaveText(['DCIM', 'MISC'])
    await dismissToast(page)
    pull()
    await expect(drive).toHaveCount(0)
    await expect(page.locator('.toolbar-heading')).toHaveText('All photos')
    await expect(toast).toHaveText(`${name} was disconnected.`)
  } finally {
    pull()
  }
})
