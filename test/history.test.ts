import { describe, expect, it } from 'vitest'
import { emptyHistory, recordChange, redo, undo } from '../src/history'
import { createAlbum, emptyLibrary } from '../src/library'

const v0 = emptyLibrary()
const v1 = createAlbum(v0, '1', 'One')
const v2 = createAlbum(v1, '2', 'Two')

describe('history', () => {
  it('undoes and redoes in order', () => {
    let h = recordChange(emptyHistory(), v0, null, 0)
    h = recordChange(h, v1, null, 10)

    const back = undo(h, v2)!
    expect(back.library).toBe(v1)
    const back2 = undo(back.history, back.library)!
    expect(back2.library).toBe(v0)
    expect(undo(back2.history, back2.library)).toBeNull()

    const forward = redo(back2.history, back2.library)!
    expect(forward.library).toBe(v1)
    expect(redo(forward.history, forward.library)!.library).toBe(v2)
  })

  it('coalesces changes with the same tag in quick succession', () => {
    let h = recordChange(emptyHistory(), v0, 'edit:a:exposure', 0)
    h = recordChange(h, v1, 'edit:a:exposure', 500)
    expect(h.past).toEqual([v0])
  })

  it('starts a new entry after a pause or a different tag', () => {
    let h = recordChange(emptyHistory(), v0, 'edit:a:exposure', 0)
    h = recordChange(h, v1, 'edit:a:exposure', 5000)
    h = recordChange(h, v2, 'edit:a:contrast', 5100)
    expect(h.past).toEqual([v0, v1, v2])
  })

  it('never coalesces untagged changes', () => {
    let h = recordChange(emptyHistory(), v0, null, 0)
    h = recordChange(h, v1, null, 1)
    expect(h.past).toHaveLength(2)
  })

  it('drops the redo stack on a new change', () => {
    let h = recordChange(emptyHistory(), v0, null, 0)
    const back = undo(h, v1)!
    h = recordChange(back.history, v0, null, 10)
    expect(h.future).toEqual([])
  })

  it('caps the number of entries', () => {
    let h = emptyHistory()
    for (let i = 0; i < 250; i++) h = recordChange(h, v0, null, i)
    expect(h.past).toHaveLength(200)
  })
})
