// Just enough JPEG and EXIF (TIFF) handling for import and export:
// read size, orientation, capture date and location, and rebuild a
// compact EXIF block plus an XMP packet with the photo's info for
// exported files. Camera values are copied as raw bytes in the
// original byte order, so nothing is reinterpreted on the way.

import type { Location, Meta } from './meta'
import { realTaken } from './taken'

export type JpegInfo = {
  width: number
  height: number
  orientation: number
  takenAt: string | null
}

export type ExportOptions = {
  width: number
  height: number
  stripGps: boolean
  takenAt: string | null
  meta: Meta
}

type Entry = { tag: number, type: number, count: number, data: Uint8Array }

// Info texts as written: cleaned, capped, and empty when removed.
type Texts = {
  title?: string
  description?: string
  keywords?: string[]
  author?: string
  copyright?: string
}

type Tiff = {
  little: boolean
  ifd0: Entry[]
  exif: Entry[]
  gps: Entry[]
  interop: Entry[]
  ifd1: Entry[]
}

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8
}

const TAG = {
  description: 0x010e,
  artist: 0x013b,
  copyright: 0x8298,
  orientation: 0x0112,
  dateTime: 0x0132,
  exifPointer: 0x8769,
  gpsPointer: 0x8825,
  interopPointer: 0xa005,
  dateTimeOriginal: 0x9003,
  colourSpace: 0xa001,
  pixelX: 0xa002,
  pixelY: 0xa003
}

const GPS = { version: 0x0000, latRef: 1, lat: 2, lonRef: 3, lon: 4 }

// Pointers are rebuilt; the rest would carry stale offsets, original
// pixels (maker note previews, ICC, XMP), data meant for the source, or
// a colour space other than the sRGB the export is encoded in.
const DROP_IFD0 = new Set([
  0x0100, 0x0101, 0x0111, 0x0117, 0x014a, 0x02bc, 0x8773,
  TAG.exifPointer, TAG.gpsPointer
])
const DROP_EXIF = new Set([
  0x927c, TAG.interopPointer, TAG.colourSpace, TAG.pixelX, TAG.pixelY
])

// Capture time tags, rewritten when the capture time was corrected.
const DATE_TAGS = new Set([TAG.dateTime, TAG.dateTimeOriginal, 0x9004])

// Lengths in characters; scripts/serve.py applies the same to videos.
const LIMIT = {
  title: 200, description: 2000, author: 200, copyright: 200,
  keyword: 100, keywords: 50
}

// What cameras write into ImageDescription when nobody described the
// photo, compared in lower case: brand names, then the shooting modes
// Huawei phones leave there.
const PLACEHOLDERS = new Set([
  'olympus digital camera', 'minolta digital camera',
  'medion digital camera', 'sony dsc', 'samsung', 'samsung camera pictures',
  '<digimax i5, samsung #1>', 'hellomoto', 'exif_jpeg_picture',
  'digital camera', 'default', 'created by imlib', 'binary comment',
  'charset=ascii', 'dvc 10.1 hdmi', 'scanner',
  'rhdr', 'hdrpl', 'oznor', 'oznorwo', 'frontbhdp', 'fbt', 'rbt', 'ptr',
  'fbthdr', 'btr', 'mon', 'nor', 'dav', 'mde', 'mde_soft', 'edf', 'btfmdn',
  'btf', 'btfhdr', 'frem', 'rpt', 'burst', 'sdr_hdrb', 'cof', 'qrf',
  'fshbty', '_cuva', 'smart', 'hdr', 'bsh'
])

const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0'

const SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf
])

// ─── Reading ─────────────────────────────────────────────────────────

export function jpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  let width = 0
  let height = 0
  let tiff: Tiff | null = null
  for (const seg of segments(bytes)) {
    if (SOF.has(seg.marker) && !width) {
      height = (bytes[seg.data + 1] << 8) | bytes[seg.data + 2]
      width = (bytes[seg.data + 3] << 8) | bytes[seg.data + 4]
    }
    if (isExif(bytes, seg) && !tiff) tiff = tryParse(bytes, seg)
  }
  if (!width || !height) return null

  const orientation = tiff ? numberOf(tiff, tiff.ifd0, TAG.orientation) : 1
  const sideways = orientation >= 5 && orientation <= 8
  return {
    width: sideways ? height : width,
    height: sideways ? width : height,
    orientation: orientation || 1,
    takenAt: tiff ? captureDate(tiff) : null
  }
}

// Decoded values keyed by `<ifd>.<tag in hex>`, for checks and tests.
export function exifTags(bytes: Uint8Array) {
  const tags = new Map<string, string | number | number[]>()
  const seg = segments(bytes).find(s => isExif(bytes, s))
  const tiff = seg ? tryParse(bytes, seg) : null
  if (!tiff) return tags

  const ifds = ['ifd0', 'exif', 'gps', 'interop', 'ifd1'] as const
  for (const name of ifds) {
    if (name === 'ifd1' && tiff.ifd1.length) tags.set('ifd1', 1)
    for (const entry of tiff[name]) {
      tags.set(`${name}.0x${entry.tag.toString(16)}`, decode(tiff, entry))
    }
  }
  return tags
}

// The location the camera recorded in the GPS IFD. Reads the EXIF
// segment only, so the first 256 KB of a file are plenty.
export function cameraLocation(bytes: Uint8Array): Location | null {
  const seg = segments(bytes).find(s => isExif(bytes, s))
  const tiff = seg ? tryParse(bytes, seg) : null
  if (!tiff) return null

  const lat = degrees(tiff, GPS.lat, GPS.latRef, 'S')
  const lon = degrees(tiff, GPS.lon, GPS.lonRef, 'W')
  const place = { lat, lon }

  // Receivers without a fix often write zeros.
  return validPlace(place) && (lat || lon) ? place : null
}

function degrees(tiff: Tiff, tag: number, refTag: number, negative: string) {
  const entry = find(tiff.gps, tag)
  if (!entry || entry.type !== 5) return NaN

  const [d = 0, m = 0, s = 0] = [decode(tiff, entry)].flat() as number[]
  const ref = find(tiff.gps, refTag)
  const sign = ref && decode(tiff, ref) === negative ? -1 : 1
  return sign * (d + m / 60 + s / 3600)
}

function validPlace(place: Location) {
  const { lat, lon } = place
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180
}

function captureDate(tiff: Tiff) {
  const raw = find(tiff.exif, TAG.dateTimeOriginal) ??
    find(tiff.ifd0, TAG.dateTime)
  if (!raw) return null

  const text = decode(tiff, raw)
  const match = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(String(text))
  if (!match) return null

  const [, y, mo, d, h, mi, s] = match
  return realTaken(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
}

function decode(tiff: Tiff, entry: Entry): string | number | number[] {
  if (entry.type === 2) {
    return new TextDecoder().decode(entry.data).replace(/\0+$/, '')
  }
  if (entry.type === 7) {
    return String.fromCharCode(...entry.data).replace(/\0+$/, '')
  }

  const view = new DataView(entry.data.buffer, entry.data.byteOffset)
  const size = TYPE_SIZE[entry.type]
  const values = Array.from({ length: entry.count }, (_, i) => {
    const o = i * size
    if (entry.type === 3) return view.getUint16(o, tiff.little)
    if (entry.type === 4) return view.getUint32(o, tiff.little)
    if (entry.type === 5) {
      const den = view.getUint32(o + 4, tiff.little)
      return view.getUint32(o, tiff.little) / (den || 1)
    }
    return entry.data[o]
  })
  return values.length === 1 ? values[0] : values
}

function numberOf(tiff: Tiff, ifd: Entry[], tag: number) {
  const entry = find(ifd, tag)
  const value = entry ? decode(tiff, entry) : 0
  return typeof value === 'number' ? value : 0
}

function find(ifd: Entry[], tag: number) {
  return ifd.find(e => e.tag === tag)
}

// ─── Export ──────────────────────────────────────────────────────────

// The APP1 segments for an exported file: EXIF, then XMP when the
// photo has info texts. Null when there is nothing to write. The
// library's capture time goes into the date tags, also for files that
// had no EXIF.
export function exportExif(bytes: Uint8Array, opts: ExportOptions) {
  const texts = textsOf(opts.meta)
  const exif = exifSegment(bytes, opts, texts)
  const xmp = xmpSegment(texts)
  if (!exif || !xmp) return exif ?? xmp
  return new Uint8Array([...exif, ...xmp])
}

function exifSegment(bytes: Uint8Array, opts: ExportOptions, texts: Texts) {
  const place = opts.meta.location
  const taken = realTaken(opts.takenAt)
  const wanted = taken || texts.description || texts.author ||
    texts.copyright || place

  const seg = segments(bytes).find(s => isExif(bytes, s))
  const found = seg ? tryParse(bytes, seg) : null
  const tiff = found ?? (wanted ? emptyTiff() : null)
  if (!tiff) return null

  const word = (v: number, size: 2 | 4) => {
    const data = new Uint8Array(size)
    const view = new DataView(data.buffer)
    if (size === 2) view.setUint16(0, v, tiff.little)
    else view.setUint32(0, v, tiff.little)
    return data
  }
  const long = (tag: number, v: number) =>
    ({ tag, type: 4, count: 1, data: word(v, 4) })

  // A corrected capture time replaces the original date tags.
  const stamp = (tag: number) =>
    ({ tag, type: 2, count: 20, data: ascii(taken!) })
  const dated = (e: Entry) =>
    (taken && DATE_TAGS.has(e.tag) ? stamp(e.tag) : e)

  // Info texts replace the camera's; an emptied one removes it.
  const info = new Map([
    [TAG.description, texts.description],
    [TAG.artist, texts.author],
    [TAG.copyright, texts.copyright]
  ])
  const replaced = (e: Entry) => info.get(e.tag) !== undefined ||
    (e.tag === TAG.description && placeholder(tiff, e))

  const ifd0 = tiff.ifd0
    .filter(e => !DROP_IFD0.has(e.tag) && !replaced(e))
    .map(e => e.tag === TAG.orientation
      ? { ...e, type: 3, count: 1, data: word(1, 2) }
      : e)
    .map(dated)
  for (const [tag, text] of info) {
    if (text) ifd0.push(utf8(tag, text))
  }

  const exif = tiff.exif.filter(e => !DROP_EXIF.has(e.tag)).map(dated)
  if (taken && !find(exif, TAG.dateTimeOriginal)) {
    exif.push(stamp(TAG.dateTimeOriginal))
  }
  if (exif.length) {
    const srgb = { tag: TAG.colourSpace, type: 3, count: 1, data: word(1, 2) }
    exif.push(srgb, long(TAG.pixelX, opts.width), long(TAG.pixelY, opts.height))
  }

  // A location set in Photoloft replaces the camera's; null removes both.
  const camera = opts.stripGps ? [] : tiff.gps
  const gps = place === undefined
    ? camera
    : place && validPlace(place) ? gpsIfd(place, tiff.little) : []
  if (!ifd0.length && !exif.length && !gps.length) return null

  const body = buildTiff(tiff.little, ifd0, exif, gps, long)
  const length = body.length + 8
  if (length > 0xffff) return null

  const header = [0xff, 0xe1, length >> 8, length & 0xff]
  const tag = [0x45, 0x78, 0x69, 0x66, 0, 0]
  return new Uint8Array([...header, ...tag, ...body])
}

function textsOf(meta: Meta): Texts {
  const keywords = meta.keywords
    ?.map(k => clean(k, LIMIT.keyword))
    .filter((k): k is string => Boolean(k))
  return {
    title: clean(meta.title, LIMIT.title),
    description: clean(meta.description, LIMIT.description),
    keywords: keywords && [...new Set(keywords)].slice(0, LIMIT.keywords),
    author: clean(meta.author, LIMIT.author),
    copyright: clean(meta.copyright, LIMIT.copyright)
  }
}

// Line breaks and tabs become spaces, other control characters go.
function clean(text: string | undefined, limit: number) {
  if (typeof text !== 'string') return undefined

  const plain = text
    .replace(/[\t\n\v\f\r]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/g, '')
    .trim()
  return [...plain].slice(0, limit).join('').trim()
}

function placeholder(tiff: Tiff, entry: Entry) {
  const text = String(decode(tiff, entry)).trim().toLowerCase()
  return !text || PLACEHOLDERS.has(text)
}

// An ASCII entry holding UTF-8, as most readers expect.
function utf8(tag: number, text: string): Entry {
  const data = new TextEncoder().encode(text + '\0')
  return { tag, type: 2, count: data.length, data }
}

// GPS IFD for a location: version 2.3, the hemispheres, and degrees,
// minutes and seconds in ten-thousandths, about 3 mm.
function gpsIfd(place: Location, little: boolean): Entry[] {
  const dms = (value: number) => {
    const units = Math.round(Math.abs(value) * 36_000_000)
    const parts = [
      [Math.floor(units / 36_000_000), 1],
      [Math.floor(units / 600_000) % 60, 1],
      [units % 600_000, 10_000]
    ]
    const data = new Uint8Array(24)
    const view = new DataView(data.buffer)
    parts.forEach(([n, d], i) => {
      view.setUint32(i * 8, n, little)
      view.setUint32(i * 8 + 4, d, little)
    })
    return { type: 5, count: 3, data }
  }
  const ref = (letter: string) =>
    ({ type: 2, count: 2, data: new Uint8Array([letter.charCodeAt(0), 0]) })

  return [
    { tag: GPS.version, type: 1, count: 4, data: new Uint8Array([2, 3, 0, 0]) },
    { tag: GPS.latRef, ...ref(place.lat < 0 ? 'S' : 'N') },
    { tag: GPS.lat, ...dms(place.lat) },
    { tag: GPS.lonRef, ...ref(place.lon < 0 ? 'W' : 'E') },
    { tag: GPS.lon, ...dms(place.lon) }
  ]
}

// Dublin Core fields for the info texts, the XMP that photo managers
// read for titles and keywords.
function xmpSegment(texts: Texts) {
  const alt = (text: string) =>
    `<rdf:Alt><rdf:li xml:lang="x-default">${xml(text)}</rdf:li></rdf:Alt>`
  const list = (kind: string, items: string[]) => `<rdf:${kind}>` +
    items.map(item => `<rdf:li>${xml(item)}</rdf:li>`).join('') +
    `</rdf:${kind}>`

  const { title, description, keywords, author, copyright } = texts
  const fields = [
    title && `<dc:title>${alt(title)}</dc:title>`,
    description && `<dc:description>${alt(description)}</dc:description>`,
    keywords?.length && `<dc:subject>${list('Bag', keywords)}</dc:subject>`,
    author && `<dc:creator>${list('Seq', [author])}</dc:creator>`,
    copyright && `<dc:rights>${alt(copyright)}</dc:rights>`
  ].filter(field => field)
  if (!fields.length) return null

  const packet = '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about=""' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    fields.join('') +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
  const body = new TextEncoder().encode(XMP_HEADER + packet)
  const length = body.length + 2
  if (length > 0xffff) return null

  return new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff, ...body])
}

function xml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// The tags readers require, for files that had no EXIF: centred
// chroma, EXIF version 2.32 and the YCbCr component order.
function emptyTiff(): Tiff {
  const entry = (tag: number, type: number, values: number[]) => {
    const count = values.length / TYPE_SIZE[type]
    return { tag, type, count, data: new Uint8Array(values) }
  }
  return {
    little: true,
    ifd0: [entry(0x0213, 3, [1, 0])],
    exif: [
      entry(0x9000, 7, [0x30, 0x32, 0x33, 0x32]),
      entry(0x9101, 7, [1, 2, 3, 0])
    ],
    gps: [],
    interop: [],
    ifd1: []
  }
}

// EXIF date text: "YYYY:MM:DD HH:MM:SS" and a closing zero byte.
function ascii(taken: string) {
  const text = taken.replace('T', ' ').replace(/-/g, ':') + '\0'
  return new Uint8Array([...text].map(c => c.charCodeAt(0)))
}

export function insertSegment(jpeg: Uint8Array, segment: Uint8Array) {
  const first = segments(jpeg)[0]
  const afterJfif = first && first.marker === 0xe0 ? first.end : 2

  const out = new Uint8Array(jpeg.length + segment.length)
  out.set(jpeg.subarray(0, afterJfif))
  out.set(segment, afterJfif)
  out.set(jpeg.subarray(afterJfif), afterJfif + segment.length)
  return out
}

type Long = (tag: number, v: number) => Entry

function buildTiff(
  little: boolean, ifd0: Entry[], exif: Entry[], gps: Entry[], long: Long
) {
  const hasExif = exif.length > 0
  const hasGps = gps.length > 0

  // Pointer entries count towards IFD0's size, so lay out with
  // placeholders first and fill in the offsets afterwards.
  const placeholders = [...ifd0]
  if (hasExif) placeholders.push(long(TAG.exifPointer, 0))
  if (hasGps) placeholders.push(long(TAG.gpsPointer, 0))

  const at0 = 8
  const atExif = at0 + ifdSize(placeholders)
  const atGps = atExif + (hasExif ? ifdSize(exif) : 0)
  const total = atGps + (hasGps ? ifdSize(gps) : 0)

  const root = [...ifd0]
  if (hasExif) root.push(long(TAG.exifPointer, atExif))
  if (hasGps) root.push(long(TAG.gpsPointer, atGps))

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out.set(little ? [0x49, 0x49] : [0x4d, 0x4d])
  view.setUint16(2, 42, little)
  view.setUint32(4, at0, little)

  writeIfd(out, at0, root, little)
  if (hasExif) writeIfd(out, atExif, exif, little)
  if (hasGps) writeIfd(out, atGps, gps, little)
  return out
}

function ifdSize(entries: Entry[]) {
  const data = entries
    .map(e => e.data.length)
    .filter(n => n > 4)
    .reduce((sum, n) => sum + n + (n % 2), 0)
  return 2 + entries.length * 12 + 4 + data
}

function writeIfd(
  out: Uint8Array, at: number, entries: Entry[], little: boolean
) {
  const view = new DataView(out.buffer)
  const sorted = [...entries].sort((a, b) => a.tag - b.tag)
  let data = at + 2 + sorted.length * 12 + 4

  view.setUint16(at, sorted.length, little)
  sorted.forEach((e, i) => {
    const o = at + 2 + i * 12
    view.setUint16(o, e.tag, little)
    view.setUint16(o + 2, e.type, little)
    view.setUint32(o + 4, e.count, little)
    if (e.data.length <= 4) {
      out.set(e.data, o + 8)
      return
    }
    view.setUint32(o + 8, data, little)
    out.set(e.data, data)
    data += e.data.length + (e.data.length % 2)
  })
  view.setUint32(at + 2 + sorted.length * 12, 0, little)
}

// ─── Parsing ─────────────────────────────────────────────────────────

type Segment = { marker: number, data: number, end: number }

function segments(bytes: Uint8Array) {
  const found: Segment[] = []
  let pos = 2

  while (pos + 4 <= bytes.length && bytes[pos] === 0xff) {
    const marker = bytes[pos + 1]
    if (marker === 0xda || marker === 0xd9) break

    const length = (bytes[pos + 2] << 8) | bytes[pos + 3]
    const end = pos + 2 + length
    if (length < 2 || end > bytes.length) break

    found.push({ marker, data: pos + 4, end })
    pos = end
  }
  return found
}

function isExif(bytes: Uint8Array, seg: Segment) {
  if (seg.marker !== 0xe1 || seg.end - seg.data < 14) return false

  const tag = String.fromCharCode(...bytes.subarray(seg.data, seg.data + 6))
  return tag === 'Exif\0\0'
}

function tryParse(bytes: Uint8Array, seg: Segment) {
  try {
    return parseTiff(bytes.subarray(seg.data + 6, seg.end))
  } catch {
    return null
  }
}

function parseTiff(tiff: Uint8Array): Tiff {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  const order = view.getUint16(0)
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('byte order')

  const little = order === 0x4949
  if (view.getUint16(2, little) !== 42) throw new Error('magic')

  const at0 = view.getUint32(4, little)
  const ifd0 = readIfd(tiff, at0, little)
  const pointer = (ifd: Entry[], tag: number) => {
    const entry = find(ifd, tag)
    if (!entry) return []
    return readIfd(tiff, new DataView(entry.data.buffer, entry.data.byteOffset)
      .getUint32(0, little), little)
  }

  const exif = pointer(ifd0, TAG.exifPointer)
  const next = view.getUint32(at0 + 2 + ifd0.length * 12, little)
  return {
    little,
    ifd0,
    exif,
    gps: pointer(ifd0, TAG.gpsPointer),
    interop: pointer(exif, TAG.interopPointer),
    ifd1: next ? readIfd(tiff, next, little) : []
  }
}

function readIfd(tiff: Uint8Array, at: number, little: boolean) {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  const count = view.getUint16(at, little)
  if (at + 2 + count * 12 + 4 > tiff.length) throw new Error('ifd bounds')

  const entries: Entry[] = []
  for (let i = 0; i < count; i++) {
    const o = at + 2 + i * 12
    const type = view.getUint16(o + 2, little)
    const size = TYPE_SIZE[type]
    if (!size) continue

    const count = view.getUint32(o + 4, little)
    const length = size * count
    const start = length <= 4 ? o + 8 : view.getUint32(o + 8, little)
    if (start + length > tiff.length) throw new Error('value bounds')

    const data = tiff.slice(start, start + length)
    entries.push({ tag: view.getUint16(o, little), type, count, data })
  }
  return entries
}
