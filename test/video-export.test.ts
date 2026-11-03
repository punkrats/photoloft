import { describe, expect, it } from 'vitest'
import type { Photo } from '../src/library'
import { NEUTRAL_EDIT, type Edit } from '../src/schema'
import { videoSettings } from '../src/video-export'

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
    video: { duration: 2, ext: 'mp4' }
  }
}

describe('videoSettings', () => {
  it('sends the whole frame for an unedited video', () => {
    expect(videoSettings(video(), 720)).toEqual({
      rotate: 0,
      flip: false,
      angle: 0,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      shortSide: 720,
      crf: 20,
      creationTime: null
    })
  })

  it('sends the capture time as UTC for the file', () => {
    const photo = { ...video(), takenAt: '2026-05-31T15:31:00' }
    const expected = new Date('2026-05-31T15:31:00').toISOString()
    expect(videoSettings(photo, 720).creationTime).toBe(expected)
  })

  it('gives the crop relative to the straightened frame', () => {
    const s = videoSettings(video({ angle: 10 }), 1080)
    expect(s.angle).toBe(10)
    expect(s.crop.x).toBeGreaterThan(0)
    expect(s.crop.x + s.crop.w).toBeLessThanOrEqual(1)
    expect(s.crop.x + s.crop.w / 2).toBeCloseTo(0.5, 5)
  })

  it('passes quarter turns and flips through', () => {
    const s = videoSettings(video({ rotate: 90, flip: true }), 0)
    expect([s.rotate, s.flip, s.shortSide]).toEqual([90, true, 0])
  })
})
