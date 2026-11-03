import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { movieLocation, movieTime, nameTime } from '../src/mp4'

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

// A box: 32-bit size, type, then the payload.
function box(type: string, ...payload: number[][]) {
  const body = payload.flat()
  const size = body.length + 8
  const head = [size >>> 24, (size >> 16) & 255, (size >> 8) & 255, size & 255]
  return [...head, ...[...type].map(c => c.charCodeAt(0)), ...body]
}

// moov/udta/©xyz as Android writes it: text length, language "eng",
// then the ISO 6709 text.
function androidMoov(text: string) {
  const chars = [...text].map(c => c.charCodeAt(0))
  const xyz = box('\u00a9xyz', [0, chars.length, 0x15, 0xc7], chars)
  return new Uint8Array(box('moov', box('udta', box('meta'), xyz)))
}

describe('movieLocation', () => {
  it('reads the location a phone wrote into the movie', () => {
    const place = movieLocation(fixture('located.mp4'))!
    expect(place.lat).toBeCloseTo(41.9, 9)
    expect(place.lon).toBeCloseTo(12.5, 9)
  })

  it('reads southern and western places and skips the altitude', () => {
    expect(movieLocation(androidMoov('-16.5004-151.7415/'))).
      toEqual({ lat: -16.5004, lon: -151.7415 })
    expect(movieLocation(androidMoov('+05.1+012.5+034.000/'))).
      toEqual({ lat: 5.1, lon: 12.5 })
  })

  it('returns null without a usable location', () => {
    expect(movieLocation(fixture('clip.mp4'))).toBeNull()
    expect(movieLocation(fixture('broken.mp4'))).toBeNull()
    expect(movieLocation(androidMoov('+4154.000+01230.000/'))).toBeNull()
    expect(movieLocation(androidMoov('+95.0000+012.5000/'))).toBeNull()
    expect(movieLocation(androidMoov('+00.0000+000.0000/'))).toBeNull()
    expect(movieLocation(androidMoov('nowhere'))).toBeNull()
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
