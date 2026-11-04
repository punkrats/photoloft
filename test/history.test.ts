import { describe, expect, it } from 'vitest'
import { emptyHistory, recordChange, redo, undo } from '../src/history'
import {
  addPhotos, createAlbum, deleteAlbum, emptyLibrary, renameAlbum,
  setAlbumExportFolder, setAlbumExportName, setExportRecord,
  setExportSettings, setPhotoSizes, toggleStars, withBookkeeping,
  type Library, type Photo
} from '../src/library'
import { NEUTRAL_EDIT } from '../src/schema'

const v0 = emptyLibrary()
const v1 = createAlbum(v0, '1', 'One')
const v2 = createAlbum(v1, '2', 'Two')

const FIRST = { folder: 'Rome', files: ['Rome-001.jpg', 'Rome-002.jpg'] }
const SECOND = { folder: 'Rome', files: ['Rome-001.jpg'] }

// A photo whose size is not known yet.
function photo(id: string): Photo {
  return {
    id,
    name: `${id}.jpg`,
    takenAt: null,
    importedAt: '2026-01-01T00:00:00',
    width: 400,
    height: 300,
    edit: NEUTRAL_EDIT,
    trashedAt: null,
    starred: false,
    bytes: 0,
    video: null,
    meta: {}
  }
}

function rome(): Library {
  return createAlbum(addPhotos(emptyLibrary(), [photo('a')]), 'al1', 'Rome')
}

function exportName(lib: Library) {
  return lib.albums[0].exportName ?? lib.albums[0].name
}

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

describe('bookkeeping through undo and redo', () => {
  it('keeps the latest export record, settings and name', () => {
    const before = rome()
    const starred = toggleStars(before, ['a'])
    let exported = setExportRecord(starred, 'al1', FIRST)
    const settings = { ...exported.exportSettings, quality: 70 }
    exported = setExportSettings(exported, settings)
    exported = setAlbumExportName(exported, 'al1', 'Roma')
    const h = recordChange(emptyHistory(), before, null, 0)

    const back = undo(h, exported)!
    expect(back.library.photos.a.starred).toBe(false)
    expect(back.library.exports.al1).toBe(FIRST)
    expect(back.library.exportSettings).toBe(settings)
    expect(exportName(back.library)).toBe('Roma')

    const again = setExportRecord(back.library, 'al1', SECOND)
    const forward = redo(back.history, again)!
    expect(forward.library.photos.a.starred).toBe(true)
    expect(forward.library.exports.al1).toBe(SECOND)
    expect(forward.library.exportSettings).toBe(settings)
  })

  it('keeps sizes found since, for the photos the library holds', () => {
    const before = addPhotos(emptyLibrary(), [photo('a')])
    const imported = addPhotos(before, [photo('b')])
    const sized = setPhotoSizes(imported, { a: 100, b: 200 })
    const h = recordChange(emptyHistory(), before, null, 0)

    const back = undo(h, sized)!
    expect(back.library.photos.a.bytes).toBe(100)
    expect(back.library.photos.b).toBeUndefined()

    const resized = setPhotoSizes(back.library, { a: 150 })
    const forward = redo(back.history, resized)!
    expect(forward.library.photos.a.bytes).toBe(150)
    expect(forward.library.photos.b.bytes).toBe(200)
  })

  it('gives an album an undo brings back its own record', () => {
    const before = setExportRecord(rome(), 'al1', FIRST)
    const deleted = deleteAlbum(before, 'al1')
    const h = recordChange(emptyHistory(), before, null, 0)

    const back = undo(h, deleted)!
    expect(back.library.exports.al1).toBe(FIRST)
    const forward = redo(back.history, back.library)!
    expect(forward.library.exports).toEqual({})
  })

  it('drops the record of an album an undo removes until redo', () => {
    const before = addPhotos(emptyLibrary(), [photo('a')])
    const created = createAlbum(before, 'al1', 'Rome')
    const exported = setExportRecord(created, 'al1', FIRST)
    const h = recordChange(emptyHistory(), before, null, 0)

    const back = undo(h, exported)!
    expect(back.library.exports).toEqual({})
    const forward = redo(back.history, back.library)!
    expect(forward.library.exports.al1).toBe(FIRST)
  })

  it('keeps a typed export name through undo and redo of a rename', () => {
    const before = createAlbum(emptyLibrary(), 'al1', 'Roma')
    const renamed = renameAlbum(before, 'al1', 'Rome')
    const exported = setAlbumExportName(renamed, 'al1', 'Roma')
    const h = recordChange(emptyHistory(), before, null, 0)

    const back = undo(h, exported)!
    expect(exportName(back.library)).toBe('Roma')
    const forward = redo(back.history, back.library)!
    expect(forward.library.albums[0].name).toBe('Rome')
    expect(exportName(forward.library)).toBe('Roma')
  })

  it('keeps the folder picked for the exports through undo and redo', () => {
    const before = rome()
    const starred = toggleStars(before, ['a'])
    const picked = setAlbumExportFolder(starred, 'al1', 'Holiday')
    const h = recordChange(emptyHistory(), before, null, 0)

    const back = undo(h, picked)!
    expect(back.library.photos.a.starred).toBe(false)
    expect(back.library.albums[0].exportFolder).toBe('Holiday')

    const cleared = setAlbumExportFolder(back.library, 'al1', null)
    const forward = redo(back.history, cleared)!
    expect(forward.library.photos.a.starred).toBe(true)
    expect('exportFolder' in forward.library.albums[0]).toBe(false)
  })

  it('restores the snapshot itself when no bookkeeping changed', () => {
    const before = setPhotoSizes(rome(), { a: 100 })
    const starred = toggleStars(before, ['a'])
    const h = recordChange(emptyHistory(), before, null, 0)
    expect(undo(h, starred)!.library).toBe(before)
  })
})

describe('withBookkeeping', () => {
  it('takes the bookkeeping of the other library and nothing else', () => {
    const lib = rome()
    let next = setExportRecord(toggleStars(lib, ['a']), 'al1', FIRST)
    next = setPhotoSizes(next, { a: 100 })

    const kept = withBookkeeping(lib, next)
    expect(kept.exports.al1).toBe(FIRST)
    expect(kept.photos.a.bytes).toBe(100)
    expect(kept.photos.a.starred).toBe(false)
  })
})
