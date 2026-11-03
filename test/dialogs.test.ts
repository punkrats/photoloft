import { describe, expect, it } from 'vitest'
import { emptyLibrary, migrate } from '../src/library'
import type { AlbumPick, Picker } from '../src/state'
import { pickerRows, toggledTicks } from '../src/ui/dialogs'

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
  return { kind: 'picker', query, index: 0, ticked }
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
