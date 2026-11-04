import { describe, expect, it } from 'vitest'
import { emptyLibrary, migrate } from '../src/library'
import type { AlbumPick, Picker } from '../src/state'
import {
  newRename, pickerAdd, pickerRows, renameNames, toggledTicks
} from '../src/ui/dialogs'

// Keepers holds both photos asked about, Rome one of them, Atlantic
// none.
const LIB = migrate({
  photos: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
  albums: [
    { id: 'rome', name: 'Rome', photos: ['a', 'c'] },
    { id: 'keep', name: 'Keepers', photos: ['b', 'a'] },
    { id: 'atl', name: 'Atlantic', photos: [] }
  ]
})
const IDS = ['a', 'b']

function picker(query: string, ticked: AlbumPick[] = []): Picker {
  return { kind: 'picker', query, ticked, taken: null }
}

function names(query: string, ticked: AlbumPick[] = []) {
  return pickerRows(LIB, picker(query, ticked), IDS).map(row => row.name)
}

describe('pickerRows', () => {
  it('lists the albums A to Z; one holding every photo is held', () => {
    expect(pickerRows(LIB, picker(''), IDS)).toEqual([
      { pick: { id: 'atl' }, name: 'Atlantic', ticked: false, held: false },
      { pick: { id: 'keep' }, name: 'Keepers', ticked: true, held: true },
      { pick: { id: 'rome' }, name: 'Rome', ticked: false, held: false }
    ])
  })

  it('ticks the albums picked', () => {
    const rows = pickerRows(LIB, picker('', [{ id: 'rome' }]), IDS)
    expect(rows[2]).toMatchObject({ name: 'Rome', ticked: true, held: false })
  })

  it('filters by the typed text, case ignored', () => {
    expect(names('E')).toEqual(['Keepers', 'Rome', 'E'])
  })

  it('offers the typed name when no row has it exactly', () => {
    expect(pickerRows(LIB, picker(' Moorea '), IDS)).toEqual([
      { pick: { name: 'Moorea' }, name: 'Moorea', ticked: false, held: false }
    ])
    expect(names('rome')).toEqual(['Rome'])
    expect(names('Rom')).toEqual(['Rome', 'Rom'])
  })

  it('lists ticked new albums after the albums while they match', () => {
    const ticked = [{ name: 'Moorea' }, { id: 'rome' }]
    const rows = pickerRows(LIB, picker('', ticked), IDS)
    expect(rows.map(row => [row.name, row.ticked])).toEqual([
      ['Atlantic', false], ['Keepers', true], ['Rome', true], ['Moorea', true]
    ])
    expect(rows[3].pick).toEqual({ name: 'Moorea' })

    expect(names('moo', ticked)).toEqual(['Moorea', 'moo'])
    expect(names('MOOREA', ticked)).toEqual(['Moorea'])
    expect(names('Atlantic', ticked)).toEqual(['Atlantic'])
  })

  it('has no rows without albums or text', () => {
    expect(pickerRows(emptyLibrary(), picker(''), IDS)).toEqual([])
  })
})

describe('toggledTicks', () => {
  const ticked = [{ id: 'rome' }, { name: 'Moorea' }]

  it('adds a row to the end of the ticks', () => {
    expect(toggledTicks(LIB, picker('', ticked), IDS, 0)).
      toEqual([...ticked, { id: 'atl' }])
    expect(toggledTicks(LIB, picker(' Bora '), IDS, 0)).
      toEqual([{ name: 'Bora' }])
  })

  it('unticks an album by id and a new one by name, case ignored', () => {
    expect(toggledTicks(LIB, picker('', ticked), IDS, 2)).
      toEqual([{ name: 'Moorea' }])
    expect(toggledTicks(LIB, picker('MOOREA', ticked), IDS, 0)).
      toEqual([{ id: 'rome' }])
  })

  it('leaves a held album and a missing row alone', () => {
    expect(toggledTicks(LIB, picker('', ticked), IDS, 1)).toBeNull()
    expect(toggledTicks(LIB, picker('', ticked), IDS, 9)).toBeNull()
  })
})

describe('pickerAdd', () => {
  const add = (query: string, ticked: AlbumPick[] = []) =>
    pickerAdd(LIB, picker(query, ticked))

  it('adds nothing without ticks or text; held albums do not count', () => {
    expect(add('')).toEqual({ picks: [], taken: null })
    expect(add('  ')).toEqual({ picks: [], taken: null })
  })

  it('adds to the ticked albums when the field is empty', () => {
    const ticked = [{ id: 'rome' }, { name: 'Moorea' }]
    expect(add('', ticked)).toEqual({ picks: ticked, taken: null })
  })

  it('adds the typed name as a new album after the ticked ones', () => {
    expect(add(' Bora ')).toEqual({ picks: [{ name: 'Bora' }], taken: null })
    expect(add('Bora', [{ id: 'rome' }])).
      toEqual({ picks: [{ id: 'rome' }, { name: 'Bora' }], taken: null })
  })

  it('adds a ticked new album once when its name is typed again', () => {
    const ticked = [{ name: 'Moorea' }]
    expect(add('MOOREA', ticked)).toEqual({ picks: ticked, taken: null })
  })

  it('adds nothing for an existing album name, case ignored', () => {
    expect(add('rome', [{ id: 'atl' }])).toEqual({ picks: [], taken: 'Rome' })
    expect(add(' keepers ')).toEqual({ picks: [], taken: 'Keepers' })
  })
})

describe('newRename', () => {
  const rome = LIB.albums[0]

  it('fills in the one photo name without its extension', () => {
    expect(newRename(LIB, ['b'], rome)).
      toEqual({ kind: 'rename', ids: ['b'], pattern: 'b', start: 1 })
  })

  it('numbers several photos after the open album', () => {
    expect(newRename(LIB, ['b', 'a'], rome).pattern).toBe('Rome-{number}')
  })

  it('keeps each name of several photos elsewhere', () => {
    expect(newRename(LIB, ['b', 'a'], null).pattern).toBe('{name}')
  })
})

describe('renameNames', () => {
  const rename = (pattern: string, start: number) =>
    renameNames(LIB, { kind: 'rename', ids: ['b', 'a'], pattern, start })

  it('names the photos in the order of the dialog', () => {
    expect(rename('{name}-{number}', 1)).toEqual(['b-001.jpg', 'a-002.jpg'])
  })

  it('rounds the start and keeps it at 0 or more', () => {
    expect(rename('{number}', 2.6)).toEqual(['003.jpg', '004.jpg'])
    expect(rename('{number}', -4)).toEqual(['000.jpg', '001.jpg'])
  })
})
