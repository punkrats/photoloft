import { withBookkeeping, type Library } from './library'

// Library updates are immutable, so an undo entry is simply the
// previous Library; unchanged photos and albums are shared. Undo and
// redo step through the user's changes only: the Library they bring
// back takes the bookkeeping (`withBookkeeping`) of the one it replaces.
export type History = {
  past: Library[]
  future: Library[]
  tag: string | null
  at: number
}

const LIMIT = 200
const COALESCE_MS = 1500

export function emptyHistory(): History {
  return { past: [], future: [], tag: null, at: 0 }
}

export function recordChange(
  h: History, before: Library, tag: string | null, now: number
): History {
  const merge = tag !== null && tag === h.tag && now - h.at < COALESCE_MS
  const past = merge ? h.past : [...h.past, before].slice(-LIMIT)
  return { past, future: [], tag, at: now }
}

export function undo(h: History, current: Library) {
  const snapshot = h.past.at(-1)
  if (!snapshot) return null

  const history = {
    past: h.past.slice(0, -1),
    future: [current, ...h.future],
    tag: null,
    at: 0
  }
  return { history, library: withBookkeeping(snapshot, current) }
}

export function redo(h: History, current: Library) {
  const snapshot = h.future[0]
  if (!snapshot) return null

  const history = {
    past: [...h.past, current],
    future: h.future.slice(1),
    tag: null,
    at: 0
  }
  return { history, library: withBookkeeping(snapshot, current) }
}
