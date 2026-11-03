import { expect, test, type Page } from '@playwright/test'
import { PAD } from '../src/grid-layout'

const COUNT = 90

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

// Imports COUNT small photos named p000.jpg upwards, sorted by name, so
// the grid has many rows to scroll through.
async function importMany(page: Page) {
  await page.evaluate(async count => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('many', { create: true })
    for (let i = 0; i < count; i++) {
      const canvas = new OffscreenCanvas(32, 24)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = `hsl(${i * 4}, 60%, 50%)`
      ctx.fillRect(0, 0, 32, 24)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg' })
      const name = `p${String(i).padStart(3, '0')}.jpg`
      const handle = await dir.getFileHandle(name, { create: true })
      const stream = await handle.createWritable()
      await stream.write(blob)
      await stream.close()
    }
    (window as unknown as { importPath: string[] }).importPath = ['many']
  }, COUNT)
  const toolbar = page.locator('.toolbar')
  await toolbar.getByRole('button', { name: 'Import folder' }).click()
  await expect(page.locator('.toast')).
    toContainText(`Imported ${COUNT} photos`)
  await page.locator('[data-change="sort"]').selectOption('name')
}

function photo(index: number) {
  return `p${String(index).padStart(3, '0')}.jpg`
}

function cell(page: Page, name: string) {
  return page.locator('.cell', { hasText: name })
}

function grid(page: Page) {
  return page.locator('[data-grid]')
}

function scrollTop(page: Page) {
  return grid(page).evaluate(el => el.scrollTop)
}

// Lets pending scroll events, size observations and renders run.
async function frames(page: Page, count = 3) {
  await page.evaluate(async count => {
    for (let i = 0; i < count; i++) {
      await new Promise(done => requestAnimationFrame(done))
    }
  }, count)
}

// Scrolls the grid to `top` and clicks the first photo of the row in
// the middle of the view. Returns its index.
async function focusMiddle(page: Page, top: number) {
  await grid(page).evaluate((el, top) => {
    el.scrollTop = top
  }, top)
  await frames(page)
  const name = await grid(page).evaluate(el => {
    const box = el.getBoundingClientRect()
    const middle = box.top + el.clientHeight / 2
    const hit = [...el.querySelectorAll('.cell')].find(c => {
      const r = c.getBoundingClientRect()
      return r.top <= middle && middle <= r.bottom
    })
    return hit!.querySelector('.cell-file')!.textContent!.trim()
  })
  await cell(page, name).click()
  await frames(page)
  return Number(name.slice(1, 4))
}

function columns(page: Page) {
  return page.locator('.grid-inner').evaluate(el => {
    return Number(getComputedStyle(el).getPropertyValue('--cols'))
  })
}

// Space between the photo's cell and the top and bottom of the view.
function margins(page: Page, name: string) {
  return cell(page, name).evaluate(el => {
    const grid = el.closest('[data-grid]')!
    const top = grid.getBoundingClientRect().top
    const r = el.getBoundingClientRect()
    return { above: r.top - top, below: top + grid.clientHeight - r.bottom }
  })
}

async function mode(page: Page, value: string) {
  await expect(page.locator('.app')).toHaveAttribute('data-mode', value)
}

type Step = (page: Page, name: string) => Promise<unknown>

const space: Step = page => page.keyboard.press(' ')
const enter: Step = page => page.keyboard.press('Enter')
const escape: Step = page => page.keyboard.press('Escape')
const back: Step = page => page.locator('[data-action="close-editor"]').click()
const doubleClick: Step = (page, name) => cell(page, name).dblclick()

// ─── Flows ───────────────────────────────────────────────────────────

test('keeps its place after a photo was opened', async ({ page }) => {
  await openLibrary(page)
  await importMany(page)

  const ways: [string, Step, string, Step][] = [
    ['Space, then Space', space, 'edit', space],
    ['Space, then Esc', space, 'edit', escape],
    ['Space, then the back button', space, 'edit', back],
    ['Enter, then Esc', enter, 'edit', escape],
    ['double click, then the back button', doubleClick, 'edit', back]
  ]
  for (const [i, [label, open, opened, close]] of ways.entries()) {
    await test.step(label, async () => {
      const index = await focusMiddle(page, 500 + 120 * i)
      const top = await scrollTop(page)
      expect(top).toBeGreaterThan(0)

      await open(page, photo(index))
      await mode(page, opened)
      await expect(page.locator('.stage')).not.toHaveClass(/loading/)
      await close(page, photo(index))
      await mode(page, 'grid')
      await frames(page)

      await expect.poll(() => scrollTop(page)).toBe(top)
      await expect(cell(page, photo(index))).toBeInViewport({ ratio: 1 })
      await expect(page.locator('.cell.selected .cell-file')).
        toHaveText(photo(index))
    })
  }
})

test('scrolls only as far as the photo last viewed', async ({ page }) => {
  await openLibrary(page)
  await importMany(page)

  // A neighbour still in view leaves the grid where it was.
  let index = await focusMiddle(page, 800)
  let top = await scrollTop(page)
  await page.keyboard.press(' ')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.editor-name')).toHaveText(photo(index + 1))
  await page.keyboard.press(' ')
  await mode(page, 'grid')
  await frames(page)
  await expect.poll(() => scrollTop(page)).toBe(top)

  // A photo picked further down in the filmstrip ends up at the bottom
  // edge, one further up at the top edge.
  const rows = 3 * await columns(page)
  for (const [delta, edge] of [[rows, 'below'], [-rows, 'above']] as const) {
    index = await focusMiddle(page, 800)
    top = await scrollTop(page)
    const target = photo(index + delta)

    await page.keyboard.press('Enter')
    await mode(page, 'edit')
    await page.locator(`.film-item[title="${target}"]`).click()
    await expect(page.locator('.editor-name')).toHaveText(target)
    await page.keyboard.press('Escape')
    await mode(page, 'grid')
    await frames(page)

    await expect(cell(page, target)).toBeInViewport({ ratio: 1 })
    await expect.poll(async () => {
      return Math.abs((await margins(page, target))[edge] - PAD)
    }).toBeLessThanOrEqual(1)
    expect(await scrollTop(page)).not.toBe(top)
  }
})

test('keeps its place when the photo leaves the view', async ({ page }) => {
  await openLibrary(page)
  await importMany(page)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('s')
  await page.locator('.nav-item', { hasText: 'Starred' }).click()
  await expect(page.locator('.toolbar .toolbar-count')).
    toHaveText(`${COUNT} photos`)

  await focusMiddle(page, 500)
  const top = await scrollTop(page)
  await page.keyboard.press(' ')
  await mode(page, 'edit')
  await page.keyboard.press('s')
  await expect(page.locator('.editor-bar .toolbar-count')).
    toHaveText(`0 / ${COUNT - 1}`)
  await page.keyboard.press(' ')
  await mode(page, 'grid')
  await frames(page)

  await expect.poll(() => scrollTop(page)).toBe(top)
})
