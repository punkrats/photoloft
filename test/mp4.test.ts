import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  headerTaken, localIso, movieLocation, movieTime, nameTime, olympusTaken,
  olympusTime, readMoov, videoTaken
} from '../src/mp4'

// Andre's zone, ten hours behind UTC all year: the movie header read as
// UTC and read as a plain clock reading never agree there.
process.env.TZ = 'Pacific/Tahiti'

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))

const chars = (text: string) => [...text].map(c => c.charCodeAt(0))
const be32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]

// A UTC time as the movie header stores it: seconds since 1904.
const since1904 = (utc: string) => Date.parse(`${utc}Z`) / 1000 + 2082844800

// A box: 32-bit size, type, then the payload.
function box(type: string, ...payload: number[][]) {
  const body = payload.flat()
  return [...be32(body.length + 8), ...chars(type), ...body]
}

// `length` zero bytes with each text written at its offset.
function struct(length: number, fields: Record<number, string>) {
  const bytes = new Array<number>(length).fill(0)
  for (const [at, text] of Object.entries(fields)) {
    bytes.splice(Number(at), text.length, ...chars(text))
  }
  return bytes
}

// The boxes of an Olympus E-M10 Mark IV clip that carry a time, by
// default those of PB020281.MOV: the movie header and the prms text
// both hold the local clock reading 16:51:41.
function olympusMoov(
  text = 'Mon Nov 02 16:51:41 2026\n', seconds = 3876483101
) {
  const created = be32(seconds)
  const mvhd = box('mvhd', [0, 0, 0, 0], created, created, be32(90000))
  const prms = struct(504, {
    0: 'OLYMDigital Camera',
    0x12: 'OLYMPUS DIGITAL CAMERA',
    0x2c: 'S0088',
    0x83: text,
    0x9d: text
  })
  const header = [0, 0, 0, 0, 0x32, 0x42, 0x0f, 0, 0x08, 0x70, 0x22, 0x52]
  const tags = box('TAGS', header, box('OLYM', box('prms', prms)))
  return new Uint8Array(box('moov', mvhd, box('udta', tags)))
}

// moov/udta/©xyz as Android writes it: text length, language "eng",
// then the ISO 6709 text.
function androidMoov(text: string) {
  const xyz = box('\u00a9xyz', [0, text.length, 0x15, 0xc7], chars(text))
  return new Uint8Array(box('moov', box('udta', box('meta'), xyz)))
}

describe('movieTime', () => {
  it('reads the creation time from the movie header', () => {
    expect(movieTime(fixture('clip.mp4'))!.toISOString()).
      toBe('2024-01-07T10:00:00.000Z')
  })

  it('takes the clock reading Olympus cameras write there as UTC', () => {
    expect(movieTime(olympusMoov())!.toISOString()).
      toBe('2026-11-02T16:51:41.000Z')
  })

  it('returns null without a usable time', () => {
    expect(movieTime(fixture('flat.mp4'))).toBeNull()
    expect(movieTime(new Uint8Array([0, 0, 0, 8, 1, 2, 3, 4]))).toBeNull()
  })
})

describe('olympusTime', () => {
  it('reads the clock time Olympus cameras write as text', () => {
    expect(olympusTime(olympusMoov())).toBe('2026-11-02T16:51:41')
    expect(olympusTime(olympusMoov('Sat Jan  3 07:08:09 2026\n'))).
      toBe('2026-01-03T07:08:09')
  })

  it('returns null without the box or a readable time', () => {
    expect(olympusTime(fixture('VID_20240108_093000.mp4'))).toBeNull()
    expect(olympusTime(androidMoov('+41.9000+012.5000/'))).toBeNull()
    expect(olympusTime(olympusMoov(''))).toBeNull()
    expect(olympusTime(olympusMoov('Mon Mov 02 16:51:41 2026'))).toBeNull()
    expect(olympusTime(olympusMoov('Mon Nov 02 25:51:41 2026'))).toBeNull()
  })
})

describe('headerTaken', () => {
  it('reads the movie header as UTC in the local time zone', () => {
    expect(headerTaken(olympusMoov())).toBe('2026-11-02T06:51:41')
    expect(headerTaken(fixture('clip.mp4'))).toBe('2024-01-07T00:00:00')
  })

  it('returns null without a usable time', () => {
    expect(headerTaken(fixture('flat.mp4'))).toBeNull()
  })
})

describe('olympusTaken', () => {
  const withHeader = (utc: string) =>
    olympusTaken(olympusMoov(undefined, since1904(utc)))

  it('takes the text when the header holds the same clock reading', () => {
    expect(olympusTaken(olympusMoov())).
      toEqual({ taken: '2026-11-02T16:51:41', header: 'local' })

    // PB020127.MOV: the header says 15:24:09, the text a second later.
    const moov = olympusMoov('Mon Nov 02 15:24:10 2026\n', 3876477849)
    expect(olympusTaken(moov)).
      toEqual({ taken: '2026-11-02T15:24:10', header: 'local' })
  })

  it('takes the text when the header holds it as UTC', () => {

    // 16:51:41 in Tahiti is 02:51:41 UTC the next day.
    expect(withHeader('2026-11-03T02:51:41')).
      toEqual({ taken: '2026-11-02T16:51:41', header: 'utc' })
    expect(withHeader('2026-11-03T02:51:43')!.header).toBe('utc')
  })

  it('takes the header as UTC once another app rewrote it', () => {
    expect(withHeader('2026-11-05T08:00:00')).
      toEqual({ taken: '2026-11-04T22:00:00', header: 'rewritten' })
  })

  it('lets the two clocks differ by two seconds at most', () => {
    expect(withHeader('2026-11-02T16:51:43')!.header).toBe('local')
    expect(withHeader('2026-11-02T16:51:39')!.header).toBe('local')
    expect(withHeader('2026-11-02T16:51:44')).
      toEqual({ taken: '2026-11-02T06:51:44', header: 'rewritten' })
    expect(withHeader('2026-11-03T02:51:38')!.header).toBe('rewritten')
  })

  it('takes the text when the header has no time', () => {
    expect(olympusTaken(olympusMoov(undefined, 0))).
      toEqual({ taken: '2026-11-02T16:51:41', header: 'missing' })
  })

  it('returns null without the text', () => {
    expect(olympusTaken(fixture('clip.mp4'))).toBeNull()
    expect(olympusTaken(olympusMoov(''))).toBeNull()
  })
})

describe('videoTaken', () => {
  it('keeps the clock time of an Olympus clip', async () => {
    const ftyp = box('ftyp', chars('qt  '), be32(0x20110700), chars('qt  '))
    const bytes = [...ftyp, ...olympusMoov(), ...box('mdat', [1])]
    const moov = await readMoov(new Blob([new Uint8Array(bytes)]))
    expect(videoTaken('PB020281.MOV', moov)).toBe('2026-11-02T16:51:41')
  })

  it('takes the camera text over the header', () => {

    // PB020127.MOV: the header says 15:24:09, the text a second later.
    const moov = olympusMoov('Mon Nov 02 15:24:10 2026\n', 3876477849)
    expect(videoTaken('PB020127.MOV', moov)).toBe('2026-11-02T15:24:10')
  })

  it('takes a rewritten header over the camera text', () => {
    const moov = olympusMoov(undefined, since1904('2026-11-05T08:00:00'))
    expect(videoTaken('PB020281.MOV', moov)).toBe('2026-11-04T22:00:00')
  })

  it('takes the local time in phone file names over the header', () => {
    const name = 'VID_20240108_093000.mp4'
    expect(videoTaken(name, fixture(name))).toBe('2024-01-08T09:30:00')
  })

  it('shows the header time in the local time zone', () => {
    expect(videoTaken('clip.mp4', fixture('clip.mp4'))).
      toBe(localIso(new Date('2024-01-07T10:00:00Z')))
  })

  it('returns null without a time', () => {
    expect(videoTaken('flat.mp4', fixture('flat.mp4'))).toBeNull()
    expect(videoTaken('P1010112.MOV', null)).toBeNull()
  })
})

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
