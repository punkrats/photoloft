import { describe, expect, it } from 'vitest'
import {
  albumFileNames, originalFileNames, previewNames, renamedNames,
  sanitizeName, splitExtension, withExtension
} from '../src/naming'

describe('sanitizeName', () => {
  it('keeps ordinary names', () => {
    expect(sanitizeName('Rome 2026')).toBe('Rome 2026')
  })

  it('replaces characters that break paths', () => {
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })

  it('collapses whitespace and trims', () => {
    expect(sanitizeName('  Summer   at\tsea  ')).toBe('Summer at sea')
  })

  it('strips leading dots so nothing becomes hidden', () => {
    expect(sanitizeName('..hidden')).toBe('hidden')
  })

  it('falls back when nothing usable is left', () => {
    expect(sanitizeName(' / ')).toBe('-')
    expect(sanitizeName('   ')).toBe('Untitled')
  })

  it('caps the length', () => {
    expect(sanitizeName('x'.repeat(300))).toHaveLength(120)
  })
})

describe('albumFileNames', () => {
  it('numbers consecutively with three digits', () => {
    const names = albumFileNames('Rome 2026', 3, 1)
    expect(names).toEqual([
      'Rome 2026-001.jpg', 'Rome 2026-002.jpg', 'Rome 2026-003.jpg'
    ])
  })

  it('widens the padding for long albums', () => {
    const names = albumFileNames('Big', 1200, 1)
    expect(names[0]).toBe('Big-0001.jpg')
    expect(names[1199]).toBe('Big-1200.jpg')
  })

  it('honours the start number', () => {
    expect(albumFileNames('A', 2, 998)).toEqual(['A-998.jpg', 'A-999.jpg'])
    expect(albumFileNames('A', 2, 999)).toEqual(['A-0999.jpg', 'A-1000.jpg'])
  })

  it('sanitises the base name', () => {
    expect(albumFileNames('a/b', 1, 1)).toEqual(['a-b-001.jpg'])
  })
})

describe('originalFileNames', () => {
  it('ensures a jpg extension', () => {
    const names = originalFileNames(['IMG_1.JPG', 'beach', 'x.jpeg'])
    expect(names).toEqual(['IMG_1.JPG', 'beach.jpg', 'x.jpeg'])
  })

  it('suffixes clashes case-insensitively', () => {
    const names = originalFileNames(['a.jpg', 'A.jpg', 'a.jpg'])
    expect(names).toEqual(['a.jpg', 'A-2.jpg', 'a-3.jpg'])
  })
})

describe('previewNames', () => {
  it('shows first and last', () => {
    expect(previewNames(['a', 'b', 'c'])).toEqual({ first: 'a', last: 'c' })
  })

  it('handles empty lists', () => {
    expect(previewNames([])).toEqual({ first: null, last: null })
  })
})

describe('withExtension', () => {
  it('swaps the extension', () => {
    expect(withExtension('Rome-003.jpg', 'mp4')).toBe('Rome-003.mp4')
    expect(withExtension('VID_1.MOV', 'mp4')).toBe('VID_1.mp4')
  })

  it('adds one when missing', () => {
    expect(withExtension('clip', 'mp4')).toBe('clip.mp4')
  })
})

describe('splitExtension', () => {
  it('splits at the last dot', () => {
    expect(splitExtension('Rome.2026.JPG')).toEqual(['Rome.2026', '.JPG'])
  })

  it('finds none without a dot, or with only a leading one', () => {
    expect(splitExtension('Beach')).toEqual(['Beach', ''])
    expect(splitExtension('.hidden')).toEqual(['.hidden', ''])
  })
})

describe('renamedNames', () => {
  const photo = (name: string, takenAt: string | null = null) =>
    ({ name, takenAt, importedAt: '' })
  const three = [photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]

  it('numbers in the order given, padded as album exports', () => {
    expect(renamedNames('Moorea-{number}', three, 1)).
      toEqual(['Moorea-001.jpg', 'Moorea-002.jpg', 'Moorea-003.jpg'])
    expect(renamedNames('{number}', three.slice(0, 2), 999)).
      toEqual(['0999.jpg', '1000.jpg'])
  })

  it('writes the capture date and time', () => {
    const photos = [photo('a.jpg', '2026-11-03T14:30:05')]
    expect(renamedNames('{date} {time}', photos, 1)).
      toEqual(['2026-11-03 14-30-05.jpg'])
  })

  it('falls back to the import time, read in local time', () => {
    const importedAt = new Date(2026, 10, 3, 14, 30, 5).toISOString()
    const photos = [{ name: 'a.jpg', takenAt: null, importedAt }]
    expect(renamedNames('{date}_{time}', photos, 1)).
      toEqual(['2026-11-03_14-30-05.jpg'])
  })

  it('leaves date and time empty without either time', () => {
    expect(renamedNames('x{date}{time}', [photo('a.jpg')], 1)).
      toEqual(['x.jpg'])
  })

  it('gives each photo its own extension back', () => {
    const photos = [photo('IMG_1.JPG'), photo('clip.MOV'), photo('Beach')]
    expect(renamedNames('{name}-{number}', photos, 1)).
      toEqual(['IMG_1-001.JPG', 'clip-002.MOV', 'Beach-003'])
  })

  it('cleans characters unsafe in file names', () => {
    expect(renamedNames(' a/b:{name} ', [photo('c*d.jpg')], 1)).
      toEqual(['a-b-c-d.jpg'])
  })

  it('suffixes equal names, case ignored', () => {
    const photos = [photo('a.jpg'), photo('b.JPG'), photo('c')]
    expect(renamedNames('Trip', photos, 1)).
      toEqual(['Trip.jpg', 'Trip-2.JPG', 'Trip'])
    expect(renamedNames('Trip', [photo('a'), photo('b')], 1)).
      toEqual(['Trip', 'Trip-2'])
  })

  it('leaves other braces as typed', () => {
    expect(renamedNames('{foo}-{Name}-{name}', [photo('a.jpg')], 1)).
      toEqual(['{foo}-{Name}-a.jpg'])
  })
})
