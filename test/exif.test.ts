import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exifTags, exportExif, insertSegment, jpegInfo } from '../src/exif'

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))

const OPTIONS = { width: 100, height: 80, stripGps: true, takenAt: null }

function exported(name: string, stripGps = true) {
  const app1 = exportExif(fixture(name), { ...OPTIONS, stripGps })!
  return insertSegment(fixture('plain.jpg'), app1)
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
    const dir = mkdtempSync(join(tmpdir(), 'lightbox-'))
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
