import { describe, expect, it } from 'vitest'
import { encodeWithin } from '../src/limit'

// Fake encoder: bytes grow with area and quality.
function fake() {
  const calls: [number, number][] = []
  const encode = async (scale: number, quality: number) => {
    calls.push([scale, quality])
    return { size: 1_000_000 * scale * scale * quality }
  }
  return { calls, encode }
}

describe('encodeWithin', () => {
  it('encodes once without a limit', async () => {
    const { calls, encode } = fake()
    const out = await encodeWithin(encode, 0.9, null)
    expect(calls).toEqual([[1, 0.9]])
    expect(out).toMatchObject({ scale: 1, quality: 0.9, fits: true })
  })

  it('encodes once when the first try fits', async () => {
    const { calls, encode } = fake()
    await encodeWithin(encode, 0.9, 2_000_000)
    expect(calls).toHaveLength(1)
  })

  it('lowers quality before size', async () => {
    const { encode } = fake()
    const out = await encodeWithin(encode, 0.9, 600_000)
    expect(out.scale).toBe(1)
    expect(out.quality).toBeGreaterThan(0.58)
    expect(out.quality).toBeLessThanOrEqual(0.6)
    expect(out.result.size).toBeLessThanOrEqual(600_000)
  })

  it('shrinks when even the lowest quality is too big', async () => {
    const { encode } = fake()
    const out = await encodeWithin(encode, 0.9, 200_000)
    expect(out.fits).toBe(true)
    expect(out.scale).toBeLessThan(1)
    expect(out.result.size).toBeLessThanOrEqual(200_000)
    expect(out.result.size).toBeGreaterThan(180_000)
  })

  it('counts the metadata overhead', async () => {
    const { encode } = fake()
    const out = await encodeWithin(encode, 0.9, 600_000, 100_000)
    expect(out.result.size).toBeLessThanOrEqual(500_000)
  })

  it('converges when a fixed header dominates the file size', async () => {

    // Fitted to Chromium's output for a 200x150 gradient: about 760
    // bytes of headers that no amount of shrinking removes.
    const encode = async (scale: number, quality: number) => {
      return { size: 760 + 1080 * quality * scale ** 1.3 }
    }
    const out = await encodeWithin(encode, 0.9, 940)
    expect(out.fits).toBe(true)
    expect(out.result.size).toBeLessThanOrEqual(940)
  })

  it('reports when nothing fits and stays bounded', async () => {
    const { calls, encode } = fake()
    const out = await encodeWithin(encode, 0.9, 10)
    expect(out.fits).toBe(false)
    expect(calls.length).toBeLessThan(30)
  })
})
