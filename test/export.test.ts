import { describe, expect, it } from 'vitest'
import { settingsOf } from '../src/export'
import type { ExportForm } from '../src/state'

const FORM: ExportForm = {
  albumIds: ['a'],
  name: 'Trip',
  start: 1,
  naming: 'album',
  size: 'original',
  customSize: 2048,
  limit: 'none',
  customLimit: 1,
  quality: 90,
  stripGps: true,
  videoSide: '720',
  videoEncoding: 'quality',
  videoCrf: 20,
  videoBitrate: 8,
  videoTwoPass: false,
  folder: null,
  picked: null
}

describe('settingsOf', () => {
  it('takes the video encoding chosen', () => {
    const form: ExportForm = {
      ...FORM, videoEncoding: 'bitrate', videoBitrate: 2.5, videoTwoPass: true
    }
    expect(settingsOf(form)).toMatchObject({
      videoEncoding: 'bitrate',
      videoCrf: 20,
      videoBitrate: 2.5,
      videoTwoPass: true
    })
  })

  it('brings a typed CRF into the range of the slider', () => {
    expect(settingsOf({ ...FORM, videoCrf: 40 }).videoCrf).toBe(32)
    expect(settingsOf({ ...FORM, videoCrf: 9.6 }).videoCrf).toBe(14)
    expect(settingsOf({ ...FORM, videoCrf: 23.4 }).videoCrf).toBe(23)
  })

  it('brings a typed bitrate into range, an empty one to the default', () => {
    const bitrate = (videoBitrate: number) =>
      settingsOf({ ...FORM, videoBitrate }).videoBitrate
    expect(bitrate(0)).toBe(8)
    expect(bitrate(-2)).toBe(8)
    expect(bitrate(0.01)).toBe(0.1)
    expect(bitrate(500)).toBe(100)
    expect(bitrate(12.5)).toBe(12.5)
  })
})
