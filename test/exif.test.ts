import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cameraLocation, exifTags, exportExif, insertSegment, jpegInfo
} from '../src/exif'
import type { Meta } from '../src/meta'

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))

const OPTIONS = {
  width: 100, height: 80, stripGps: true, takenAt: null, meta: {}
}
const PLACE = { lat: -16.5004, lon: -151.7415 }

function exported(name: string, stripGps = true) {
  const app1 = exportExif(fixture(name), { ...OPTIONS, stripGps })!
  return insertSegment(fixture('plain.jpg'), app1)
}

// An export of `source` with info, as a whole JPEG.
function withMeta(source: Uint8Array, meta: Meta, stripGps = true) {
  const app1 = exportExif(source, { ...OPTIONS, stripGps, meta })
  return app1 ? insertSegment(fixture('plain.jpg'), app1) : source
}

// The XMP packet of a JPEG as text, or null.
function xmpOf(jpeg: Uint8Array) {
  const text = new TextDecoder().decode(jpeg)
  const at = text.indexOf('http://ns.adobe.com/xap/1.0/\0')
  return at < 0 ? null : text.slice(at, text.indexOf('<?xpacket end', at))
}

function hasExiftool() {
  try {
    execFileSync('exiftool', ['-ver'])
    return true
  } catch {
    return false
  }
}

// Minimal big-endian EXIF with a maker note, which exiftool cannot
// write on its own.
function withMakerNote() {
  const tiff = [
    0x4d, 0x4d, 0, 42, 0, 0, 0, 8,
    0, 1, 0x87, 0x69, 0, 4, 0, 0, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0,
    0, 2,
    0x90, 0x00, 0, 7, 0, 0, 0, 4, 0x30, 0x32, 0x33, 0x30,
    0x92, 0x7c, 0, 7, 0, 0, 0, 8, 0, 0, 0, 56,
    0, 0, 0, 0,
    1, 2, 3, 4, 5, 6, 7, 8
  ]
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const length = exif.length + 2
  const app1 = [0xff, 0xe1, length >> 8, length & 0xff, ...exif]
  const plain = fixture('plain.jpg')
  return new Uint8Array([0xff, 0xd8, ...app1, ...plain.slice(2)])
}

describe('jpegInfo', () => {
  it('reads oriented size, orientation and capture date', () => {
    expect(jpegInfo(fixture('exif-mm.jpg'))).toEqual({
      width: 48, height: 64, orientation: 6, takenAt: '2024-05-06T07:08:09'
    })
  })

  it('reads little-endian EXIF the same way', () => {
    expect(jpegInfo(fixture('exif-ii.jpg'))!.takenAt).
      toBe('2024-05-06T07:08:09')
  })

  it('ignores placeholder dates from cameras without a set clock', () => {
    expect(jpegInfo(fixture('zero-date.jpg'))!.takenAt).toBeNull()
  })

  it('works without EXIF', () => {
    expect(jpegInfo(fixture('plain.jpg'))).toEqual({
      width: 40, height: 30, orientation: 1, takenAt: null
    })
  })

  it('rejects files that are not JPEGs', () => {
    expect(jpegInfo(fixture('not-a-jpeg.png'))).toBeNull()
  })
})

describe('exportExif', () => {
  for (const name of ['exif-mm.jpg', 'exif-ii.jpg']) {
    it(`rewrites ${name} for an export`, () => {
      const tags = exifTags(exported(name))
      expect(tags.get('ifd0.0x112')).toBe(1)
      expect(tags.get('ifd0.0x10f')).toBe('TestCam')
      expect(tags.get('exif.0x9003')).toBe('2024:05:06 07:08:09')
      expect(tags.get('exif.0xa002')).toBe(100)
      expect(tags.get('exif.0xa003')).toBe(80)
      expect(tags.get('ifd1')).toBeUndefined()
      expect(tags.get('exif.0xa001')).toBe(1)
      expect([...tags.keys()].some(k => k.startsWith('interop'))).
        toBe(false)
      expect([...tags.keys()].some(k => k.startsWith('gps'))).toBe(false)
    })
  }

  it('writes a corrected capture time', () => {
    const options = { ...OPTIONS, takenAt: '2026-05-31T15:31:00' }
    const app1 = exportExif(fixture('exif-mm.jpg'), options)!
    const tags = exifTags(insertSegment(fixture('plain.jpg'), app1))
    expect(tags.get('exif.0x9003')).toBe('2026:05:31 15:31:00')
  })

  it('creates a capture time for photos without EXIF', () => {
    const options = { ...OPTIONS, takenAt: '2026-05-31T15:31:00' }
    const app1 = exportExif(fixture('plain.jpg'), options)!
    const tags = exifTags(insertSegment(fixture('plain.jpg'), app1))
    expect(tags.get('exif.0x9003')).toBe('2026:05:31 15:31:00')
  })

  it('keeps GPS when asked to', () => {
    const tags = exifTags(exported('exif-mm.jpg', false))
    expect(tags.get('gps.0x1')).toBe('N')
  })

  it('drops maker notes and keeps the rest', () => {
    const app1 = exportExif(withMakerNote(), OPTIONS)!
    const tags = exifTags(insertSegment(fixture('plain.jpg'), app1))
    expect(tags.has('exif.0x927c')).toBe(false)
    expect(tags.get('exif.0x9000')).toBe('0230')
  })

  it('returns null without EXIF or with broken EXIF', () => {
    expect(exportExif(fixture('plain.jpg'), OPTIONS)).toBeNull()

    const broken = fixture('exif-mm.jpg')
    broken.fill(0xee, 20, 60)
    expect(exportExif(broken, OPTIONS)).toBeNull()
  })

  it.runIf(hasExiftool())('passes exiftool validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photoloft-'))
    const file = join(dir, 'out.jpg')
    writeFileSync(file, exported('exif-ii.jpg'))

    const args = ['-j', '-a', '-n', '-All', '-validate', '-warning', file]
    const [info] = JSON.parse(execFileSync('exiftool', args).toString())
    expect(info.Validate).toBe('0 0 0')
    expect(info.Orientation).toBe(1)
    expect(info.ColorSpace).toBe(1)
    expect(info.Make).toBe('TestCam')
    expect(info.ExifImageWidth).toBe(100)
    expect(info.GPSLatitude).toBeUndefined()
    expect(info.ThumbnailImage).toBeUndefined()
    expect(info.Warning).toBeUndefined()
  })
})

describe('exportExif with info', () => {
  const INFO: Meta = {
    title: 'Sunset at Matira',
    description: 'Café © on the <beach> & more',
    keywords: ['beach', 'Bora Bora'],
    author: 'Zoë Name',
    copyright: '(c) 2026 Zoë Name'
  }

  it('writes description, author and copyright into EXIF as UTF-8', () => {
    const tags = exifTags(withMeta(fixture('exif-mm.jpg'), INFO))
    expect(tags.get('ifd0.0x10e')).toBe('Café © on the <beach> & more')
    expect(tags.get('ifd0.0x13b')).toBe('Zoë Name')
    expect(tags.get('ifd0.0x8298')).toBe('(c) 2026 Zoë Name')
    expect(tags.get('ifd0.0x10f')).toBe('TestCam')
  })

  it('keeps camera texts, replaces set ones and removes emptied ones', () => {
    const camera = withMeta(fixture('exif-ii.jpg'), INFO)
    const kept = exifTags(withMeta(camera, {}))
    expect(kept.get('ifd0.0x13b')).toBe('Zoë Name')

    const changed = exifTags(withMeta(camera, { author: 'New', copyright: '' }))
    expect(changed.get('ifd0.0x13b')).toBe('New')
    expect(changed.has('ifd0.0x8298')).toBe(false)
    expect(changed.get('ifd0.0x10e')).toBe('Café © on the <beach> & more')
  })

  it('drops blank and placeholder descriptions from cameras', () => {
    const olympus = withMeta(fixture('exif-mm.jpg'), {
      description: 'OLYMPUS DIGITAL CAMERA'
    })
    expect(exifTags(withMeta(olympus, {})).has('ifd0.0x10e')).toBe(false)

    const blank = withMeta(fixture('exif-mm.jpg'), { description: 'XXXX' })
    const at = new TextDecoder('latin1').decode(blank).indexOf('XXXX')
    blank.fill(0x20, at, at + 4)
    expect(exifTags(blank).get('ifd0.0x10e')).toBe('    ')
    expect(exifTags(withMeta(blank, {})).has('ifd0.0x10e')).toBe(false)
  })

  it('removes control characters, trims and caps texts', () => {
    const meta = {
      description: '  a\u0000b\nc\u0007  ',
      author: 'x'.repeat(300),
      keywords: [' sea ', '', 'sea', 'k'.repeat(150)]
    }
    const out = withMeta(fixture('exif-mm.jpg'), meta)
    const tags = exifTags(out)
    expect(tags.get('ifd0.0x10e')).toBe('ab c')
    expect(tags.get('ifd0.0x13b')).toBe('x'.repeat(200))
    const xmp = xmpOf(out)!
    expect(xmp).toContain(`<rdf:li>sea</rdf:li><rdf:li>${'k'.repeat(100)}<`)
    expect(xmp.match(/<rdf:li>/g)).toHaveLength(3)
  })

  it('writes the info texts as an XMP packet', () => {
    const xmp = xmpOf(withMeta(fixture('exif-mm.jpg'), INFO))!
    const alt = (text: string) =>
      `<rdf:Alt><rdf:li xml:lang="x-default">${text}</rdf:li></rdf:Alt>`
    expect(xmp).toContain(`<dc:title>${alt('Sunset at Matira')}</dc:title>`)
    expect(xmp).toContain(
      `<dc:description>${alt('Café © on the &lt;beach&gt; &amp; more')}`)
    expect(xmp).toContain('<rdf:Bag><rdf:li>beach</rdf:li>' +
      '<rdf:li>Bora Bora</rdf:li></rdf:Bag>')
    expect(xmp).toContain('<rdf:Seq><rdf:li>Zoë Name</rdf:li></rdf:Seq>')
    expect(xmp).toContain(`<dc:rights>${alt('(c) 2026 Zoë Name')}`)
  })

  it('writes no XMP without info texts', () => {
    expect(xmpOf(withMeta(fixture('exif-mm.jpg'), {}))).toBeNull()
    expect(xmpOf(withMeta(fixture('exif-mm.jpg'), { title: ' ' }))).
      toBeNull()
  })

  it('writes info into photos without EXIF', () => {
    const titled = withMeta(fixture('plain.jpg'), { title: 'Only XMP' })
    expect(exifTags(titled).size).toBe(0)
    expect(xmpOf(titled)).toContain('Only XMP')

    const meta = { author: 'Zoë', location: PLACE }
    const tags = exifTags(withMeta(fixture('plain.jpg'), meta))
    expect(tags.get('ifd0.0x13b')).toBe('Zoë')
    expect(tags.get('gps.0x1')).toBe('S')
  })

  it('writes a set location in place of the camera one', () => {
    for (const stripGps of [true, false]) {
      const source = fixture('exif-mm.jpg')
      const out = withMeta(source, { location: PLACE }, stripGps)
      const tags = exifTags(out)
      expect(tags.get('gps.0x0')).toEqual([2, 3, 0, 0])
      expect(tags.get('gps.0x1')).toBe('S')
      expect(tags.get('gps.0x3')).toBe('W')
      expect(tags.has('gps.0x6')).toBe(false)

      const place = cameraLocation(out)!
      expect(Math.abs(place.lat - PLACE.lat)).toBeLessThan(1e-7)
      expect(Math.abs(place.lon - PLACE.lon)).toBeLessThan(1e-7)
    }
  })

  it('writes the location of a camera only when camera locations stay', () => {
    const kept = withMeta(fixture('exif-mm.jpg'), {}, false)
    expect(cameraLocation(kept)!.lat).toBeCloseTo(41.9, 6)

    const stripped = withMeta(fixture('exif-mm.jpg'), {}, true)
    expect(cameraLocation(stripped)).toBeNull()

    const removed = withMeta(fixture('exif-mm.jpg'), { location: null }, false)
    const keys = [...exifTags(removed).keys()]
    expect(keys.some(k => k.startsWith('gps'))).toBe(false)
  })

  it.runIf(hasExiftool())('passes exiftool validation with info', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photoloft-'))
    const file = join(dir, 'out.jpg')
    const meta = { ...INFO, location: PLACE }
    writeFileSync(file, withMeta(fixture('exif-ii.jpg'), meta))

    const args = ['-j', '-a', '-n', '-G', '-All', '-validate', '-warning',
      file]
    const [info] = JSON.parse(execFileSync('exiftool', args).toString())
    expect(info['ExifTool:Validate']).toBe('0 0 0')
    expect(info['ExifTool:Warning']).toBeUndefined()
    expect(info['EXIF:ImageDescription']).toBe(INFO.description)
    expect(info['EXIF:Artist']).toBe('Zoë Name')
    expect(info['EXIF:Copyright']).toBe('(c) 2026 Zoë Name')
    expect(info['XMP:Title']).toBe('Sunset at Matira')
    expect(info['XMP:Description']).toBe(INFO.description)
    expect(info['XMP:Subject']).toEqual(['beach', 'Bora Bora'])
    expect(info['XMP:Creator']).toBe('Zoë Name')
    expect(info['XMP:Rights']).toBe('(c) 2026 Zoë Name')
    expect(info['EXIF:GPSLatitude']).toBeCloseTo(16.5004, 7)
    expect(info['EXIF:GPSLatitudeRef']).toBe('S')
    expect(info['EXIF:GPSLongitude']).toBeCloseTo(151.7415, 7)
    expect(info['EXIF:GPSLongitudeRef']).toBe('W')
  })

  it.runIf(hasExiftool())('passes validation for new EXIF', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photoloft-'))
    const file = join(dir, 'out.jpg')
    const meta = { copyright: '(c) Me', location: PLACE }
    const options = { ...OPTIONS, takenAt: '2026-05-31T15:31:00', meta }
    const app1 = exportExif(fixture('plain.jpg'), options)!
    writeFileSync(file, insertSegment(fixture('plain.jpg'), app1))

    const args = ['-j', '-a', '-n', '-G', '-All', '-validate', '-warning',
      file]
    const [info] = JSON.parse(execFileSync('exiftool', args).toString())
    expect(info['ExifTool:Validate']).toBe('0 0 0')
    expect(info['ExifTool:Warning']).toBeUndefined()
    expect(info['EXIF:Copyright']).toBe('(c) Me')
    expect(info['EXIF:DateTimeOriginal']).toBe('2026:05:31 15:31:00')
  })
})

describe('cameraLocation', () => {
  it('reads the location the camera recorded', () => {
    const place = cameraLocation(fixture('exif-mm.jpg'))!
    expect(place.lat).toBeCloseTo(41.9, 9)
    expect(place.lon).toBeCloseTo(12.5, 9)
    expect(cameraLocation(fixture('exif-ii.jpg'))!.lon).toBeCloseTo(12.5, 9)
  })

  it('needs only the start of a file', () => {
    const bytes = fixture('exif-mm.jpg')
    const app1 = 2 + 18
    const end = app1 + 2 + ((bytes[app1 + 2] << 8) | bytes[app1 + 3])
    expect(bytes[app1 + 1]).toBe(0xe1)
    expect(cameraLocation(bytes.subarray(0, end + 3))!.lat).
      toBeCloseTo(41.9, 9)
  })

  it('returns null without a usable location', () => {
    expect(cameraLocation(fixture('plain.jpg'))).toBeNull()
    expect(cameraLocation(fixture('zero-date.jpg'))).toBeNull()
    expect(cameraLocation(fixture('not-a-jpeg.png'))).toBeNull()

    const nowhere = withMeta(fixture('plain.jpg'), {
      location: { lat: 0, lon: 0 }
    })
    expect(cameraLocation(nowhere)).toBeNull()
  })
})

describe('insertSegment', () => {
  it('places the segment after SOI and any JFIF header', () => {
    const jfif = [0xff, 0xe0, 0, 4, 1, 2]
    const jpeg = new Uint8Array([0xff, 0xd8, ...jfif, 0xff, 0xd9])
    const out = insertSegment(jpeg, new Uint8Array([0xff, 0xe1, 0, 2]))
    expect([...out]).toEqual([
      0xff, 0xd8, ...jfif, 0xff, 0xe1, 0, 2, 0xff, 0xd9
    ])
  })
})
