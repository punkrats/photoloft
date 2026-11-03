import { describe, expect, it } from 'vitest'
import {
  formatBytes, formatDuration, formatList, formatShift, formatTaken
} from '../src/format'

describe('formatBytes', () => {
  it('uses MB with one decimal from a megabyte up', () => {
    expect(formatBytes(9_757_203)).toBe('9.8 MB')
    expect(formatBytes(1_000_000)).toBe('1.0 MB')
  })

  it('uses whole KB below that', () => {
    expect(formatBytes(512_400)).toBe('512 KB')
    expect(formatBytes(2_163)).toBe('2 KB')
  })

  it('names unknown sizes', () => {
    expect(formatBytes(0)).toBe('Size unknown')
  })
})

describe('formatTaken', () => {
  it('shows date and time as the camera recorded them', () => {
    expect(formatTaken('2024-05-06T07:08:09', 'en-GB')).
      toBe('6 May 2024, 07:08')
  })

  it('names missing dates', () => {
    expect(formatTaken(null, 'en-GB')).toBe('No date')
  })

  it('adds seconds when asked', () => {
    expect(formatTaken('2024-05-06T07:08:09', 'en-GB', true)).
      toBe('6 May 2024, 07:08:09')
  })

  it('treats impossible dates as missing', () => {
    expect(formatTaken('0000-00-00T00:00:00', 'en-GB')).toBe('No date')
  })
})

describe('formatDuration', () => {
  it('shows minutes and seconds, hours when needed', () => {
    expect(formatDuration(42.4)).toBe('0:42')
    expect(formatDuration(62)).toBe('1:02')
    expect(formatDuration(3723)).toBe('1:02:03')
    expect(formatDuration(NaN)).toBe('0:00')
  })
})

describe('formatShift', () => {
  const minute = 60 * 1000
  const day = 24 * 60 * minute

  it('lists days, hours, minutes and seconds that are not zero', () => {
    expect(formatShift(881 * day + 5 * 60 * minute + 31 * minute)).
      toBe('+881 days 5 h 31 min')
    expect(formatShift(-(60 * minute + 10 * 1000))).toBe('-1 h 10 s')
    expect(formatShift(day)).toBe('+1 day')
  })

  it('names no change', () => {
    expect(formatShift(0)).toBe('no change')
  })
})

describe('formatList', () => {
  it('joins names with commas and a last "and"', () => {
    expect(formatList(['Moorea'])).toBe('Moorea')
    expect(formatList(['Moorea', 'Keepers'])).toBe('Moorea and Keepers')
    expect(formatList(['A', 'B', 'C'])).toBe('A, B and C')
    expect(formatList(['A', 'B', 'C', 'D'])).toBe('A, B, C and D')
  })

  it('gives nothing for no names', () => {
    expect(formatList([])).toBe('')
  })
})
