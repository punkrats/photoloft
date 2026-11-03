import { describe, expect, it } from 'vitest'
import { realTaken, shiftedTaken, takenDifference } from '../src/taken'

describe('realTaken', () => {
  it('keeps real dates and rejects impossible ones', () => {
    expect(realTaken('1970-01-01T00:00:10')).toBe('1970-01-01T00:00:10')
    expect(realTaken('0000-00-00T00:00:00')).toBeNull()
  })
})

describe('shifting capture times', () => {
  it('measures the gap between two times', () => {
    const gap = takenDifference('1970-01-01T00:00:00', '2026-05-31T15:31:00')
    expect(shiftedTaken('1970-01-01T00:00:10', gap)).
      toBe('2026-05-31T15:31:10')
  })

  it('ignores daylight saving: clock times move by whole hours', () => {
    const gap = takenDifference('2026-03-28T12:00:00', '2026-03-29T12:00:00')
    expect(shiftedTaken('2026-03-29T01:30:00', gap)).
      toBe('2026-03-30T01:30:00')
  })

  it('moves backwards too', () => {
    const gap = takenDifference('2026-05-31T15:31:00', '2026-05-30T14:31:00')
    expect(shiftedTaken('2026-05-31T15:31:59', gap)).
      toBe('2026-05-30T14:31:59')
  })
})
