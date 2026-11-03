export const GAP = 8
export const PAD = 16
export const HEADER = 44
const MIN_CELL = 160
const OVERSCAN = 2

// A run of photos, with a header unless `title` is null. Photo indexes
// count across all sections in order.
export type Section = { title: string | null, count: number, key: string }

export type Row = {
  header: boolean
  y: number
  height: number
  section: number
  first: number
  last: number
}

export type GridLayout = {
  cols: number
  cell: number
  row: number
  rows: Row[]
  visible: Row[]
  total: number
}

type Rect = { x: number, y: number, w: number, h: number }

const EMPTY_ROW: Row = {
  header: false, y: PAD, height: 0, section: 0, first: 0, last: 0
}

export function plain(count: number): Section[] {
  return [{ title: null, count, key: 'all' }]
}

// Square cells in rows; each section starts a new row below its header.
// Only rows near the viewport are `visible`.
export function gridLayout(
  width: number, height: number, scroll: number, sections: Section[]
): GridLayout {
  const inner = Math.max(0, width - 2 * PAD)
  const cols = Math.max(1, Math.floor((inner + GAP) / (MIN_CELL + GAP)))
  const cell = Math.max(1, (inner - (cols - 1) * GAP) / cols)
  const row = cell + GAP

  const rows: Row[] = []
  let y = PAD
  let first = 0
  sections.forEach((s, section) => {
    if (s.count === 0) return
    if (s.title !== null) {
      const header = { header: true, y, height: HEADER, section, first }
      rows.push({ ...header, last: first })
      y += HEADER
    }
    for (let start = 0; start < s.count; start += cols) {
      const from = first + start
      const last = first + Math.min(s.count, start + cols)
      rows.push({ header: false, y, height: row, section, first: from, last })
      y += row
    }
    first += s.count
  })

  const top = scroll - OVERSCAN * row
  const bottom = scroll + height + OVERSCAN * row
  const visible = rows.filter(r => r.y + r.height > top && r.y < bottom)
  const total = rows.length ? y - GAP + PAD : 0
  return { cols, cell, row, rows, visible, total }
}

export function cellRect(g: GridLayout, index: number): Rect {
  const row = rowOf(g, index)
  const col = index - row.first
  const x = PAD + col * (g.cell + GAP)
  return { x, y: row.y, w: g.cell, h: g.cell }
}

export function cellsInRect(g: GridLayout, rect: Rect, count: number) {
  const hits: number[] = []
  const rows = g.rows.filter(r => {
    return !r.header && r.y < rect.y + rect.h && rect.y < r.y + g.cell
  })

  for (const row of rows) {
    for (let index = row.first; index < row.last && index < count; index++) {
      if (overlaps(cellRect(g, index), rect)) hits.push(index)
    }
  }
  return hits
}

// Index a dragged block lands before: the nearest gap between cells on
// the row under the pointer, or the first photo of a section when over
// its header.
export function insertionIndex(
  g: GridLayout, x: number, y: number, count: number
) {
  const above = g.rows.filter(r => r.y <= y)
  const row = above.at(-1)
  if (!row) return 0
  if (row.header) return row.first

  const col = Math.round((x - PAD + GAP / 2) / (g.cell + GAP))
  const index = row.first + clamp(col, 0, row.last - row.first)
  return Math.min(count, index)
}

function rowOf(g: GridLayout, index: number) {
  const cells = g.rows.filter(r => !r.header)
  let lo = 0
  let hi = cells.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (cells[mid].first <= index) lo = mid
    else hi = mid - 1
  }
  return cells[lo] ?? EMPTY_ROW
}

function overlaps(a: Rect, b: Rect) {
  const across = a.x < b.x + b.w && b.x < a.x + a.w
  return across && a.y < b.y + b.h && b.y < a.y + a.h
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}
