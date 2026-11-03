import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatLocation, isLocation, parseCoordinates, searchPlaces, toLocation
} from '../src/geo'

describe('parseCoordinates', () => {
  it('reads decimal degrees, latitude first', () => {
    const at = { lat: -16.5004, lon: -151.7415 }
    expect(parseCoordinates('-16.5004, -151.7415')).toEqual(at)
    expect(parseCoordinates(' -16.5004,-151.7415 ')).toEqual(at)
    expect(parseCoordinates('-16.5004 -151.7415')).toEqual(at)
    expect(parseCoordinates('41.9;12.5')).toEqual({ lat: 41.9, lon: 12.5 })
  })

  it("reads Google's degrees, minutes and seconds", () => {
    expect(parseCoordinates(`16°30'01.4"S 151°44'29.4"W`)).
      toEqual({ lat: -16.500389, lon: -151.7415 })
    expect(parseCoordinates(`41°54'00.0"N 12°30'00.0"E`)).
      toEqual({ lat: 41.9, lon: 12.5 })
  })

  it('reads hemisphere letters in any order and spacing', () => {
    expect(parseCoordinates('16.5004° S, 151.7415° W')).
      toEqual({ lat: -16.5004, lon: -151.7415 })
    expect(parseCoordinates('151.7415 W 16.5004 S')).
      toEqual({ lat: -16.5004, lon: -151.7415 })
    expect(parseCoordinates(`N 41° 54' E 12° 30'`)).
      toEqual({ lat: 41.9, lon: 12.5 })
  })

  it('leaves place names and impossible values to the search', () => {
    for (const text of [
      'Matira', 'Matira 2', '1600 Pennsylvania Avenue', '41.9', '',
      '95, 10', '10, 181', `16°75'00"S 151°00'00"W`, '16 N, 151 S',
      '-16 S, 151 W', '1, 2, 3'
    ]) {
      expect(parseCoordinates(text), text).toBeNull()
    }
  })
})

describe('locations', () => {
  it('accepts only finite latitude and longitude in range', () => {
    expect(isLocation({ lat: -90, lon: 180 })).toBe(true)
    expect(isLocation({ lat: 91, lon: 0 })).toBe(false)
    expect(isLocation({ lat: 0, lon: Number.NaN })).toBe(false)
    expect(isLocation({ lat: '1', lon: 2 })).toBe(false)
    expect(isLocation(null)).toBe(false)
  })

  it('wraps longitudes past the date line and rounds', () => {
    expect(toLocation(41.123456789, 372.5)).
      toEqual({ lat: 41.123457, lon: 12.5 })
    expect(toLocation(-16.5, -200)).toEqual({ lat: -16.5, lon: 160 })
  })

  it('shows four decimals', () => {
    expect(formatLocation({ lat: -16.500389, lon: -151.7415 })).
      toBe('-16.5004, -151.7415')
  })
})

describe('searchPlaces', () => {
  const MATIRA = {
    display_name: 'Matira, Bora Bora, French Polynesia',
    lat: '-16.5372',
    lon: '-151.7337',
    boundingbox: ['-16.5472', '-16.5272', '-151.7437', '-151.7237']
  }
  const answer = [MATIRA, {
    display_name: 'Matira Point',
    lat: '-16.53',
    lon: '-151.73'
  }]
  const fetched = vi.fn()
  let clock = Date.now()

  // Each test starts a minute after the last one's searches.
  beforeEach(() => {
    clock += 60_000
    vi.useFakeTimers()
    vi.setSystemTime(clock)
    fetched.mockReset()
    fetched.mockImplementation(async () => Response.json(answer))
    vi.stubGlobal('fetch', fetched)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('asks Nominatim for five places', async () => {
    await searchPlaces('Matira beach')
    expect(fetched).toHaveBeenCalledWith(
      'https://nominatim.openstreetmap.org/search' +
        '?format=jsonv2&limit=5&q=Matira+beach'
    )
  })

  it('returns names and locations, zoomed to fit the place', async () => {
    const places = await searchPlaces('Matira')
    expect(places).toEqual([
      {
        name: 'Matira, Bora Bora, French Polynesia',
        at: { lat: -16.5372, lon: -151.7337 },
        zoom: 14
      },
      { name: 'Matira Point', at: { lat: -16.53, lon: -151.73 }, zoom: 16 }
    ])
  })

  it('lists a place found twice under one name once', async () => {
    fetched.mockImplementation(async () => Response.json([MATIRA, MATIRA]))
    expect(await searchPlaces('Matira')).toHaveLength(1)
  })

  it('keeps requests at least a second apart', async () => {
    const first = searchPlaces('a')
    const second = searchPlaces('b')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetched).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(fetched).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetched).toHaveBeenCalledTimes(2)
    await Promise.all([first, second])
  })

  it('fails when Nominatim refuses', async () => {
    fetched.mockImplementation(async () => {
      return new Response('busy', { status: 429 })
    })
    await expect(searchPlaces('Matira')).rejects.toThrow(/429/)
  })
})
