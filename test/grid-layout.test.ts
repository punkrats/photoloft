import { describe, expect, it } from 'vitest'
import {
  cellRect, cellsInRect, GAP, gridLayout, HEADER, insertionIndex, PAD,
  plain, type Section
} from '../src/grid-layout'

// 4 columns of 160 px: 16 + 4 * 160 + 3 * 8 + 16 = 696.
const width = 696

describe('gridLayout', () => {
  it('fits as many columns as the minimum cell size allows', () => {
    const g = gridLayout(width, 600, 0, plain(100))
    expect(g.cols).toBe(4)
    expect(g.cell).toBe(160)
    expect(g.row).toBe(160 + GAP)
  })

  it('keeps at least one column', () => {
    expect(gridLayout(50, 600, 0, plain(3)).cols).toBe(1)
  })

  it('renders only the rows near the viewport', () => {
    const g = gridLayout(width, 600, 168 * 10, plain(400))
    expect(g.visible[0].first).toBe(7 * 4)
    expect(g.visible.at(-1)!.last).toBeLessThan(25 * 4)
    expect(g.visible[0].y).toBe(PAD + 7 * 168)
  })

  it('reports the full height', () => {
    const total = gridLayout(width, 600, 0, plain(8)).total
    expect(total).toBe(2 * PAD + 2 * 168 - GAP)
    expect(gridLayout(width, 600, 0, plain(0)).total).toBe(0)
  })
})

describe('cellRect / cellsInRect', () => {
  const g = gridLayout(width, 600, 0, plain(10))

  it('places cells row by row', () => {
    const rect = { x: PAD + 168, y: PAD + 168, w: 160, h: 160 }
    expect(cellRect(g, 5)).toEqual(rect)
  })

  it('finds cells touched by a rectangle', () => {
    const hit = cellsInRect(g, { x: 100, y: 100, w: 200, h: 100 }, 10)
    expect(hit).toEqual([0, 1, 4, 5])
  })

  it('ignores gaps and the area past the last photo', () => {
    expect(cellsInRect(g, { x: 0, y: 0, w: 10, h: 10 }, 10)).toEqual([])
    const tail = cellsInRect(g, { x: 0, y: 350, w: 696, h: 100 }, 10)
    expect(tail).toEqual([8, 9])
  })
})

describe('insertionIndex', () => {
  const g = gridLayout(width, 600, 0, plain(10))

  it('drops before the nearest cell boundary', () => {
    expect(insertionIndex(g, PAD + 10, PAD + 10, 10)).toBe(0)
    expect(insertionIndex(g, PAD + 150, PAD + 10, 10)).toBe(1)
    expect(insertionIndex(g, PAD + 168 + 10, PAD + 180, 10)).toBe(5)
  })

  it('clamps to the end of the list', () => {
    expect(insertionIndex(g, 690, 590, 10)).toBe(10)
  })
})

describe('sections', () => {
  const sections: Section[] = [
    { title: 'Atlantic', count: 5, key: 'a' },
    { title: 'Empty', count: 0, key: 'e' },
    { title: 'Rome', count: 3, key: 'r' }
  ]
  const g = gridLayout(width, 600, 0, sections)
  const romeHeader = PAD + HEADER + 2 * 168

  it('starts each section on a new row under its header', () => {
    const rows = g.rows.map(r => [r.header, r.y, r.first, r.last])
    expect(rows).toEqual([
      [true, PAD, 0, 0],
      [false, PAD + HEADER, 0, 4],
      [false, PAD + HEADER + 168, 4, 5],
      [true, romeHeader, 5, 5],
      [false, romeHeader + HEADER, 5, 8]
    ])
    expect(g.total).toBe(romeHeader + HEADER + 168 - GAP + PAD)
  })

  it('places cells and finds them across sections', () => {
    expect(cellRect(g, 5)).toMatchObject({ x: PAD, y: romeHeader + HEADER })
    const rect = { x: 0, y: PAD + HEADER + 170, w: 150, h: 260 }
    expect(cellsInRect(g, rect, 8)).toEqual([4, 5])
  })

  it('drops onto a header before the first photo of its section', () => {
    expect(insertionIndex(g, 300, romeHeader + 5, 8)).toBe(5)
  })
})
