import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Photo } from '../src/library'
import { NEUTRAL_EDIT, type Edit } from '../src/schema'
import {
  exportVideo, settingsHeader, videoSettings
} from '../src/video-export'

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

const SD = {
  videoSide: 720,
  stripGps: true,
  videoEncoding: 'quality',
  videoCrf: 20,
  videoBitrate: 8,
  videoTwoPass: false
} as const

describe('videoSettings', () => {
  it('sends the whole frame for an unedited video', () => {
    expect(videoSettings(video(), SD)).toEqual({
      rotate: 0,
      flip: false,
      angle: 0,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      shortSide: 720,
      rate: { crf: 20 },
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
    const choices = { ...SD, videoSide: 0, stripGps: false } as const
    const s = videoSettings(video({ rotate: 90, flip: true }), choices)
    expect([s.rotate, s.flip, s.shortSide]).toEqual([90, true, 0])
    expect(s.stripGps).toBe(false)
  })

  it('sends the constant quality chosen', () => {
    const s = videoSettings(video(), { ...SD, videoCrf: 26 })
    expect(s.rate).toEqual({ crf: 26 })
  })

  it('sends a bitrate in kbit/s with the passes chosen', () => {
    const bitrate = {
      ...SD, videoEncoding: 'bitrate', videoBitrate: 2.5
    } as const
    expect(videoSettings(video(), bitrate).rate).
      toEqual({ kbps: 2500, passes: 1 })
    const twoPass = { ...bitrate, videoTwoPass: true }
    expect(videoSettings(video(), twoPass).rate).
      toEqual({ kbps: 2500, passes: 2 })
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

// A stand-in for the Photoloft service: every status poll gets `status`.
function service(status: () => Response) {
  const calls: { url: string, method: string, token: string | null }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    const method = init.method ?? 'GET'
    calls.push({ url, method, token: headers.get('X-Photoloft-Token') })
    init.signal?.throwIfAborted()

    if (url === '/api/token') return Response.json({ token: 'secret' })
    if (url === '/api/videos') return Response.json({ job: 'j1' })
    if (method === 'DELETE') return Response.json({})
    return status()
  })
  return calls
}

describe('exportVideo', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const running = () => Response.json({ state: 'running', progress: 0.3 })
  const start = (signal: AbortSignal, onProgress = (_: number) => {}) =>
    exportVideo(video(), new Blob(), SD, signal, onProgress)

  it('stops polling on a cancel and cancels the job', async () => {
    const calls = service(running)
    const cancel = new AbortController()
    const shares: number[] = []
    const exported = start(cancel.signal, share => {
      shares.push(share)
      cancel.abort()
    })

    await expect(exported).rejects.toThrow(/abort/i)
    expect(shares).toEqual([0.3])
    const polls = calls.filter(c => c.url === '/api/videos/j1')
    expect(polls.map(c => c.method)).toEqual(['GET', 'GET', 'DELETE'])
    expect(polls.at(-1)!.token).toBe('secret')
  })

  it('uploads nothing once cancelled', async () => {
    const calls = service(running)
    const cancel = new AbortController()
    cancel.abort()
    const exported = start(cancel.signal)

    await expect(exported).rejects.toThrow(/abort/i)
    expect(calls.map(c => c.url)).toEqual(['/api/token', '/api/videos'])
  })

  it('fails when the service has lost the job', async () => {
    service(() => Response.json({ error: 'not found' }, { status: 404 }))
    const exported = start(new AbortController().signal)
    await expect(exported).rejects.
      toThrow('The Photoloft service lost the video export')
  })

  it('fails with the error of a failed job', async () => {
    service(() => Response.json({ state: 'failed', error: 'ffmpeg broke' }))
    const exported = start(new AbortController().signal)
    await expect(exported).rejects.toThrow('ffmpeg broke')
  })
})
