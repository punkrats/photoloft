import type { Location } from './meta'

export type Place = { name: string, at: Location, zoom: number }
export type MapView = { at: Location, zoom: number }

// The whole world, for photos without a location.
export const WORLD_VIEW: MapView = { at: { lat: 20, lon: 0 }, zoom: 1 }

const SEARCH_URL = 'https://nominatim.openstreetmap.org/search'
const SEARCH_GAP_MS = 1000
const PLACE_ZOOM = { min: 2, max: 16 }
const CLOSE_ZOOM = 14

// One coordinate: degrees with optional minutes and seconds, signed or
// with a hemisphere letter before or after.
const COORDINATE = new RegExp(
  String.raw`^([NSEW])?\s*([+-])?(\d+(?:\.\d+)?)\s*[°º]?\s*` +
    String.raw`(?:(\d+(?:\.\d+)?)\s*['′’]\s*)?` +
    String.raw`(?:(\d+(?:\.\d+)?)\s*["″”]\s*)?([NSEW])?$`,
  'i'
)
const SEPARATOR = /\s*[,;]\s*|\s+/g

let nextSearch = 0

// ─── Coordinates ─────────────────────────────────────────────────────

export function isLocation(value: unknown): value is Location {
  if (!value || typeof value !== 'object') return false

  const { lat, lon } = value as Record<string, unknown>
  return typeof lat === 'number' && typeof lon === 'number' &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180
}

// A point from the map: longitudes on a repeated world copy wrap back
// into -180 to 180, and both are rounded to about 10 cm.
export function toLocation(lat: number, lon: number): Location {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180
  return { lat: round(Math.min(90, Math.max(-90, lat))), lon: round(wrapped) }
}

// Close enough to see streets around the point.
export function closeView(at: Location): MapView {
  return { at, zoom: CLOSE_ZOOM }
}

export function formatLocation(at: Location) {
  return `${at.lat.toFixed(4)}, ${at.lon.toFixed(4)}`
}

// Latitude and longitude as people paste them: decimal degrees
// ("-16.5004, -151.7415") or degrees, minutes and seconds as Google
// Maps shows them (16°30'01.4"S 151°44'29.4"W). Without hemisphere
// letters the latitude comes first. Null when the text is no pair of
// coordinates, so it can go to the place search.
export function parseCoordinates(text: string): Location | null {
  const clean = text.trim()
  for (const separator of clean.matchAll(SEPARATOR)) {
    const left = clean.slice(0, separator.index)
    const right = clean.slice(separator.index + separator[0].length)
    const at = pair(coordinate(left), coordinate(right))
    if (at) return at
  }
  return null
}

type Coordinate = { value: number, axis: 'lat' | 'lon' | null }

function coordinate(text: string): Coordinate | null {
  const match = COORDINATE.exec(text)
  if (!match) return null

  const [, before, sign, deg, min, sec, after] = match
  const letter = (before ?? after)?.toUpperCase()
  if ((before && after) || (sign && letter)) return null
  if (sec !== undefined && min === undefined) return null
  if (Number(min ?? 0) >= 60 || Number(sec ?? 0) >= 60) return null

  const size = Number(deg) + Number(min ?? 0) / 60 + Number(sec ?? 0) / 3600
  const negative = sign === '-' || letter === 'S' || letter === 'W'
  const axis = !letter ? null : letter === 'N' || letter === 'S' ? 'lat' : 'lon'
  return { value: negative ? -size : size, axis }
}

function pair(a: Coordinate | null, b: Coordinate | null) {
  if (!a || !b || (a.axis && a.axis === b.axis)) return null

  const swapped = a.axis === 'lon' || b.axis === 'lat'
  const at = swapped
    ? { lat: b.value, lon: a.value }
    : { lat: a.value, lon: b.value }
  return isLocation(at) ? { lat: round(at.lat), lon: round(at.lon) } : null
}

function round(value: number) {
  return Math.round(value * 1e6) / 1e6
}

// ─── Place search ────────────────────────────────────────────────────

// Asks OpenStreetMap's Nominatim for up to five places. Requests stay
// at least a second apart, as its usage policy asks.
export async function searchPlaces(query: string): Promise<Place[]> {
  const now = Date.now()
  const wait = nextSearch - now
  nextSearch = Math.max(now, nextSearch) + SEARCH_GAP_MS
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))

  const params = new URLSearchParams({ format: 'jsonv2', limit: '5', q: query })
  const response = await fetch(`${SEARCH_URL}?${params}`)
  if (!response.ok) {
    throw new Error(`The place search failed (${response.status})`)
  }
  return places(await response.json())
}

// OpenStreetMap often has a place twice (a point and an outline) under
// the same name; the first of each name is kept.
function places(raw: unknown): Place[] {
  if (!Array.isArray(raw)) return []

  const named = new Set<string>()
  return raw.flatMap(item => {
    const at = { lat: Number(item?.lat), lon: Number(item?.lon) }
    const name = item?.display_name
    if (!isLocation(at) || typeof name !== 'string' || named.has(name)) {
      return []
    }
    named.add(name)
    return [{ name, at: toLocation(at.lat, at.lon), zoom: placeZoom(item) }]
  })
}

// The zoom at which the place's bounding box (south, north, west, east)
// spans about one map tile; places without one get a close view.
function placeZoom(item: { boundingbox?: unknown }) {
  const box = Array.isArray(item.boundingbox) ? item.boundingbox : []
  const [south, north, west, east] = box.map(Number)
  const span = Math.max(north - south, east - west)
  if (!(span > 0)) return PLACE_ZOOM.max

  const zoom = Math.floor(Math.log2(360 / span))
  return Math.min(PLACE_ZOOM.max, Math.max(PLACE_ZOOM.min, zoom))
}
