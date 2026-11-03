import {
  divIcon, map as leafletMap, marker, tileLayer, type LeafletMouseEvent,
  type Map as Leaflet, type Marker
} from 'leaflet'
import { cameraLocation } from './exif'
import {
  closeView, parseCoordinates, searchPlaces, toLocation, type MapView
} from './geo'
import type { Photo } from './library'
import type { Location } from './meta'
import { movieLocation, readMoov } from './mp4'
import { render, RENDERED } from './render'
import { infoForm, type AppState, type InfoForm } from './state'
import { readOriginal, type Dirs } from './storage'

// The Leaflet map of the Info dialog. `view` is the dialog view it last
// moved to; `failed` says the latest map tile could not load.
export type PlaceMap = {
  element: HTMLElement
  leaflet: Leaflet
  pin: Marker
  view: MapView | null
  failed: boolean
}

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/' +
  'copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
const HEAD_BYTES = 256 * 1024

// The pin is a glyph of the icon font, placed by the stylesheet.
const PIN = divIcon({
  className: 'map-pin',
  html: '<i class="icon-map-pin"></i>',
  iconSize: [0, 0]
})

// One map serves every Info dialog: the dialog shows its element each
// time it opens, so closing the dialog, by any means, leaves nothing
// to tear down. The map follows the dialog after each render.
export function ensureMap(state: AppState) {
  if (state.map) return

  const element = document.createElement('div')
  element.className = 'place-map'
  const leaflet = leafletMap(element, { trackResize: false })
  leaflet.attributionControl.setPrefix(false)
  leaflet.on('click', e => pinAt(state, e))

  const tiles = tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 })
  tiles.on('tileload', () => tilesFailed(state, false))
  tiles.on('tileerror', () => tilesFailed(state, true))
  tiles.addTo(leaflet)

  const pin = marker([0, 0], { icon: PIN, interactive: false, keyboard: false })
  state.map = { element, leaflet, pin, view: null, failed: false }
  state.root.addEventListener(RENDERED, () => followForm(state))
}

function followForm(state: AppState) {
  const form = infoForm(state)
  const map = state.map!
  if (!form || !map.element.isConnected) return

  map.leaflet.invalidateSize()
  if (map.view !== form.view) {
    map.view = form.view
    const { at, zoom } = form.view
    map.leaflet.setView([at.lat, at.lon], zoom, { animate: false })
  }
  if (!form.pin) {
    map.pin.remove()
    return
  }
  map.pin.setLatLng([form.pin.lat, form.pin.lon])
  if (!map.leaflet.hasLayer(map.pin)) map.pin.addTo(map.leaflet)
}

// Leaflet reports a click only when the map was not dragged.
function pinAt(state: AppState, e: LeafletMouseEvent) {
  const form = infoForm(state)
  if (!form) return

  form.pin = toLocation(e.latlng.lat, e.latlng.lng)
  form.moved = true
  render(state)
}

function tilesFailed(state: AppState, failed: boolean) {
  const map = state.map!
  if (map.failed === failed) return

  map.failed = failed
  render(state)
}

function placePin(form: InfoForm, at: Location, view: MapView) {
  form.pin = at
  form.moved = true
  form.view = view
  form.places = []
  form.note = null
}

// ─── Starting point ──────────────────────────────────────────────────

// Without a location added in Lightbox the map starts where the first
// photo's camera recorded one, once that is read, unless the user has
// placed the pin by then.
export async function showCameraLocation(state: AppState, form: InfoForm) {
  const photo = state.library?.photos[form.ids[0]]
  if (!photo || !state.dirs) return

  const at = await recordedLocation(state.dirs, photo).catch(() => null)
  if (!at || infoForm(state) !== form || form.moved) return
  form.pin = at
  form.view = closeView(at)
  render(state)
}

// A video's `moov` box can sit at the end of the file; a photo's EXIF
// is at the start.
async function recordedLocation(dirs: Dirs, photo: Photo) {
  const file = await readOriginal(dirs, photo)
  if (photo.video) {
    const moov = await readMoov(file)
    return moov ? movieLocation(moov) : null
  }
  const head = await file.slice(0, HEAD_BYTES).arrayBuffer()
  return cameraLocation(new Uint8Array(head))
}

// ─── Search ──────────────────────────────────────────────────────────

// Coordinates set the pin right away, offline too. Other text asks
// OpenStreetMap for places to pick from.
export async function searchPlace(state: AppState) {
  const form = infoForm(state)
  const query = form?.query.trim()
  if (!form || !query) return

  const at = parseCoordinates(query)
  if (at) {
    placePin(form, at, closeView(at))
    render(state)
    return
  }

  const search = ++form.searches
  form.places = []
  form.note = 'Searching...'
  render(state)
  try {
    const places = await searchPlaces(query)
    if (infoForm(state) !== form || form.searches !== search) return
    form.places = places
    form.note = places.length ? null : 'No places found.'
  } catch {
    if (infoForm(state) !== form || form.searches !== search) return
    form.note = 'The place search failed. Pasted coordinates still work.'
  }
  render(state)
}

export function pickPlace(state: AppState, index: number) {
  const form = infoForm(state)
  const place = form?.places[index]
  if (!form || !place) return

  placePin(form, place.at, { at: place.at, zoom: place.zoom })
}
