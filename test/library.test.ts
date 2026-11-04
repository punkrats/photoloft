import { describe, expect, it } from 'vitest'
import {
  addPhotos, addToAlbum, albumsByName, createAlbum, deleteAlbum,
  emptyLibrary, emptyTrash, libraryCounts, migrate, moveInAlbum, pickLibrary,
  removeFromAlbum, renameAlbum, renamePhoto, restorePhotos,
  setAlbumExportName, setAlbumSort, setEdits, setLastImport, setMeta,
  setPhotoSizes, retime, toggleStars, trashPhotos, viewPhotos,
  albumSections, notInAlbums, type Library, type Photo
} from '../src/library'
import { NEUTRAL_EDIT } from '../src/schema'

function photo(id: string, extra: Partial<Photo> = {}): Photo {
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
    bytes: 1000,
    video: null,
    meta: {},
    ...extra
  }
}

function sample(): Library {
  const at = (day: string) => `2024-${day}T10:00:00`
  const lib = addPhotos(emptyLibrary(), [
    photo('a', { takenAt: at('03-01'), name: 'zebra.jpg', bytes: 300 }),
    photo('b', { takenAt: at('01-01'), name: 'apple.jpg', bytes: 100 }),
    photo('c', { takenAt: null, name: 'Mango.jpg', bytes: 400 }),
    photo('d', { takenAt: at('02-01'), name: 'banana.jpg', bytes: 200 })
  ])
  return createAlbum(lib, 'al1', 'Rome')
}

function album(lib: Library, id = 'al1') {
  return lib.albums.find(a => a.id === id)!
}

describe('albums', () => {
  it('creates an empty album', () => {
    expect(album(sample())).toEqual({ id: 'al1', name: 'Rome', photos: [] })
  })

  it('adds photos once, in the given order', () => {
    let lib = addToAlbum(sample(), 'al1', ['c', 'a'])
    lib = addToAlbum(lib, 'al1', ['a', 'b'])
    expect(album(lib).photos).toEqual(['c', 'a', 'b'])
  })

  it('ignores unknown photo ids', () => {
    const lib = addToAlbum(sample(), 'al1', ['a', 'nope'])
    expect(album(lib).photos).toEqual(['a'])
  })

  it('adds only what the album lacks, once each', () => {
    const lib = addToAlbum(sample(), 'al1', ['b'])
    const next = addToAlbum(lib, 'al1', ['a', 'b', 'c', 'a'])
    expect(album(next).photos).toEqual(['b', 'a', 'c'])
  })

  it('returns the library itself when nothing is new', () => {
    const lib = addToAlbum(sample(), 'al1', ['a', 'b'])
    expect(addToAlbum(lib, 'al1', ['b', 'a'])).toBe(lib)
    expect(addToAlbum(lib, 'al1', ['nope'])).toBe(lib)
    expect(addToAlbum(lib, 'gone', ['c'])).toBe(lib)
  })

  it('removes photos from one album only', () => {
    let lib = createAlbum(sample(), 'al2', 'Paris')
    lib = addToAlbum(lib, 'al1', ['a', 'b'])
    lib = addToAlbum(lib, 'al2', ['a'])
    lib = removeFromAlbum(lib, 'al1', ['a'])
    expect(album(lib).photos).toEqual(['b'])
    expect(album(lib, 'al2').photos).toEqual(['a'])
  })

  it('renames, trimming the name', () => {
    const lib = renameAlbum(sample(), 'al1', '  Roma ')
    expect(album(lib).name).toBe('Roma')
  })

  it('keeps the old name when the new one is blank', () => {
    expect(album(renameAlbum(sample(), 'al1', '  ')).name).toBe('Rome')
  })

  it('deletes the album but keeps its photos and drops its record', () => {
    let lib = addToAlbum(sample(), 'al1', ['a'])
    lib = { ...lib, exports: { al1: { folder: 'Rome', files: ['x.jpg'] } } }
    lib = deleteAlbum(lib, 'al1')
    expect(lib.albums).toEqual([])
    expect(lib.photos.a).toBeDefined()
    expect(lib.exports).toEqual({})
  })

  it('remembers an export name only when it differs from the album', () => {
    let lib = setAlbumExportName(sample(), 'al1', 'Roma trip')
    expect(album(lib).exportName).toBe('Roma trip')

    lib = setAlbumExportName(lib, 'al1', 'Rome')
    expect('exportName' in album(lib)).toBe(false)

    lib = renameAlbum(lib, 'al1', 'Rome 2026')
    expect(album(lib).exportName ?? album(lib).name).toBe('Rome 2026')
  })

  it('lists albums A to Z, numbers naturally', () => {
    let lib = createAlbum(emptyLibrary(), '1', 'Trip 10')
    lib = createAlbum(lib, '2', 'trip 2')
    lib = createAlbum(lib, '3', 'Beach')
    expect(albumsByName(lib).map(a => a.name)).
      toEqual(['Beach', 'trip 2', 'Trip 10'])
  })
})

describe('moveInAlbum', () => {
  const base = () => addToAlbum(sample(), 'al1', ['a', 'b', 'c', 'd'])

  it('moves one photo forward', () => {
    const lib = moveInAlbum(base(), 'al1', ['a'], 3)
    expect(album(lib).photos).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves one photo backward', () => {
    const lib = moveInAlbum(base(), 'al1', ['d'], 1)
    expect(album(lib).photos).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves a selection as a block keeping its order', () => {
    const lib = moveInAlbum(base(), 'al1', ['d', 'a'], 2)
    expect(album(lib).photos).toEqual(['b', 'a', 'd', 'c'])
  })

  it('counts the drop position among visible photos only', () => {
    const lib = moveInAlbum(trashPhotos(base(), ['a'], 'now'), 'al1', ['d'], 1)
    expect(viewPhotos(lib, { kind: 'album', id: 'al1' }, 'date')).
      toEqual(['b', 'd', 'c'])
  })

  it('moves to the end', () => {
    const lib = moveInAlbum(base(), 'al1', ['a', 'b'], 4)
    expect(album(lib).photos).toEqual(['c', 'd', 'a', 'b'])
  })
})

describe('album sort', () => {
  const base = () => addToAlbum(sample(), 'al1', ['a', 'b', 'c', 'd'])
  const shown = (lib: Library) =>
    viewPhotos(lib, { kind: 'album', id: 'al1' }, 'name')

  it('keeps the custom order by default', () => {
    expect(shown(base())).toEqual(['a', 'b', 'c', 'd'])
    expect('sort' in album(base())).toBe(false)
  })

  it('sorts by date taken, undated last', () => {
    expect(shown(setAlbumSort(base(), 'al1', 'date'))).
      toEqual(['b', 'd', 'a', 'c'])
  })

  it('sorts by name, ignoring case', () => {
    expect(shown(setAlbumSort(base(), 'al1', 'name'))).
      toEqual(['b', 'd', 'c', 'a'])
  })

  it('sorts by file size, largest first', () => {
    expect(shown(setAlbumSort(base(), 'al1', 'size'))).
      toEqual(['c', 'a', 'd', 'b'])
  })

  it('places photos added later by the sort', () => {
    let lib = addToAlbum(sample(), 'al1', ['a', 'c'])
    lib = setAlbumSort(lib, 'al1', 'date')
    lib = addToAlbum(lib, 'al1', ['b'])
    expect(shown(lib)).toEqual(['b', 'a', 'c'])
  })

  it('returns to the custom order untouched', () => {
    let lib = setAlbumSort(base(), 'al1', 'name')
    lib = setAlbumSort(lib, 'al1', 'custom')
    expect(shown(lib)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('turns custom when reordered by hand, starting from what is shown', () => {
    let lib = setAlbumSort(base(), 'al1', 'date')
    lib = moveInAlbum(lib, 'al1', ['c'], 0)
    expect(shown(lib)).toEqual(['c', 'b', 'd', 'a'])
    expect(album(lib).sort).toBeUndefined()
  })
})

describe('photos', () => {
  it('renames a photo, keeping the old name when blank', () => {
    let lib = renamePhoto(sample(), 'a', ' Sunset ')
    expect(lib.photos.a.name).toBe('Sunset')
    lib = renamePhoto(lib, 'a', '')
    expect(lib.photos.a.name).toBe('Sunset')
  })

  it('sets edits on several photos and leaves others untouched', () => {
    const before = sample()
    const lib = setEdits(before, ['a', 'b'], e => ({ ...e, exposure: 1 }))
    expect(lib.photos.a.edit.exposure).toBe(1)
    expect(lib.photos.b.edit.exposure).toBe(1)
    expect(lib.photos.c).toBe(before.photos.c)
  })

  it('never mutates the input library', () => {
    const before = sample()
    const snapshot = JSON.stringify(before)
    addToAlbum(before, 'al1', ['a'])
    setEdits(before, ['a'], e => ({ ...e, exposure: 1 }))
    trashPhotos(before, ['a'], 'now')
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('last import', () => {
  it('remembers what an import added, kept when nothing was new', () => {
    let lib = setLastImport(sample(), ['a', 'c'])
    expect(lib.lastImport).toEqual(['a', 'c'])
    lib = setLastImport(lib, [])
    expect(lib.lastImport).toEqual(['a', 'c'])
  })

  it('lists the last import sorted, without trashed photos', () => {
    let lib = setLastImport(sample(), ['a', 'b', 'c'])
    lib = trashPhotos(lib, ['c'], 'now')
    expect(viewPhotos(lib, { kind: 'import' }, 'date')).toEqual(['b', 'a'])
    expect(libraryCounts(lib).import).toBe(2)
  })

  it('finds the photos that sit in no album', () => {
    const lib = addToAlbum(sample(), 'al1', ['b'])
    expect(notInAlbums(lib, ['a', 'b', 'c'])).toEqual(['a', 'c'])
  })
})

describe('in albums', () => {
  const two = () => {
    let lib = createAlbum(sample(), 'al2', 'Atlantic')
    lib = addToAlbum(lib, 'al1', ['c', 'a'])
    lib = addToAlbum(lib, 'al2', ['a', 'd'])
    return setAlbumSort(lib, 'al2', 'name')
  }

  it('groups photos by album, A to Z, each in its own order', () => {
    const sections = albumSections(two())
    expect(sections.map(s => s.album.name)).toEqual(['Atlantic', 'Rome'])
    expect(sections.map(s => s.ids)).toEqual([['d', 'a'], ['c', 'a']])
  })

  it('lists every album photo in that order, repeats included', () => {
    expect(viewPhotos(two(), { kind: 'albums' }, 'date')).
      toEqual(['d', 'a', 'c', 'a'])
    expect(libraryCounts(two()).inAlbums).toBe(3)
  })
})

describe('retime', () => {
  const undated = () => addPhotos(sample(), [
    photo('u1'), photo('u2'), photo('u3')
  ])
  const times = (lib: Library, ids: string[]) =>
    ids.map(id => lib.photos[id].takenAt)

  it('moves dated photos by the reference gap and leaves others alone', () => {
    const before = sample()
    const lib = retime(before, ['b', 'a'], 'b', '2024-01-01T11:00:00')
    expect(times(lib, ['a', 'b'])).
      toEqual(['2024-03-01T11:00:00', '2024-01-01T11:00:00'])
    expect(lib.photos.d).toBe(before.photos.d)
  })

  it('dates undated photos one second apart in the order given', () => {
    const ids = ['u1', 'u2', 'u3']
    const lib = retime(undated(), ids, 'u2', '2026-05-31T15:31:10')
    expect(times(lib, ids)).toEqual([
      '2026-05-31T15:31:09', '2026-05-31T15:31:10', '2026-05-31T15:31:11'
    ])
  })

  it('places undated photos around a dated reference', () => {
    const lib = retime(undated(), ['b', 'u1'], 'b', '2026-05-31T15:31:00')
    expect(times(lib, ['b', 'u1'])).
      toEqual(['2026-05-31T15:31:00', '2026-05-31T15:31:01'])
  })

  it('keeps dated photos when the reference had no date', () => {
    const lib = retime(undated(), ['a', 'u1'], 'u1', '2026-05-31T15:31:00')
    expect(times(lib, ['a', 'u1'])).
      toEqual(['2024-03-01T10:00:00', '2026-05-31T15:31:00'])
  })
})

describe('setMeta', () => {
  const rome = { lat: 41.9, lon: 12.5 }
  const tagged = () => addPhotos(sample(), [
    photo('m1', { meta: { title: 'Old', author: 'Ann', location: rome } }),
    photo('m2', { meta: { title: 'Other', keywords: ['sea'] } })
  ])

  it('sets, removes and keeps each field on every photo given', () => {
    const lib = setMeta(tagged(), ['m1', 'm2'], {
      title: { set: 'Matira' }, keywords: 'remove'
    })
    expect(lib.photos.m1.meta).
      toEqual({ title: 'Matira', author: 'Ann', location: rome })
    expect(lib.photos.m2.meta).toEqual({ title: 'Matira' })
  })

  it('tells no location apart from the camera location', () => {
    let lib = setMeta(tagged(), ['m1'], { location: { set: null } })
    expect(lib.photos.m1.meta.location).toBeNull()
    lib = setMeta(lib, ['m1'], { location: 'remove' })
    expect('location' in lib.photos.m1.meta).toBe(false)
  })

  it('trims text and removes a field set to nothing', () => {
    const lib = setMeta(tagged(), ['m1'], {
      title: { set: '  ' }, description: { set: ' At dusk ' }
    })
    expect(lib.photos.m1.meta.title).toBeUndefined()
    expect(lib.photos.m1.meta.description).toBe('At dusk')
  })

  it('cleans keywords: trimmed, without blanks or repeats', () => {
    const keywords = [' beach', '', 'Bora Bora ', 'beach', '  ']
    const lib = setMeta(tagged(), ['m1'], { keywords: { set: keywords } })
    expect(lib.photos.m1.meta.keywords).toEqual(['beach', 'Bora Bora'])
    const none = setMeta(lib, ['m1'], { keywords: { set: [' ', ''] } })
    expect(none.photos.m1.meta.keywords).toBeUndefined()
  })

  it('copies only the photos that change', () => {
    const before = tagged()
    const lib = setMeta(before, ['m1', 'm2'], { author: { set: 'Ann' } })
    expect(lib.photos.m1).toBe(before.photos.m1)
    expect(lib.photos.m2.meta.author).toBe('Ann')
  })

  it('returns the same library when nothing changes', () => {
    const before = tagged()
    expect(setMeta(before, ['m1'], { title: { set: 'Old' } })).toBe(before)
    expect(setMeta(before, ['m2'], { author: 'remove' })).toBe(before)
    expect(setMeta(before, ['nope'], { title: { set: 'X' } })).toBe(before)
  })

  it('remembers the author and copyright it sets', () => {
    let lib = setMeta(tagged(), ['m2'], {
      author: { set: ' Ann ' }, copyright: { set: '(c) 2026 Ann' }
    })
    expect(lib.metaDefaults).
      toEqual({ author: 'Ann', copyright: '(c) 2026 Ann' })

    lib = setMeta(lib, ['m1', 'm2'], { author: 'remove' })
    expect(lib.metaDefaults.author).toBe('Ann')
  })

  it('never mutates the input library', () => {
    const before = tagged()
    const snapshot = JSON.stringify(before)
    setMeta(before, ['m1', 'm2'], {
      title: { set: 'New' }, location: { set: null }, author: { set: 'Bo' }
    })
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('stars', () => {
  it('stars all when any is unstarred, else clears all', () => {
    let lib = toggleStars(sample(), ['a', 'b'])
    expect([lib.photos.a.starred, lib.photos.b.starred]).toEqual([true, true])

    lib = toggleStars(lib, ['b', 'c'])
    expect([lib.photos.b.starred, lib.photos.c.starred]).toEqual([true, true])

    lib = toggleStars(lib, ['a', 'b', 'c'])
    expect(Object.values(lib.photos).some(p => p.starred)).toBe(false)
  })

  it('lists starred photos in their own view, sorted, without trash', () => {
    let lib = toggleStars(sample(), ['a', 'b', 'c'])
    lib = trashPhotos(lib, ['c'], 'now')
    expect(viewPhotos(lib, { kind: 'starred' }, 'date')).toEqual(['b', 'a'])
    expect(libraryCounts(lib).starred).toBe(2)
  })
})

describe('trash', () => {
  it('hides trashed photos from views and albums, restore brings back', () => {
    let lib = addToAlbum(sample(), 'al1', ['a', 'b'])
    lib = trashPhotos(lib, ['a'], '2026-11-02T10:00:00')
    expect(viewPhotos(lib, { kind: 'album', id: 'al1' }, 'date')).
      toEqual(['b'])
    expect(viewPhotos(lib, { kind: 'trash' }, 'date')).toEqual(['a'])
    lib = restorePhotos(lib, ['a'])
    expect(viewPhotos(lib, { kind: 'album', id: 'al1' }, 'date')).
      toEqual(['a', 'b'])
  })

  it('empties the trash and reports the removed ids', () => {
    let lib = addToAlbum(sample(), 'al1', ['a', 'b'])
    lib = trashPhotos(lib, ['a', 'c'], 'now')
    const { library, removed } = emptyTrash(lib)
    expect(removed.sort()).toEqual(['a', 'c'])
    expect(Object.keys(library.photos).sort()).toEqual(['b', 'd'])
    expect(album(library).photos).toEqual(['b'])
  })
})

describe('viewPhotos', () => {
  it('lists all photos by date, undated last', () => {
    expect(viewPhotos(sample(), { kind: 'all' }, 'date')).
      toEqual(['b', 'd', 'a', 'c'])
  })

  it('lists all photos by file size, largest first', () => {
    expect(viewPhotos(sample(), { kind: 'all' }, 'size')).
      toEqual(['c', 'a', 'd', 'b'])
  })

  it('records file sizes found later', () => {
    const lib = setPhotoSizes(sample(), { a: 5, nope: 7 })
    expect(lib.photos.a.bytes).toBe(5)
    expect(lib.photos.nope).toBeUndefined()
  })

  it('lists all photos by name', () => {
    expect(viewPhotos(sample(), { kind: 'all' }, 'name')).
      toEqual(['b', 'd', 'c', 'a'])
  })

  it('lists unsorted photos only', () => {
    const lib = addToAlbum(sample(), 'al1', ['a', 'b'])
    expect(viewPhotos(lib, { kind: 'unsorted' }, 'date')).toEqual(['d', 'c'])
  })

  it('keeps album order whatever the sort', () => {
    const lib = addToAlbum(sample(), 'al1', ['c', 'a'])
    expect(viewPhotos(lib, { kind: 'album', id: 'al1' }, 'name')).
      toEqual(['c', 'a'])
  })

  it('returns nothing for a missing album', () => {
    expect(viewPhotos(sample(), { kind: 'album', id: 'x' }, 'date')).
      toEqual([])
  })
})

describe('libraryCounts', () => {
  it('counts every view in one pass, ignoring trashed photos', () => {
    let lib = createAlbum(sample(), 'al2', 'Paris')
    lib = addToAlbum(lib, 'al1', ['a', 'b'])
    lib = addToAlbum(lib, 'al2', ['b'])
    lib = trashPhotos(lib, ['a', 'c'], 'now')
    expect(libraryCounts(lib)).toEqual({
      all: 2,
      unsorted: 1,
      starred: 0,
      trash: 2,
      import: 0,
      inAlbums: 1,
      albums: { al1: 1, al2: 1 }
    })
  })
})

describe('pickLibrary', () => {
  const saved = (seq: number, name: string) => {
    const lib = createAlbum(emptyLibrary(), 'x', name)
    return JSON.stringify({ ...lib, seq })
  }

  it('takes the copy with the highest sequence number', () => {
    const picked = pickLibrary([
      { name: 'library-1.json', text: saved(7, 'old') },
      { name: 'library-2.json', text: saved(8, 'new') }
    ])
    expect(picked!.seq).toBe(8)
    expect(picked!.library.albums[0].name).toBe('new')
  })

  it('skips a copy cut short by a crash', () => {
    const full = saved(8, 'new')
    const picked = pickLibrary([
      { name: 'library-1.json', text: saved(7, 'old') },
      { name: 'library-2.json', text: full.slice(0, full.length / 2) },
      { name: 'library-3.json', text: '' }
    ])
    expect(picked!.library.albums[0].name).toBe('old')
  })

  it('reads files without a sequence number as the oldest', () => {
    const legacy = JSON.stringify(createAlbum(emptyLibrary(), 'x', 'legacy'))
    const picked = pickLibrary([
      { name: 'library.json', text: legacy },
      { name: 'library-1.json', text: saved(1, 'current') }
    ])
    expect(picked!.library.albums[0].name).toBe('current')
  })

  it('returns null when nothing is readable', () => {
    expect(pickLibrary([{ name: 'a', text: '{"version' }])).toBeNull()
    expect(pickLibrary([])).toBeNull()
  })

  it('refuses data from a newer version instead of skipping it', () => {
    const newer = JSON.stringify({ version: 9, seq: 3 })
    expect(() => pickLibrary([{ name: 'a', text: newer }])).toThrow(/newer/)
  })
})

describe('migrate', () => {
  it('fills defaults on partial data', () => {
    const lib = migrate({ version: 1, photos: { a: { id: 'a' } } })
    expect(lib.photos.a.starred).toBe(false)
    expect(lib.photos.a.bytes).toBe(0)
    expect(lib.albums).toEqual([])
    expect(lib.photos.a.edit).toEqual(NEUTRAL_EDIT)
    expect(lib.exportSettings.quality).toBe(90)
  })

  it('keeps the last import, without ids of missing photos', () => {
    const raw = {
      version: 1, photos: { a: { id: 'a' } }, lastImport: ['a', 'gone']
    }
    expect(migrate(raw).lastImport).toEqual(['a'])
  })

  it('drops impossible capture dates', () => {
    const raw = {
      version: 1,
      photos: { a: { id: 'a', takenAt: '0000-00-00T00:00:00' } }
    }
    expect(migrate(raw).photos.a.takenAt).toBeNull()
  })

  it('reads stars saved under the older name', () => {
    const raw = { version: 1, photos: { a: { id: 'a', flagged: true } } }
    expect(migrate(raw).photos.a.starred).toBe(true)
  })

  it('keeps known edit values and drops unknown keys', () => {
    const raw = {
      version: 1,
      photos: { a: { id: 'a', edit: { exposure: 1.5, bogus: 3 } } }
    }
    const edit = migrate(raw).photos.a.edit
    expect(edit.exposure).toBe(1.5)
    expect('bogus' in edit).toBe(false)
  })

  it('drops album entries pointing to missing photos', () => {
    const raw = {
      version: 1,
      photos: { a: { id: 'a' } },
      albums: [{ id: 'x', name: 'X', photos: ['a', 'gone'] }]
    }
    expect(migrate(raw).albums[0].photos).toEqual(['a'])
  })

  it('gives photos without info an empty one', () => {
    const lib = migrate({ version: 1, photos: { a: { id: 'a' } } })
    expect(lib.photos.a.meta).toEqual({})
    expect(lib.metaDefaults).toEqual({})
  })

  it('keeps valid info and drops what is malformed', () => {
    const meta = {
      title: 'Matira',
      description: 7,
      keywords: ['beach', 3, ''],
      author: '',
      copyright: '(c) Ann',
      location: { lat: -16.5, lon: 'x' },
      bogus: true
    }
    const raw = { version: 1, photos: { a: { id: 'a', meta } } }
    expect(migrate(raw).photos.a.meta).
      toEqual({ title: 'Matira', keywords: ['beach'], copyright: '(c) Ann' })
  })

  it('keeps a location, and no location as null', () => {
    const at = { lat: -16.5004, lon: -151.7415 }
    const raw = {
      version: 1,
      photos: {
        a: { id: 'a', meta: { location: at } },
        b: { id: 'b', meta: { location: null } },
        c: { id: 'c', meta: { location: { lat: 95, lon: 0 } } }
      },
      metaDefaults: { author: 'Ann', copyright: 4 }
    }
    const lib = migrate(raw)
    expect(lib.photos.a.meta.location).toEqual(at)
    expect(lib.photos.b.meta.location).toBeNull()
    expect('location' in lib.photos.c.meta).toBe(false)
    expect(lib.metaDefaults).toEqual({ author: 'Ann' })
  })

  it('rejects data from a newer version', () => {
    expect(() => migrate({ version: 2 })).toThrow(/newer/)
  })
})
