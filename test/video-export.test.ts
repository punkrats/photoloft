import { describe, expect, it } from 'vitest'
import type { Photo } from '../src/library'
import { NEUTRAL_EDIT, type Edit } from '../src/schema'
import { settingsHeader, videoSettings } from '../src/video-export'

function video(edit: Partial<Edit> = {}): Photo {
  return {
    id: 'v',
    name: 'VID.mp4',
    takenAt: null,
    importedAt: '',
    width: 320,
    height: 240,
    edit: { ...NEUTRAL_EDIT, ...edit },
    trashedAt: null,
    starred: false,
    bytes: 1,
    video: { duration: 2, ext: 'mp4' },
    meta: {}
  }
}

const SD = { videoSide: 720, stripGps: true } as const

describe('videoSettings', () => {
  it('sends the whole frame for an unedited video', () => {
    expect(videoSettings(video(), SD)).toEqual({
      rotate: 0,
      flip: false,
      angle: 0,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      shortSide: 720,
      crf: 20,
      creationTime: null,
      stripGps: true,
      meta: {},
      trim: null
    })
  })

  it('sends the trim of a trimmed clip', () => {
    const trim = { start: 0.4, end: 1.6 }
    const clip = { duration: 2, ext: 'mp4', trim } as const
    const photo: Photo = { ...video(), video: clip }
    expect(videoSettings(photo, SD).trim).toEqual(trim)
  })

  it('sends the capture time as UTC for the file', () => {
    const photo = { ...video(), takenAt: '2026-05-31T15:31:00' }
    const expected = new Date('2026-05-31T15:31:00').toISOString()
    expect(videoSettings(photo, SD).creationTime).toBe(expected)
  })

  it('gives the crop relative to the straightened frame', () => {
    const s = videoSettings(video({ angle: 10 }), { ...SD, videoSide: 1080 })
    expect(s.angle).toBe(10)
    expect(s.crop.x).toBeGreaterThan(0)
    expect(s.crop.x + s.crop.w).toBeLessThanOrEqual(1)
    expect(s.crop.x + s.crop.w / 2).toBeCloseTo(0.5, 5)
  })

  it('passes quarter turns and flips through', () => {
    const s = videoSettings(video({ rotate: 90, flip: true }), {
      videoSide: 0, stripGps: false
    })
    expect([s.rotate, s.flip, s.shortSide]).toEqual([90, true, 0])
    expect(s.stripGps).toBe(false)
  })

  it('passes the info through, a removed location as null', () => {
    const meta = { title: 'Matira', keywords: ['beach'], location: null }
    const s = videoSettings({ ...video(), meta }, SD)
    expect(s.meta).toEqual(meta)
  })
})

describe('settingsHeader', () => {
  it('escapes every character outside ASCII, so headers carry it', () => {
    const meta = { title: 'Café Ōtautahi 🌴', author: 'Zoë' }
    const header = settingsHeader({ ...videoSettings(video(), SD), meta })
    expect(header).toMatch(/^[\x20-\x7e]+$/)
    expect(header).toContain('Caf\\u00e9')
    expect(JSON.parse(header).meta).toEqual(meta)
  })
})
