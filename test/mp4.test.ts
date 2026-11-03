import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { movieTime, nameTime } from '../src/mp4'

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))

describe('movieTime', () => {
  it('reads the creation time from the movie header', () => {
    expect(movieTime(fixture('clip.mp4'))!.toISOString()).
      toBe('2024-01-07T10:00:00.000Z')
  })

  it('returns null without a usable time', () => {
    expect(movieTime(fixture('flat.mp4'))).toBeNull()
    expect(movieTime(new Uint8Array([0, 0, 0, 8, 1, 2, 3, 4]))).toBeNull()
  })
})

describe('nameTime', () => {
  it('reads local times phones put in file names', () => {
    expect(nameTime('VID_20240108_093000.mp4')).toBe('2024-01-08T09:30:00')
    expect(nameTime('PXL_20231224_181512345.mp4')).
      toBe('2023-12-24T18:15:12')
    expect(nameTime('20220301_070809.mp4')).toBe('2022-03-01T07:08:09')
  })

  it('ignores other names', () => {
    expect(nameTime('P1010112.MOV')).toBeNull()
    expect(nameTime('VID_20241399_250000.mp4')).toBeNull()
  })
})
