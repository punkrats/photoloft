import { describe, expect, it } from 'vitest'
import {
  albumFileNames, originalFileNames, previewNames, sanitizeName,
  withExtension
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
